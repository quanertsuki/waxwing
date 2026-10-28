// Acceptance Module — one deep boundary for "is the delegated work accepted,
// and may its scratch data ever be deleted".
//
// Hidden inside this module:
//   - the external report body, its file, and its SHA-256;
//   - the acceptance record (evidence + timestamp);
//   - the deletion preview manifest, its fingerprint, and the preserved set;
//   - the human grant: its persisted file, its scope, and its exact-ID
//     confirmation;
//   - every acceptance/deletion precondition (closed, live, archived report,
//     matching fingerprint, single-task scope) and the rework revocation that
//     clears an old acceptance, its report hash, and its cleanup grant.
//
// The manager keeps only compatibility orchestration: task records, lifecycle
// transitions, events, the runtime handle, and the adapter-visible action
// names. It never hashes a report, never touches a grant file, and never
// decides by itself that a deletion is allowed.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

/** Task IDs are the only path segment this module ever builds or deletes. */
const TASK_ID = /^task-[a-f0-9]{12}$/;
/** A grant authorizes exactly one task preview; any other scope is refused. */
export const GRANT_SCOPE = 'this-task-only';
export const CONFIRM_ERROR = 'Exact human-confirmed task ID required';
export const EVIDENCE_ERROR = 'Delegating acceptance evidence required';
export const CLOSED_ERROR = 'Close task and confirm runtime exit first';
export const ARCHIVE_ERROR = 'Complete archived report required before deletion';
export const GRANT_ERROR = 'No matching human cleanup authorization; retained all data';
const SCRATCH_ERROR = 'Refused deletion preview: the directory is not the task scratch directory';
const CONTAIN_ERROR = 'Refused deletion preview: the preserved path is inside the task scratch directory';
const LINK_ERROR = 'Unexpected redirected path during cleanup';

/** The one hash the report body, the preview fingerprint, and grants share. */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

const DEFAULT_FILES = {
  existsSync: (...args) => fs.existsSync(...args),
  mkdirSync: (...args) => fs.mkdirSync(...args),
  renameSync: (...args) => fs.renameSync(...args),
  rmSync: (...args) => fs.rmSync(...args),
  writeFileSync: (...args) => fs.writeFileSync(...args),
};

/**
 * Write one report without ever exposing a half-written body. The previous
 * report is kept until the caller commits, so a failed task save can restore
 * the exact bytes that existed before the attempt.
 */
function beginReportFile(file, content, digest, files = DEFAULT_FILES) {
  files.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.new`;
  const backup = `${file}.${process.pid}.bak`;
  const hadPrevious = files.existsSync(file);
  try {
    files.writeFileSync(temporary, content);
    if (hadPrevious) files.renameSync(file, backup);
    files.renameSync(temporary, file);
  } catch (error) {
    if (hadPrevious) {
      try { files.renameSync(backup, file); } catch {}
    }
    try { files.rmSync(temporary, {force: true}); } catch {}
    throw error;
  }
  return {
    file,
    content,
    hash: digest(content),
    commit() {
      if (hadPrevious) {
        try { files.rmSync(backup, {force: true}); } catch {}
      }
    },
    rollback() {
      try { files.rmSync(file, {force: true}); } catch {}
      if (hadPrevious) {
        try { files.renameSync(backup, file); } catch {}
      }
    },
  };
}

/** Compatibility helper: write and immediately commit one report. */
export function writeReportFile(file, content, {digest = sha256, files = DEFAULT_FILES} = {}) {
  const report = beginReportFile(file, content, digest, files);
  report.commit();
  return {file, hash: report.hash};
}

export function reportContent(task, {policySection = ''} = {}) {
  return `# Waxwing task ${task.id}\n\nWorkspace: ${task.workspace}\nSource workspace: ${task.sourceWorkspace ?? task.workspace}\nModel: ${task.model}\nPlan: ${task.plan}\nAcceptance criteria: ${task.criteria}\n\n` +
    task.rounds.map(round => `## Round ${round.number}\n\nRound ID: ${round.roundId ?? '(legacy)'}\n\nOutput budget: ${round.maxTokens ?? '(inherited from the task default)'}\n\nReasoning effort: ${round.effort ?? '(not applied)'}\n\nInstruction:\n${round.prompt}\n\nResult:\n${round.result?.text ?? '(interrupted)'}\n\nEnd: ${round.result?.finishReason ?? round.result?.error ?? 'interrupted'}\n`).join('\n') +
    `\n## Delegating acceptance\n\n${task.acceptance?.evidence ?? '(not accepted)'}\n\nAccepted at: ${task.acceptance?.at ?? '-'}\n` +
    policySection;
}

