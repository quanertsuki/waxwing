// Durable file helpers shared by every module that keeps state on disk.
//
// The point of this module is one implementation of "never expose a
// half-written file": a unique temporary name, an atomic rename, a short retry
// for the transient Windows lock errors, and cleanup of the temporary file when
// the write fails. It also owns the one SHA-256 helper the report, grant, and
// policy hashes share.
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Windows antivirus/indexers can briefly hold a target open during rename. */
const TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

/** The one hash used for reports, grants, previews, and policy snapshots. */
export function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

/** Default file operations; injectable so failure modes are testable. */
export const DEFAULT_FILES = {
  existsSync: (...args) => fs.existsSync(...args),
  lstatSync: (...args) => fs.lstatSync(...args),
  mkdirSync: (...args) => fs.mkdirSync(...args),
  readdirSync: (...args) => fs.readdirSync(...args),
  readFileSync: (...args) => fs.readFileSync(...args),
  readlinkSync: (...args) => fs.readlinkSync(...args),
  realpathSync: (...args) => fs.realpathSync(...args),
  renameSync: (...args) => fs.renameSync(...args),
  rmSync: (...args) => fs.rmSync(...args),
  writeFileSync: (...args) => fs.writeFileSync(...args),
};

function defaultPause(attempt) {
  // Atomics.wait blocks without spinning; the delay grows linearly as before.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 * (attempt + 1));
}

function temporaryName(file) {
  return `${file}.${process.pid}.${randomUUID()}.new`;
}

/**
 * Write `text` to `file` atomically.
 *
 * The destination is only ever replaced by a rename, so a reader sees either
 * the old file or the complete new one. A transient rename error is retried;
 * a permanent one throws after the temporary file is removed.
 */
export function atomicWriteText(file, text, {
  files = DEFAULT_FILES,
  attempts = 20,
  mode = 0o666,
  pause = defaultPause,
} = {}) {
  files.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = temporaryName(file);
  files.writeFileSync(temporary, text, {mode});
  try {
    for (let attempt = 0; ; attempt += 1) {
      try {
        files.renameSync(temporary, file);
        return file;
      } catch (error) {
        if (!TRANSIENT.has(error?.code) || attempt >= attempts) throw error;
        pause(attempt);
      }
    }
  } catch (error) {
    try { files.rmSync(temporary, {force: true}); } catch {}
    throw error;
  }
}

/** Atomic JSON write; pretty-printed to keep diffs and support bundles readable. */
export function atomicWriteJson(file, value, {newline = false, ...options} = {}) {
  return atomicWriteText(file, `${JSON.stringify(value, null, 2)}${newline ? '\n' : ''}`, options);
}

/**
 * Open a replace-with-backup transaction.
 *
 * The previous file is renamed to a backup before the new content becomes
 * visible. The caller then either `commit`s (backup removed) or `rollback`s
 * (new file removed, backup restored). This is what lets a report and the task
 * record that references its hash be saved as one unit.
 */
export function beginReplace(file, content, {
  files = DEFAULT_FILES,
  digest = sha256,
} = {}) {
  files.mkdirSync(path.dirname(file), {recursive: true});
  const temporary = temporaryName(file);
  const backup = `${file}.${process.pid}.${randomUUID()}.bak`;
  const hadPrevious = files.existsSync(file);
  try {
    files.writeFileSync(temporary, content, {mode: 0o666});
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
