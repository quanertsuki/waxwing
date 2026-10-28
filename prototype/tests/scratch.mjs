// Scratch data roots for the test suites.
//
// Every run owns `tests/.tmp/data-<pid>`, so no suite can ever reach the live
// data root. A finished or killed run leaves that directory behind, and each
// new run reclaims the remains of runs that are no longer alive; without that
// `tests/.tmp` grows without bound (it held 52k files / 3 GB when this helper
// was added).
import fs from 'node:fs';
import path from 'node:path';

/** Any run still shorter than this is left alone even if its PID looks reused. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
/**
 * Every per-run scratch directory is `<suite>-<pid>`, optionally with a suffix
 * such as `data-1234-research`. Shared, PID-less directories (`budget`,
 * `plugin`) do not match and are left in place.
 */
const SCRATCH_NAME = /^(.+)-(\d+)(-[A-Za-z]+)?$/;

/** Shared scratch directory for a tests directory: `<tests>/.tmp`. */
export function scratchBase(testsDir) {
  return path.join(testsDir, '.tmp');
}

/** The scratch data root owned by this process. */
export function scratchRoot(testsDir) {
  return path.join(scratchBase(testsDir), `data-${process.pid}`);
}

/**
 * Delete scratch directories abandoned by earlier runs and return the names
 * removed. `keep` is never touched. A sibling is kept while its owning process
 * is alive and the directory is recent, so a concurrently running suite is
 * safe; the age bound also stops a recycled PID from pinning stale data
 * forever.
 */
export function pruneScratchRoots(testsDir, keep) {
  let entries;
  try {
    entries = fs.readdirSync(scratchBase(testsDir), {withFileTypes: true});
  } catch {
    return [];
  }
  const kept = path.resolve(keep);
  const removed = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const full = path.join(scratchBase(testsDir), entry.name);
    if (path.resolve(full) === kept) continue;
    const match = SCRATCH_NAME.exec(entry.name);
    if (!match) continue;
    const pid = Number.parseInt(match[2], 10);
    if (isAlive(pid) && ageMs(full) < MAX_AGE_MS) continue;
    fs.rmSync(full, {recursive: true, force: true});
    removed.push(entry.name);
  }
  return removed;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return error?.code === 'EPERM';
  }
}

function ageMs(target) {
  try {
    return Date.now() - fs.statSync(target).mtimeMs;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}