function samePath(left, right) {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isInside(candidate, directory) {
  const a = path.resolve(candidate);
  const b = path.resolve(directory);
  const left = process.platform === 'win32' ? a.toLowerCase() : a;
  const right = process.platform === 'win32' ? b.toLowerCase() : b;
  const prefix = right.endsWith(path.sep) ? right : `${right}${path.sep}`;
  return left.startsWith(prefix);
}

/**
 * The scratch directory is the only thing a deletion may remove, so it must be
 * the task's own directory: the ID must be well formed and the directory must
 * be named after it. A caller-supplied directory can therefore never point the
 * cleanup at a workspace, a report directory, or another task.
 */
function scratchDirectory(taskId, directory) {
  if (!TASK_ID.test(taskId ?? '')) throw new Error('Invalid task ID');
  const resolved = path.resolve(directory ?? '');
  if (path.basename(resolved) !== taskId) throw new Error(SCRATCH_ERROR);
   return resolved;
}

/** Reject a preserved path that lives inside the scratch directory. */
function assertPreservedOutside(label, candidate, scratch) {
  if (typeof candidate !== 'string' || !candidate) return;
  if (samePath(candidate, scratch) || isInside(candidate, scratch)) {
    throw new Error(`${CONTAIN_ERROR} (${label})`);
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A stored grant counts only when it names this task and this scope. A forged
 * file with another scope, another task ID, or a missing fingerprint is
 * ignored, so it can never authorize a deletion.
 */
export function isValidGrant(id, grant) {
  return isPlainObject(grant) && grant.id === id && grant.scope === GRANT_SCOPE &&
    typeof grant.fingerprint === 'string' && grant.fingerprint.length > 0 &&
    typeof grant.at === 'string';
}

/** The preview manifest: every file, its size, and every link it would remove. */
function manifestFor(directory) {
  const manifest = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, {withFileTypes: true})) {
      const nestedPath = path.join(current, entry.name);
      const stat = fs.lstatSync(nestedPath);
      if (stat.isSymbolicLink()) {
        manifest.push({
          path: path.relative(directory, nestedPath),
          type: 'link',
          target: fs.readlinkSync(nestedPath),
          bytes: 0,
        });
        continue;
      }
      // A redirected directory (junction/reparse point) could escape the task
      // directory, so the whole preview is refused instead of followed.
      if (fs.realpathSync(nestedPath) !== nestedPath) throw new Error(LINK_ERROR);
      if (stat.isDirectory()) walk(nestedPath);
      else manifest.push({path: path.relative(directory, nestedPath), bytes: stat.size});
    }
  };
  walk(directory);
  return manifest;
}

/**
 * Deletion preview: preconditions (closed status, confirmed runtime exit, an
 * archived report whose content still matches the recorded hash) plus a
 * fingerprint over the exact scratch manifest a deletion would remove.
 */
export function previewTaskDeletion(task, {directory, reportsDir, digest = sha256, live = false} = {}) {
  if (task?.status !== 'closed' || live) throw new Error(CLOSED_ERROR);
  const scratch = scratchDirectory(task.id, directory);
  const file = path.join(reportsDir, `${task.id}.md`);
  if (!task.reportHash || !fs.existsSync(file) || digest(fs.readFileSync(file, 'utf8')) !== task.reportHash) {
    throw new Error(ARCHIVE_ERROR);
  }
  // The report and the project workspace must survive the deletion; if either
  // path is inside the scratch directory the preview is refused instead.
  assertPreservedOutside('report', file, scratch);
  if (typeof task.workspace === 'string') assertPreservedOutside('workspace', task.workspace, scratch);
  const manifest = manifestFor(scratch);
  return {
    id: task.id,
    directory: scratch,
    files: manifest.length,
    bytes: manifest.reduce((total, entry) => total + entry.bytes, 0),
    preserved: [file, task.workspace, ...(task.workspaceLease?.branch ? [task.workspaceLease.branch] : [])],
    fingerprint: digest(JSON.stringify(manifest)),
  };
}

