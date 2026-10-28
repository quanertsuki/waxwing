import fs from 'node:fs';
import path from 'node:path';

const TASK_ID = /^task-[a-f0-9]{12}$/;

/**
 * Own the in-memory task index and atomic task.json persistence. Callers never
 * write task.json directly; restore is read-only until the manager explicitly
 * saves a migrated record.
 */
export class TaskRepository {
  constructor({runsDir, atomicJson}) {
    this.runsDir = path.resolve(runsDir);
    this.atomicJson = atomicJson;
    this.records = new Map();
  }

  directory(id) {
    if (!TASK_ID.test(id)) throw new Error('Invalid task ID');
    const value = path.join(this.runsDir, id);
    if (fs.existsSync(value) && fs.realpathSync(value) !== value) {
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
    this.records.set(task.id, task);
    return task;
  }

  save(task) {
    this.atomicJson(path.join(this.directory(task.id), 'task.json'), task);
    this.records.set(task.id, task);
    return task;
  }

  delete(id) {
    return this.records.delete(id);
  }

  /**
   * Load every stored task, validate its identity, and apply the legacy
   * migrations that startup owes old records. Validation happens before a
   * record enters the index, so a mismatched or corrupt file can never
   * overwrite another task.
   */
  restore() {
    if (!fs.existsSync(this.runsDir)) return [];
    const restored = [];
    for (const name of fs.readdirSync(this.runsDir)) {
      if (!TASK_ID.test(name)) continue;
      const directory = this.directory(name);
      const file = path.join(directory, 'task.json');
      const task = JSON.parse(fs.readFileSync(file, 'utf8'));
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
        task.eventSequence = lastEventSequence(path.join(directory, 'events.jsonl'));
      }
      this.records.set(name, task);
      restored.push(task);
    }
    return restored;
  }
}

function lastEventSequence(file) {
  try {
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean);
    const last = lines.length ? JSON.parse(lines.at(-1)) : null;
    return Number.isSafeInteger(last?.sequence) ? last.sequence : lines.length;
  } catch {
    return 0;
  }
}
