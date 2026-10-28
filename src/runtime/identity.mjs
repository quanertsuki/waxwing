import fs from 'node:fs';
import {execFileSync} from 'node:child_process';

function processExists(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the PID exists but belongs to another account. Treating that
    // as absent would release a workspace without proving the process exited.
    return error.code === 'EPERM';
  }
}

function readProcess(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    if (process.platform === 'win32') {
      const script = [
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}"`,
        'if ($p) { $p | Select-Object ProcessId, CreationDate, CommandLine | ConvertTo-Json -Compress }',
      ].join('; ');
      const text = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 5_000,
      }).trim();
      if (!text) return null;
      const value = JSON.parse(text);
      return {
        pid: value.ProcessId,
        startedAt: value.CreationDate ? new Date(value.CreationDate).toISOString() : null,
        commandLine: value.CommandLine ?? '',
      };
    }
    const commandLine = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ').trim();
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return {pid, startedAt: null, commandLine, stat};
  } catch {
    // Command-line inspection can be blocked by OS policy even when the PID is
    // alive. Keep it in the unverified state so the workspace lock is retained.
    return processExists(pid) ? {pid, startedAt: null, commandLine: null, inspectionError: true} : null;
  }
}

export function verifyOwnedRuntime(record, options = {}) {
  if (!record || typeof record !== 'object') {
    return {verified: false, alive: false, reason: 'runtime record is missing'};
  }
  const inspect = options.inspect ?? readProcess;
  let actual;
  try {
    actual = inspect(record.pid);
  } catch {
    actual = processExists(record.pid)
      ? {pid: record.pid, startedAt: null, commandLine: null, inspectionError: true}
      : null;
  }
  if (!actual) return {verified: false, alive: false, reason: 'recorded PID is not running'};
  if (typeof actual.commandLine !== 'string') {
    return {
      verified: false,
      alive: true,
      actual,
      reason: 'PID is running but its command line could not be verified',
    };
  }
  const expectedTask = `--waxwing-task=${record.taskId}`;
  const expectedOwner = `--waxwing-owner=${record.ownerMarker}`;
  const matches = actual.commandLine.includes(expectedTask) && actual.commandLine.includes(expectedOwner);
  return {
    verified: matches,
    alive: true,
    actual,
    reason: matches
      ? 'PID, task ID, and owner marker match the recorded runtime'
      : 'PID exists but task ID or owner marker does not match',
  };
}

export function terminateVerifiedRuntime(record, options = {}) {
  const initial = options.identity ?? verifyOwnedRuntime(record, options);
  if (!initial || initial.verified !== true) {
    return {...(initial ?? {}), verified: false, terminated: false};
  }
  // A PID can be reused between the recovery decision and the kill. Re-check
  // immediately before terminating and report the verdict instead of assuming
  // that a non-throwing call means the process is gone.
  const current = verifyOwnedRuntime(record, options);
  if (current.verified !== true) {
    return {
      ...current,
      terminated: false,
      reason: current.reason ?? 'runtime identity changed before termination',
    };
  }
  if (options.terminate) {
    const value = options.terminate(record);
    if (value === false || value?.terminated === false) {
      return {
        ...current,
        terminated: false,
        reason: value?.reason ?? 'termination was not confirmed',
      };
    }
    return {...current, terminated: true};
  }
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(record.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10_000,
    });
  } else {
    process.kill(record.pid, 'SIGTERM');
  }
  return {...current, terminated: true};
}