/** Compatibility wrapper for the 0.1 `writeTaskReport` call shape. */
export function writeTaskReport(task, {reportsDir, digest = sha256, policySection = ''}) {
  const content = reportContent(task, {policySection});
  const file = path.join(reportsDir, `${task.id}.md`);
  return writeReportFile(file, content, {digest});
}

function writeGrantFile(file, grant) {
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = `${file}.${process.pid}.new`;
  fs.writeFileSync(temporary, JSON.stringify(grant, null, 2), {mode: 0o600});
  try {
    fs.renameSync(temporary, file);
  } catch (error) {
    try {
      fs.rmSync(temporary, {force: true});
    } catch {}
    throw error;
  }
}

/**
 * Owns reports, hashes, deletion previews, grants, and the acceptance
 * preconditions. One instance per manager; grants are kept in memory and
 * mirrored to one 0600 file per task.
 */
export class AcceptanceService {
  constructor({
    reportsDir,
    grantsDir,
    digest = sha256,
    now = () => new Date().toISOString(),
    files = null,
  } = {}) {
    this.reportsDir = reportsDir;
    this.grantsDir = grantsDir;
    this.digest = digest;
    this.now = now;
    this.files = {...DEFAULT_FILES, ...(files ?? {})};
    this.grants = new Map();
  }

  reportPath(id) {
    return path.join(this.reportsDir, `${id}.md`);
  }

  grantPath(id) {
    return path.join(this.grantsDir, `${id}.grant.json`);
  }

  /** Report text only; status view=report renders it without writing a file. */
  content(task, {policySection = ''} = {}) {
    return reportContent(task, {policySection});
  }

  /** Open one atomic report write; the caller must commit or roll it back. */
  beginReport(task, {policySection = ''} = {}) {
    const content = reportContent(task, {policySection});
    return beginReportFile(
      this.reportPath(task.id),
      content,
      this.digest,
      this.files,
    );
  }

  /** Write the external report and return its file and hash; never mutates. */
  report(task, {policySection = ''} = {}) {
    const report = this.beginReport(task, {policySection});
    report.commit();
    return {file: report.file, hash: report.hash};
  }

  /** Validate evidence, record acceptance, write the report, stamp the hash. */
  accept(task, {evidence, policySection = ''} = {}) {
    if (typeof evidence !== 'string' || !evidence.trim()) throw new Error(EVIDENCE_ERROR);
    const accepted = {...task, acceptance: {evidence, at: this.now()}};
    const report = this.report(accepted, {policySection});
    return {task: {...accepted, reportHash: report.hash}, file: report.file, hash: report.hash};
  }

  /** Refresh the report outside an acceptance; stamps the same hash field. */
  exportReport(task, {policySection = ''} = {}) {
    const report = this.report(task, {policySection});
    return {task: {...task, reportHash: report.hash}, file: report.file, hash: report.hash};
  }

  /**
   * Persist an acceptance and its report through one module-owned sequence.
   * The caller supplies the already-validated lifecycle record and the save
   * adapter; report/hash persistence is inserted between acceptance and
   * lifecycle save so no caller can save one without the other.
   */
  acceptAndSave(task, {evidence, policySection = '', save} = {}) {
    if (typeof save !== 'function') throw new Error('save dependency is required');
    if (typeof evidence !== 'string' || !evidence.trim()) throw new Error(EVIDENCE_ERROR);
    const accepted = {...task, acceptance: {evidence, at: this.now()}};
    return this.writeReportAndSave(accepted, {policySection, save}).task;
  }

  /**
   * Persist a report and the task that carries its hash as one sequence. The
   * previous report is restored if the task save fails, so no caller can leave
   * an archived report that no record points at.
   */
  writeReportAndSave(task, {policySection = '', save} = {}) {
    if (typeof save !== 'function') throw new Error('save dependency is required');
    const report = this.beginReport(task, {policySection});
    let saved;
    try {
      saved = save({...task, reportHash: report.hash});
    } catch (error) {
      report.rollback();
      throw error;
    }
    report.commit();
    return {task: saved, file: report.file, hash: report.hash};
  }

  /** Persist a refreshed report and its new hash as one module-owned step. */
  exportAndSave(task, {policySection = '', save} = {}) {
    if (typeof save !== 'function') throw new Error('save dependency is required');
    return this.writeReportAndSave(task, {policySection, save});
  }

