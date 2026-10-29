import fs from 'node:fs';
import path from 'node:path';

const TASK_ID = /^task-[a-f0-9]{12}$/;

/** Records are immutable once indexed, including nested rounds and leases. */
function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Array.isArray(value) ? value : Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

/**
 * Own the in-memory task index, task.json persistence, and the event journal.
 * Callers never write task.json or events.jsonl directly:
 *
 *   * `commit(task, events)` saves the record first, then appends the events
 *     with the next monotonic sequence numbers. A failed save leaves both the
 *     file and the index untouched and appends nothing.
 *   * Every indexed record is deeply frozen. A change is a new record passed
 *     to `commit`; `peek` can never be edited in place.
 *   * One sequence counter per task, seeded from the restored record, so a
 *     restart cannot reuse or reorder a number.
 */
export class TaskRepository {
  constructor({runsDir, atomicJson, now = () => new Date().toISOString(), fs: files = fs}) {
    this.runsDir = path.resolve(runsDir);
    this.atomicJson = atomicJson;
    this.now = now;
    this.fs = files;
    this.records = new Map();
    this.sequences = new Map();
  }

  directory(id) {
    if (!TASK_ID.test(id)) throw new Error('Invalid task ID');
    const value = path.join(this.runsDir, id);
    if (this.fs.existsSync(value) && this.fs.realpathSync(value) !== value) {
      throw new Error('Linked task directory refused');
    }
    return value;
  }

  peek(id) {
    return this.records.get(id);
  }

  get(id) {
    const task = this.peek(id);
    if (!task) throw new Error('Unknown task');
    return task;
  }

  has(id) {
    return this.records.has(id);
  }

  values() {
    return this.records.values();
  }

  ids() {
    return [...this.records.keys()];
  }

  remember(task) {
    this.records.set(task.id, deepFreeze(task));
    if (Number.isSafeInteger(task.eventSequence)) {
      this.sequences.set(task.id, task.eventSequence);
    }
    return task;
  }

  save(task) {
    return this.commit(task);
  }

  /**
   * The single task write path. The record is persisted before any event so a
   * failed save can never leave an event that describes an uncommitted state.
   * Events carry the sequence number and, unless they name one, the active
   * round. An append failure is rethrown after the record is durable; the
   * counter has already advanced, so a retry never reuses a number.
   */
  commit(task, payloads = []) {
    if (!task || typeof task.id !== 'string') throw new Error('task record is required');
    const events = Array.isArray(payloads) ? payloads : [payloads];
    const base = this.sequences.get(task.id) ?? task.eventSequence ?? 0;
    const sequence = base + events.length;
    const next = deepFreeze({
      ...task,
      eventSequence: sequence,
      ...(events.length ? {lastEventSequence: sequence} : {}),
    });
    this.atomicJson(path.join(this.directory(task.id), 'task.json'), next);
    this.records.set(task.id, next);
    this.sequences.set(task.id, sequence);
    if (events.length) {
      const journal = path.join(this.directory(task.id), 'events.jsonl');
      const roundId = next.rounds?.at(-1)?.roundId;
      events.forEach((payload, index) => {
        const record = {
          at: this.now(),
          sequence: base + index + 1,
          ...(roundId && payload?.roundId === undefined ? {roundId} : {}),
          ...payload,
        };
        this.fs.appendFileSync(journal, `${JSON.stringify(record)}\n`);
      });
    }
    return next;
  }

  delete(id) {
    this.sequences.delete(id);
    return this.records.delete(id);
  }

  /**
   * Load every stored task, validate its identity, and apply the legacy
   * migrations that startup owes old records. Validation happens before a
   * record enters the index, so a mismatched or corrupt file can never
   * overwrite another task.
   */
  restore() {
    if (!this.fs.existsSync(this.runsDir)) return [];
    const restored = [];
    for (const name of this.fs.readdirSync(this.runsDir)) {
      if (!TASK_ID.test(name)) continue;
      const directory = this.directory(name);
      const file = path.join(directory, 'task.json');
      const task = JSON.parse(this.fs.readFileSync(file, 'utf8'));
      if (task.id !== name) throw new Error(`Task ID mismatch in ${file}`);
      task.schemaVersion = 2;
      if (!task.workspaceLease) {
        task.workspaceLease = {
          mode: 'legacy',
          status: 'retained',
          sourceWorkspace: task.workspace,
          executionWorkspace: task.workspace,
        };
        task.sourceWorkspace = task.workspace;
      }
      if (!Number.isSafeInteger(task.eventSequence)) {
        task.eventSequence = lastEventSequence(path.join(directory, 'events.jsonl'), this.fs);
      }
      this.records.set(name, deepFreeze(task));
      this.sequences.set(name, task.eventSequence);
      restored.push(task);
    }
    return restored;
  }
}

function lastEventSequence(file, files = fs) {
  try {
    const lines = files.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const last = lines.length ? JSON.parse(lines.at(-1)) : null;
    return Number.isSafeInteger(last?.sequence) ? last.sequence : lines.length;
  } catch {
    return 0;
  }
}
