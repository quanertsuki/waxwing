import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const DEFAULT_POLICY_FILE = 'execution-policy.md';

function shortMessage(error) {
  const text = error?.message ?? String(error);
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
}

function digestText(text) {
  return createHash('sha256').update(text).digest('hex');
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Execution-policy Module. It owns configuration interpretation, the file
 * read at round start, the bounded prompt appendix, and report provenance.
 * A missing, empty, or changed policy never blocks a task.
 */
export class ExecutionPolicy {
  constructor({
    configuration,
    baseDirectory,
    fileSystem = fs,
  } = {}) {
    this.configuration = configuration;
    this.baseDirectory = baseDirectory;
    this.fileSystem = fileSystem;
  }

  settings() {
    const value = typeof this.configuration === 'function'
      ? this.configuration()
      : this.configuration;
    if (!isPlainObject(value)) return {enabled: false, version: null, file: null};
    return {
      enabled: value.enabled === true,
      version: Number.isSafeInteger(value.version) ? value.version : null,
      file: typeof value.file === 'string' ? value.file : null,
    };
  }

  filePath() {
    const file = this.settings().file || DEFAULT_POLICY_FILE;
    return path.isAbsolute(file) ? path.resolve(file) : path.resolve(this.baseDirectory, file);
  }

  read() {
    const settings = this.settings();
    if (!settings.enabled) {
      return {
        enabled: false,
        version: settings.version,
        sha256: null,
        text: null,
        applied: false,
        warning: null,
      };
    }
    const file = this.filePath();
    try {
      const text = this.fileSystem.readFileSync(file, 'utf8');
      if (!text.trim()) {
        return {
          enabled: true,
          version: settings.version,
          sha256: null,
          text: null,
          applied: false,
          warning: `Execution policy file is empty: ${file}`,
        };
      }
      return {
        enabled: true,
        version: settings.version,
        sha256: digestText(text),
        text,
        applied: true,
        warning: null,
      };
    } catch (error) {
      return {
        enabled: true,
        version: settings.version,
        sha256: null,
        text: null,
        applied: false,
        warning: `Execution policy file is unavailable: ${shortMessage(error)}`,
      };
    }
  }

  round() {
    const policy = this.read();
    const meta = {
      enabled: policy.enabled,
      version: policy.version,
      sha256: policy.sha256,
      applied: policy.applied,
    };
    if (policy.warning) meta.warning = policy.warning;
    return {
      meta,
      text: policy.text,
    };
  }

  prompt(userPrompt, round) {
    return round.meta.applied ? `${userPrompt}\n---\n${round.text}` : userPrompt;
  }

  reportSection(task) {
    const applied = [...(task.rounds ?? [])]
      .reverse()
      .find(round => round.policy?.applied)?.policy;
    if (!applied) return '';
    // A completed round keeps its provenance even if the current policy
    // configuration is disabled or points at a different file.
    const currentSettings = this.settings();
    const policyFile = currentSettings.file ?? null;
    const filePath = policyFile
      ? (path.isAbsolute(policyFile) ? path.resolve(policyFile) : path.resolve(this.baseDirectory, policyFile))
      : this.filePath();
    const header = `\n## Execution policy\n\nVersion: ${applied.version}\nSHA-256: ${applied.sha256}\n`;
    const snapshot = task.policySnapshot &&
      task.policySnapshot.sha256 === applied.sha256 &&
      typeof task.policySnapshot.text === 'string' &&
      task.policySnapshot.text.trim()
      ? task.policySnapshot
      : null;
    if (snapshot) {
      let currentNote = '';
      try {
        const currentHash = digestText(
          this.fileSystem.readFileSync(filePath, 'utf8'),
        );
        if (currentHash !== snapshot.sha256) {
          currentNote = `Current SHA-256: ${currentHash} (policy changed after the applied round)\n`;
        }
      } catch {}
      return `${header}${currentNote ? `\n${currentNote}` : ''}\n${snapshot.text}\n`;
    }
    try {
      const text = this.fileSystem.readFileSync(filePath, 'utf8');
      if (!text.trim()) return `${header}\n(Policy text is no longer available.)\n`;
      const currentHash = digestText(text);
      const hashLines = currentHash === applied.sha256
        ? `SHA-256: ${applied.sha256}`
        : `SHA-256: ${applied.sha256}\nCurrent SHA-256: ${currentHash} (policy changed after the applied round)`;
      return `\n## Execution policy\n\nVersion: ${applied.version}\n${hashLines}\n\n${text}\n`;
    } catch (error) {
      return `${header}\n(Policy text is no longer available: ${shortMessage(error)})\n`;
    }
  }
}

export {DEFAULT_POLICY_FILE, digestText};