  /** Deletion preview; every precondition lives in previewTaskDeletion. */
  preview(task, {directory, live = false} = {}) {
    return previewTaskDeletion(task, {
      directory,
      reportsDir: this.reportsDir,
      digest: this.digest,
      live,
    });
  }

  /** A grant is honored only while it names this task, this scope, and a preview. */
  validGrant(id) {
    const grant = this.grants.get(id);
    return isValidGrant(id, grant) ? grant : null;
  }

  hasGrant(id) {
    return this.validGrant(id) !== null;
  }

  /** Load and validate one persisted grant; an invalid file is never honored. */
  restoreGrant(id) {
    let parsed = null;
    try {
      parsed = JSON.parse(fs.readFileSync(this.grantPath(id), 'utf8'));
    } catch {
      return null;
    }
    if (!isValidGrant(id, parsed)) return null;
    this.grants.set(id, parsed);
    return parsed;
  }

  /** Drop the in-memory grant and its persisted file; never throws. */
  forgetGrant(id) {
    this.grants.delete(id);
    try {
      fs.rmSync(this.grantPath(id), {force: true});
    } catch {}
  }

  /** Human authorization: the confirmation must equal the complete task ID. */
  assertConfirmation(id, confirmation) {
    if (confirmation !== id) throw new Error(CONFIRM_ERROR);
  }

  /**
   * Persist a new grant bound to the current preview fingerprint. The preview
   * is recomputed here, so a stale preview passed by a caller cannot be
   * authorized.
   */
  grant(task, {directory, live = false, confirmation} = {}) {
    this.assertConfirmation(task?.id, confirmation);
    const preview = this.preview(task, {directory, live});
    const grant = {id: task.id, fingerprint: preview.fingerprint, at: this.now(), scope: GRANT_SCOPE};
    this.grants.set(task.id, grant);
    writeGrantFile(this.grantPath(task.id), grant);
    return preview;
  }

  /**
   * Final deletion gate: the preview must reproduce the fingerprint the grant
   * was bound to. Anything else (tampered report, changed scratch manifest,
   * wrong scope, another task's grant, no grant) is refused with the same
   * error, and nothing is removed.
   */
  authorize(task, {directory, live = false} = {}) {
    const preview = this.preview(task, {directory, live});
    const grant = this.validGrant(task.id);
    if (!grant || grant.fingerprint !== preview.fingerprint) throw new Error(GRANT_ERROR);
    return {preview, grant};
  }

  /** Remove the scratch directory and its grant; the report and workspace stay. */
  removeTask(task, {directory, live = false} = {}) {
    const {preview} = this.authorize(task, {directory, live});
    this.files.rmSync(preview.directory, {recursive: true});
    this.forgetGrant(task.id);
    return {deleted: task.id, preserved: preview.preserved};
  }

  /**
   * Delete authorized scratch data, then hand the now-empty task ID to the
   * caller's index cleanup. If index removal fails after deletion, the task
   * remains indexable for manual cleanup rather than being silently forgotten.
   */
  removeTaskAndForget(task, {directory, live = false, forget} = {}) {
    const deleted = this.removeTask(task, {directory, live});
    let indexPending = false;
    if (forget !== undefined) {
      if (typeof forget !== 'function') throw new Error('forget dependency must be a function');
      try {
        forget(task.id);
      } catch {
        // The scratch data is already gone. Report the index gap instead of
        // pretending the delete failed or silently forgetting the task.
        indexPending = true;
      }
    }
    return {...deleted, indexPending};
  }

  /**
   * Rework dispatch revokes every stale acceptance artifact: the evidence
   * record, the report hash, and the cleanup grant (memory and file).
   */
  revoke(task) {
    this.forgetGrant(task.id);
    return {...task, acceptance: null, reportHash: null};
  }

  /**
   * Acceptance-side rework preconditions. The manager adds its own runtime,
   * round, workspace, and shutdown reasons around this list.
   */
  reworkRefusal(task, {closing = false} = {}) {
    if (task?.status === 'closed') return 'Task is closed; create a new task for follow-up work';
    if (task?.status === 'accepted') return 'Task is accepted; create a new task for follow-up work';
    if (task?.status === 'running') return 'Task is running; wait for the round to finish or cancel it';
    if (closing) return 'Task is stopping; runtime is closing; wait for exit confirmation';
    if (task?.status === 'stopping') return 'Task is stopping; wait for runtime exit confirmation';
    return null;
  }
}
