// PROTOTYPE — task persistence and worker orchestration, independent of HTTP.
// The HTTP surface lives in server.mjs; tests drive this module in-process
// with an injected worker factory (forking is unavailable in some sandboxes).
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID, createHash} from 'node:crypto';
import {fork, spawn} from 'node:child_process';
import {once} from 'node:events';
import {config,HERE,ROOT,RUNS,REPORTS,RUNTIME,ensureDirs,atomicJson,cleanEnvironment,
  canonicalPath,canonicalExistingPath,isDriveRoot,sameOrDescendantPath,pathsOverlap} from './common.mjs';
import {transition} from '../src/tasks/lifecycle.mjs';
import {budgetFileFor, parseOptionalMaxTokens, resolveRoundBudget} from './budget.mjs';
import {DEFAULT_EFFORT, parseOptionalEffort, resolveRoundEffort} from './effort.mjs';
import {usageForTask,usageForList,usageForView} from '../src/usage/service.mjs';
import {
  blockReason as usageLimitBlockReason,
  decideRework,
  effectiveLimits,
  mergeLimits,
  overrideEvent,
  parseOverride,
} from '../src/usage/policy.mjs';
import {loadProvider, loadProviders} from '../src/providers/registry.mjs';
import {Runtime, DEFAULT_EXIT_TIMEOUT_MS, FORCE_EXIT_TIMEOUT_MS, roundTimeouts} from '../src/runtime/module.mjs';
import {WorkspaceLeaseManager} from '../src/workspace/lease-manager.mjs';
import {TaskRepository} from '../src/tasks/repository.mjs';
import {TaskTransaction} from '../src/tasks/transaction.mjs';
import {ChangeNotifier} from '../src/tasks/change-notifier.mjs';
import {taskListView, taskSummaryView, workspaceLabel} from '../src/tasks/view.mjs';
import {terminateVerifiedRuntime, verifyOwnedRuntime} from '../src/runtime/identity.mjs';
import {AcceptanceService} from '../src/acceptance/service.mjs';
import {ResearchBatchService} from '../src/research/service.mjs';

const BUDGET_PLUGIN = path.join(HERE, 'budget-plugin.mjs').replaceAll('\\', '/');

// Default responses are communication-sized summaries. Full instructions and
// results stay in task.json and the exported report; callers opt into pages of
// the raw result or the complete record with status view=result|history.
const SUMMARY_LIMIT = 120;
const ERROR_LIMIT = 240;
const PREVIEW_LIMIT = 400;
const DEFAULT_PAGE_LIMIT = 2000;
const MAX_PAGE_LIMIT = 4000;
const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 86400;
const ACTIVE_TASK = new Set(['created', 'running', 'stopping']);
const STATUS_VIEWS = ['summary', 'result', 'history', 'usage', 'report', 'workspace', 'diff', 'log'];
const DEFAULT_POLICY_FILE = 'execution-policy.md';
const isHighSurrogate = c => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = c => c >= 0xdc00 && c <= 0xdfff;

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
/** Resolve optional per-call limits over a complete base set. */
function resolveLimitOverride(value, base) {
  return mergeLimits(value, base);
}
function effectiveUsageLimits(t) {
  return effectiveLimits(t?.usageLimits, config.usageLimits);
}
function policyConfiguration() {
  const value = config.executionPolicy;
  if (!isPlainObject(value)) return {enabled: false, version: null, file: null};
  return {
    enabled: value.enabled === true,
    version: Number.isSafeInteger(value.version) ? value.version : null,
    file: typeof value.file === 'string' ? value.file : null,
  };
}
function executionPolicyPath() {
  const file = policyConfiguration().file || DEFAULT_POLICY_FILE;
  return path.isAbsolute(file) ? path.resolve(file) : path.resolve(HERE, file);
}
/** Read the policy without ever failing a task; failures become a warning. */
function readExecutionPolicy() {
  const settings = policyConfiguration();
  if (!settings.enabled) {
    return {enabled: false, version: settings.version, sha256: null, text: null, applied: false, warning: null};
  }
  try {
    const text = fs.readFileSync(executionPolicyPath(), 'utf8');
    if (!text.trim()) {
      return {enabled: true, version: settings.version, sha256: null, text: null, applied: false,
        warning: `Execution policy file is empty: ${executionPolicyPath()}`};
    }
    return {enabled: true, version: settings.version, sha256: digestText(text), text, applied: true, warning: null};
  } catch (error) {
    return {enabled: true, version: settings.version, sha256: null, text: null, applied: false,
      warning: `Execution policy file is unavailable: ${shortMessage(error)}`};
  }
}
function policyForRound() {
  const policy = readExecutionPolicy();
  const meta = {enabled: policy.enabled, version: policy.version, sha256: policy.sha256, applied: policy.applied};
  if (policy.warning) meta.warning = policy.warning;
  return {meta, text: policy.text};
}
/** One bounded policy appendix for the exported report. */
function policyReportSection(t) {
  const applied = [...(t.rounds ?? [])].reverse().find(round => round.policy?.applied)?.policy;
  if (!applied) return '';
  const header = `\n## Execution policy\n\nVersion: ${applied.version}\nSHA-256: ${applied.sha256}\n`;
  const snapshot = t.policySnapshot && t.policySnapshot.sha256 === applied.sha256 &&
    typeof t.policySnapshot.text === 'string' && t.policySnapshot.text.trim() ? t.policySnapshot : null;
  if (snapshot) {
    let currentNote = '';
    try {
      const currentHash = digestText(fs.readFileSync(executionPolicyPath(), 'utf8'));
      if (currentHash !== snapshot.sha256) {
        currentNote = `Current SHA-256: ${currentHash} (policy changed after the applied round)\n`;
      }
    } catch {}
    return `${header}${currentNote ? `\n${currentNote}` : ''}\n${snapshot.text}\n`;
  }
  try {
    const text = fs.readFileSync(executionPolicyPath(), 'utf8');
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


/** Collapse whitespace so a bounded summary cannot grow through JSON escapes. */
function oneLine(value) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}
/**
 * Clip to at most `max` UTF-16 units without ever splitting a surrogate pair.
 * The returned text is a literal prefix (plus one ellipsis when clipped).
 */
function clip(value, max) {
  const text = typeof value === 'string' ? value : '';
  if (text.length <= max) return {text, truncated: false};
  let end = Math.max(0, max - 1);
  if (end > 0 && end < text.length && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end -= 1;
  return {text: text.slice(0, end) + '…', truncated: true};
}
function summaryText(value) {
  return clip(oneLine(value), SUMMARY_LIMIT);
}
/**
 * Slice one page of a string. Offsets are UTF-16 code-unit offsets; an offset
 * inside a surrogate pair is rejected, and page boundaries never split one.
 * Pages never exceed `limit` in code units. `nextOffset === null` marks the
 * final page.
 */
function pageOf(value, offset, limit) {
  const text = typeof value === 'string' ? value : '';
  const totalChars = text.length;
  // An offset in the middle of a surrogate pair cannot start a valid page.
  // Reject it explicitly instead of returning a lone low surrogate.
  if (offset > 0 && offset < totalChars && isLowSurrogate(text.charCodeAt(offset)) && isHighSurrogate(text.charCodeAt(offset - 1))) {
    throw new Error(`offset ${offset} splits a surrogate pair; use the previous nextOffset`);
  }
  const start = Math.min(offset, totalChars);
  let end = Math.min(start + limit, totalChars);
  if (end < totalChars && end > start) {
    if (isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
      // A pair at the boundary: shrink the page rather than emit a lone
      // surrogate. With limit=1 there is no room to shrink, so fail clearly.
      if (end - start === 1) throw new Error('limit is too small to advance over a surrogate pair; use limit >= 2');
      end -= 1;
    }
  }
  return {text: text.slice(start, end), offset: start, limit, totalChars,
    nextOffset: end < totalChars ? end : null, complete: end >= totalChars};
}
function safeOffset(value, label = 'offset') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}
function safePageLimit(value, label = 'limit') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1 || value > MAX_PAGE_LIMIT) {
    throw new Error(`${label} must be a safe integer between 1 and ${MAX_PAGE_LIMIT}`);
  }
  return value;
}
/** Parse the optional status view and pagination args, rejecting bad types. */
function statusQuery(a) {
  const view = a.view === undefined ? 'summary' : a.view;
  if (typeof view !== 'string' || !STATUS_VIEWS.includes(view)) {
    throw new Error(`view must be one of ${STATUS_VIEWS.join(', ')}`);
  }
  // Validate pagination even for summary; summary never uses it, so these
  // args can never turn the default response into the full record.
  const offset = a.offset === undefined ? 0 : safeOffset(a.offset);
  const limit = a.limit === undefined ? DEFAULT_PAGE_LIMIT : safePageLimit(a.limit);
  return {view, offset, limit};
}
function parseWaitSeconds(value) {
  if (value === undefined) return DEFAULT_WAIT_SECONDS;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
      value < 1 || value > MAX_WAIT_SECONDS) {
    throw new Error(`timeoutSeconds must be an integer between 1 and ${MAX_WAIT_SECONDS}`);
  }
  return value;
}

/**
 * Build one manager instance owning its own task/worker/authorization maps.
 * @param options - test seam.
 * @param options.forkWorker - factory returning a spawned-process-like handle for
 * a task; defaults to forking the real worker.
 * @returns the action dispatcher and lifecycle helpers.
 */
export function createManager(options = {}) {
  ensureDirs();
  const repository = new TaskRepository({runsDir: RUNS, atomicJson});
  // Reports, hashes, preview fingerprints, and human grants belong to the
  // Acceptance module. The manager only injects the data directories.
  const acceptance = new AcceptanceService({reportsDir: REPORTS, grantsDir: RUNTIME});
  const eventSequences = new Map();
  const taskChanges = new ChangeNotifier();
  const workspaceLeases = new WorkspaceLeaseManager({
    defaultMode: config.workspaceMode ?? 'auto',
    worktreeContainerName: config.worktreeContainerName
      ?? config.worktreeParentName
      ?? '.waxwing-worktrees',
  });
  const research = new ResearchBatchService({
    batchesDir: path.join(ROOT, 'research'),
    scratchRoot: config.researchRoot,
    reportsDir: REPORTS,
    atomicJson,
    createTask: input => createTask(input),
    getTask: id => repository.peek(id) ?? null,
    closeTask: id => stop(id, true),
    cancelTask: id => stop(id, false),
    waitForTaskChanges: (ids, timeoutMs) => taskChanges.wait(ids, timeoutMs),
    canCloseTask: id => {
      const rec = workers.get(id);
      return !rec || rec.phase === 'idle';
    },
  });
  let shuttingDown = false;

  const directory = id => repository.directory(id);
  const get = id => repository.get(id);
  const save = task => {
    const saved = repository.save(task);
    taskChanges.touch(task.id);
    return saved;
  };
  function fullView(t) {
    return {...t, live: workers.has(t.id), cleanupAuthorized: acceptance.hasGrant(t.id),
      dataDirectory: directory(t.id), report: path.join(REPORTS, `${t.id}.md`),
      runtime: t.runtime ?? null};
  }
  function effectiveMaxTokens(t) {
    try { return resolveRoundBudget({inherited: t.maxTokens, fallback: config.maxTokens}); }
    catch { return null; }
  }
  /** Reasoning effort is only sent to openai-chat providers that support it. */
  function supportsEffort(provider) {
    return provider?.type === 'openai-chat' && provider.supportsReasoning === true;
  }
  /** Built-in DSH SDK provider plus JSON provider files share one resolver. */
  function providerByName(name) {
    if (name === 'dsh-sdk' || name === 'dsh') {
      return {name: 'dsh-sdk', type: 'dsh-sdk', model: config.model};
    }
    return loadProvider(config.providersDir, name);
  }
  function effectiveEffort(t) {
    if (!supportsEffort(t.provider)) return null;
    try {
      return resolveRoundEffort({inherited: t.effort ?? undefined, fallback: config.defaultEffort ?? DEFAULT_EFFORT});
    } catch {
      return null;
    }
  }
  /**
   * Another task occupies this workspace when it is running/stopping or still
   * owns a runtime handle. The handle is removed only by the worker's confirmed
   * exit event, so a stopping task cannot release the workspace while its old
   * executor may still be writing files. A live awaiting_review/failed session
   * occupies it too until that runtime is closed.
   */
  function workspaceConflict(workspace, excludeId) {
    for (const x of repository.values()) {
      if (x.id === excludeId || typeof x.workspace !== 'string') continue;
      if (x.status !== 'running' && x.status !== 'stopping' && !workers.has(x.id) &&
          !x.runtime?.manualActionRequired) continue;
      if (pathsOverlap(workspace, x.workspace)) return x;
    }
    return null;
  }
  /**
   * Original rework refusals, checked before the cumulative usage limit. An
   * override can bypass only the limit, never these conditions.
   */
  function baseReworkBlockedReason(t) {
    if (shuttingDown) return 'Manager is shutting down; rework is refused';
    const rec = workers.get(t.id);
    // closed / accepted / running / stopping preconditions are the Acceptance
    // module's policy; runtime, round, and workspace reasons stay here.
    const acceptanceRefusal = acceptance.reworkRefusal(t, {closing: Boolean(rec?.closing)});
    if (acceptanceRefusal) return acceptanceRefusal;
    if (rec?.unreworkableReason) return rec.unreworkableReason;
    if (t.rounds.length >= config.maxRounds) return `Maximum ${config.maxRounds} rounds reached; create a new task for further work`;
    if (!rec && t.rounds.length > 0) {
      return `Original runtime is gone; this DSH cannot resume sessionId ${t.sessionId} in a new runtime; create a new task for follow-up work`;
    }
    const conflict = workspaceConflict(t.workspace, t.id);
    if (conflict) return `Workspace overlaps another task (${conflict.id}) with a live runtime; close it before reworking`;
    return null;
  }
  /** Original refusals first; a blocked cumulative limit is the last reason. */
  function reworkBlockedReason(t, usage = null) {
    const base = baseReworkBlockedReason(t);
    if (base) return base;
    if (usage?.limitState === 'blocked') return usageLimitBlockReason(usage);
    return null;
  }
  /** Never throws; an unavailable usage source becomes an unavailable limit state. */
  function usageSnapshot(t, options = {}) {
    try {
      return usageForTask(t, directory(t.id), options);
    } catch (error) {
      const reason = shortMessage(error);
      let limits = config.usageLimits;
      try { limits = effectiveUsageLimits(t); } catch {}
      return {
        available: false,
        statusUsage: {
          available: false,
          error: reason,
          requests: 0,
          requestsWithoutUsage: 0,
          estimatedCostCny: null,
          costComplete: false,
          internalRequests: 0,
          limits,
          limitState: 'unavailable',
          limitWarning: true,
          limitBlocked: false,
          limitsEvaluated: false,
          costLimitReliable: false,
          warnings: [`Usage data is unavailable: ${reason}`],
        },
        usageRounds: [],
        listUsage: {available: false, error: reason},
        computed: null,
      };
    }
  }
  function validatePrompt(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 100000) {
      throw new Error('Nonempty prompt required (max 100000 characters)');
    }
    return value;
  }
  /** Resolve and validate a workspace before any task directory is created. */
  function resolveWorkspace(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('Workspace path required');
    const resolved = path.resolve(value);
    let real;
    try { real = fs.realpathSync(resolved); }
    catch { throw new Error(`Workspace does not exist or is inaccessible: ${value}`); }
    let stat;
    try { stat = fs.statSync(real); }
    catch { throw new Error(`Workspace is inaccessible: ${value}`); }
    if (!stat.isDirectory()) throw new Error('Workspace must be a directory');
    if (isDriveRoot(resolved) || isDriveRoot(real)) throw new Error('Workspace must not be a drive root');
    // Compare both the lexical path and the path reached through links. This
    // rejects a junction inside managed data that points outside, and a normal
    // path outside that resolves back into managed data.
    const roots = [...new Set([canonicalPath(ROOT), canonicalExistingPath(ROOT)])];
    for (const root of roots) {
      for (const candidate of [canonicalPath(resolved), canonicalPath(real)]) {
        if (candidate === root) throw new Error('Workspace must not be the managed data root');
        if (sameOrDescendantPath(root, candidate)) throw new Error('Workspace must not contain the managed data root');
        if (sameOrDescendantPath(candidate, root)) throw new Error('Workspace must not be inside managed task data');
      }
    }
    return real;
  }
  /** Every create precondition is checked here, before any directory or record. */
  function preflightCreate(a, taskId) {
    if (shuttingDown) throw new Error('Manager is shutting down');
    const prompt = validatePrompt(a.prompt);
    // Validate limits before workspace resolution, task creation, or any write.
    const usageLimits = a.usageLimits === undefined
      ? effectiveLimits(undefined, config.usageLimits)
      : resolveLimitOverride(a.usageLimits, effectiveLimits(undefined, config.usageLimits));
    const requested = parseOptionalMaxTokens(a.maxTokens);
    const requestedEffort = parseOptionalEffort(a.effort);
    // Resolve provider: explicit name > defaultProvider > configured fallback.
    const providerName = a.provider || config.defaultProvider;
    let provider = null;
    try {
      provider = providerByName(providerName);
    } catch (error) {
      if (!a.provider && config.fallbackProvider && config.fallbackProvider !== providerName) {
        try {
          provider = providerByName(config.fallbackProvider);
        } catch (fallbackError) {
          throw new Error(`Provider "${providerName}" not found: ${error.message}; fallback "${config.fallbackProvider}" also failed: ${fallbackError.message}`);
        }
      } else {
        throw new Error(`Provider "${providerName}" not found: ${error.message}`);
      }
    }
    if (requestedEffort !== undefined && !supportsEffort(provider)) {
      throw new Error(`effort is not supported by provider "${provider.name}" (${provider.type})`);
    }
    const effort = supportsEffort(provider)
      ? resolveRoundEffort({requested: requestedEffort, fallback: config.defaultEffort ?? DEFAULT_EFFORT})
      : null;
    const workspace = resolveWorkspace(a.workspace);
    const requestedMode = a.workspaceMode ?? config.workspaceMode ?? 'auto';
    const workspacePlan = workspaceLeases.plan({
      workspace,
      mode: requestedMode,
      taskId,
    });
    return {
      prompt,
      workspace,
      workspacePlan,
      maxTokens: resolveRoundBudget({requested, fallback: config.maxTokens}),
      effort,
      usageLimits,
      provider,
    };
  }
  /**
   * A live handle is not proof that the old session is reworkable: a failed
   * IPC send or a process-level error leaves the communication state unknown.
   * Keep the handle (and therefore the workspace lock) until exit, but block
   * rework with a clear reason. Ordinary DSH round errors do not come here.
   */
  function markUntrusted(id, detail) {
    const rec = workers.get(id);
    if (rec && !rec.unreworkableReason) {
      rec.unreworkableReason = `Runtime ${detail}; the old session state is untrusted and cannot be reworked; create a new task for follow-up work`;
    }
  }
  /**
 * Record a startup failure as a failed task that names its ID. A live worker
   * handle is never discarded here: workers keeps the workspace lock until the
   * process exit is confirmed, and the error says so explicitly.
   */
  function failStart(id, error) {
    const runtimeUnconfirmed = workers.has(id);
    const message = `Task ${id} failed to start: ${error.message}${runtimeUnconfirmed ? '; runtime exit not confirmed (process may still be running)' : ''}`;
    const cur = repository.peek(id);
    if (cur) {
      const failed = cur.status === 'running' ? transition(cur, 'fail')
        : {...cur, status: 'failed', updatedAt: new Date().toISOString()};
      failed.error = message;
      try { event(failed, {kind: 'start_failed', error: error.message, runtimeUnconfirmed}); } catch {}
      try { save(failed); } catch {}
    }
    return new Error(message);
  }
  /**
   * Bounded list/status item. `withPaths` is true for status and mutation
   * responses, false for list so a large batch stays under the size target.
   */
  function compactTask(t, withPaths = false, precomputedUsage = null) {
    const summary = summaryText(t.rounds.at(-1)?.prompt ?? t.plan ?? '');
    const error = clip(oneLine(t.error ?? ''), ERROR_LIMIT);
    const last = t.rounds.at(-1);
    let usage = precomputedUsage;
    if (!usage) {
      try { usage = usageForList(t, directory(t.id)); }
      catch (e) { usage = {available: false, error: oneLine(e.message).slice(0, 240)}; }
    }
    const item = taskListView(t, {
      summary: withPaths ? null : summary,
      usage,
      runtimeHealth: t.runtimeHealth ?? t.runtime?.health ?? 'unknown',
      effort: effectiveEffort(t),
      error: t.error ? error.text : null,
    });
    item.maxTokens = effectiveMaxTokens(t);
    item.cleanupAuthorized = acceptance.hasGrant(t.id);
    item.live = workers.has(t.id);
    if (t.error && error.truncated) item.errorTruncated = true;
    if (withPaths) {
      const sourceWorkspace = t.sourceWorkspace ?? t.workspaceLease?.sourceWorkspace ?? t.workspace;
      item.workspaceMode = t.workspaceLease?.mode ?? 'legacy';
      item.workspaceLabel = workspaceLabel(item.workspaceMode);
      if (canonicalPath(sourceWorkspace) !== canonicalPath(t.workspace)) item.sourceWorkspace = sourceWorkspace;
      item.branch = t.workspaceLease?.branch ?? null;
      item.baseCommit = t.workspaceLease?.baseCommit ?? null;
      item.worktreeStatus = t.workspaceLease?.status ?? null;
      item.roundId = t.rounds.at(-1)?.roundId ?? null;
      item.manualActionRequired = Boolean(t.runtime?.manualActionRequired);
      item.runtimePhase = t.runtime?.phase ?? null;
      item.sessionId = t.sessionId;
      item.dataDirectory = directory(t.id);
      item.report = path.join(REPORTS, `${t.id}.md`);
    }
    return item;
  }
  /** Latest round's result; keep the last available output for older records. */
  function latestResultText(t) {
    const last = t.rounds.at(-1);
    if (!last) return typeof t.output === 'string' ? t.output : '';
    if (typeof last.result?.text === 'string') return last.result.text;
    // Older interrupted records may only have the top-level output. It is
    // cleared when a new round starts, so this never exposes a stale result
    // while a fresh rework is running.
    return typeof t.output === 'string' ? t.output : '';
  }
  /** Default status: bounded progress plus a short preview, never full history. */
  function statusSummary(t) {
    // One usage computation supplies both the compact item and status.usage.
    const snapshot = usageSnapshot(t);
    const base = compactTask(t, true, snapshot.listUsage);
    const last = t.rounds.at(-1);
    const resultText = latestResultText(t);
    const preview = clip(resultText, PREVIEW_LIMIT);
    const statusUsage = snapshot.statusUsage;
    if (last?.policy?.warning) {
      statusUsage.warnings = [...new Set([...(statusUsage.warnings ?? []), last.policy.warning])];
    }
    const reworkBlocked = reworkBlockedReason(t, statusUsage);
    return taskSummaryView(t, {
      listView: base,
      usageRounds: snapshot.usageRounds,
      statusUsage,
      resultPreview: preview.text,
      resultTotalChars: resultText.length,
      reworkBlockedReason: reworkBlocked,
      workspaceMode: base.workspaceMode,
      sourceWorkspace: base.sourceWorkspace,
      dataDirectory: base.dataDirectory,
      report: base.report,
      error: base.error,
    });
  }
  /** Hold one HTTP/MCP call until the task stops running or the wait expires. */
  async function waitForTask(a) {
    const timeoutSeconds = parseWaitSeconds(a.timeoutSeconds);
    const startedAt = Date.now();
    const timeoutMs = timeoutSeconds * 1000;
    for (;;) {
      const task = get(a.id);
      if (!ACTIVE_TASK.has(task.status)) {
        return {
          ...statusSummary(task),
          wait: {timedOut: false, timeoutSeconds, waitedMs: Date.now() - startedAt},
        };
      }
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        return {
          ...statusSummary(task),
          wait: {timedOut: true, timeoutSeconds, waitedMs: Date.now() - startedAt},
        };
      }
      await taskChanges.wait([task.id], remaining);
    }
  }
  /** Latest-round raw result, one paginated page at a time. */
  function resultPage(t, offset, limit) {
    const last = t.rounds.at(-1);
    const text = latestResultText(t);
    return {id: t.id, view: 'result', round: last?.number ?? null,
      finishReason: last?.result?.finishReason ?? null, ...pageOf(text, offset, limit)};
  }
  /** Complete persisted record as reconstructable JSON text, one page at a time. */
  function historyPage(t, offset, limit) {
    const text = JSON.stringify(fullView(t), null, 2);
    return {id: t.id, view: 'history', ...pageOf(text, offset, limit)};
  }
  /** Usage metrics and per-request detail as reconstructable JSON text. */
  function usagePage(t, offset, limit) {
    let payload;
    try { payload = usageForView(t, directory(t.id)); }
    catch (e) {
      const reason = oneLine(e.message).slice(0, 240);
      payload = {id: t.id, model: t.model ?? null, pricing: null,
        totals: {available: false, error: reason}, rounds: [], requests: [],
        missingUsage: [], warnings: [reason],
        scan: {eventsBytes: 0, indexedBytes: 0, bytesRead: 0, pendingBytes: 0, rebuilt: false, parseErrors: 0}};
    }
    const text = JSON.stringify(payload, null, 2);
    return {id: t.id, view: 'usage', ...pageOf(text, offset, limit)};
  }
  function workspacePage(t, offset, limit) {
    const inspected = workspaceLeases.inspect(t.workspaceLease, t.workspace);
    const runtime = t.runtime ? {
      pid: t.runtime.pid,
      startedAt: t.runtime.startedAt,
      roundId: t.runtime.roundId,
      phase: t.runtime.phase,
      health: t.runtime.health,
      lastHeartbeatAt: t.runtime.lastHeartbeatAt,
      identityVerified: t.runtime.identityVerified ?? null,
      manualActionRequired: t.runtime.manualActionRequired ?? false,
    } : null;
    const payload = {
      id: t.id,
      view: 'workspace',
      live: workers.has(t.id),
      executionWorkspace: t.workspace,
      sourceWorkspace: t.sourceWorkspace ?? inspected.sourceWorkspace,
      workspaceLease: t.workspaceLease ?? null,
      details: inspected,
      runtime,
    };
    const text = JSON.stringify(payload, null, 2);
    return {id: t.id, view: 'workspace', ...pageOf(text, offset, limit)};
  }
  function diffPage(t, offset, limit) {
    const inspected = workspaceLeases.inspect(t.workspaceLease, t.workspace);
    return {
      id: t.id,
      view: 'diff',
      branch: inspected.branch ?? null,
      baseCommit: inspected.baseCommit ?? null,
      status: inspected.status ?? '',
      ...pageOf(inspected.diff ?? '', offset, limit),
    };
  }
  function logPage(t, offset, limit) {
    const file = path.join(directory(t.id), 'runtime.log');
    let content = '';
    try {
      const bytes = fs.statSync(file).size;
      const start = Math.max(0, bytes - 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buffer = Buffer.alloc(bytes - start);
        fs.readSync(fd, buffer, 0, buffer.length, start);
        content = buffer.toString('utf8');
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') content = `(runtime log unavailable: ${shortMessage(error)})`;
    }
    return {id: t.id, view: 'log', path: file, ...pageOf(content, offset, limit)};
  }
  function reportPage(t, offset, limit) {
    const content = acceptance.content(t, {policySection: policyReportSection(t)});
    return {id: t.id, view: 'report', ...pageOf(content, offset, limit)};
  }
  function event(t, data) {
    const persisted = repository.peek(t.id);
    const previous = eventSequences.get(t.id);
    const baseline = Number.isSafeInteger(previous)
      ? previous
      : persisted?.eventSequence ?? t.eventSequence ?? 0;
    const sequence = baseline + 1;
    eventSequences.set(t.id, sequence);
    t.eventSequence = sequence;
    const currentRoundId = t.rounds?.at(-1)?.roundId;
    const record = {
      at: new Date().toISOString(),
      sequence,
      ...(currentRoundId && data.roundId === undefined ? {roundId: currentRoundId} : {}),
      ...data,
    };
    fs.appendFileSync(path.join(directory(t.id), 'events.jsonl'), `${JSON.stringify(record)}\n`);
    t.lastEventSequence = sequence;
    return record;
  }
  function restoreTasks() {
    for (const name of fs.readdirSync(RUNS)) {
      if (!/^task-[a-f0-9]{12}$/.test(name)) continue;
      const t = JSON.parse(fs.readFileSync(path.join(directory(name), 'task.json'), 'utf8'));
      t.schemaVersion = 2;
      if (!t.workspaceLease) {
        t.workspaceLease = {
          mode: 'legacy',
          status: 'retained',
          sourceWorkspace: t.workspace,
          executionWorkspace: t.workspace,
        };
        t.sourceWorkspace = t.workspace;
      }
      if (!Number.isSafeInteger(t.eventSequence)) {
        const eventsFile = path.join(directory(name), 'events.jsonl');
        try {
          const lines = fs.readFileSync(eventsFile, 'utf8').trim().split('\n').filter(Boolean);
          const last = lines.length ? JSON.parse(lines.at(-1)) : null;
          t.eventSequence = Number.isSafeInteger(last?.sequence) ? last.sequence : lines.length;
        } catch {
          t.eventSequence = 0;
        }
      }
      eventSequences.set(name, t.eventSequence);
      if (['running', 'stopping'].includes(t.status)) {
        let runtime = t.runtime;
        if (!runtime) {
          try { runtime = JSON.parse(fs.readFileSync(path.join(directory(name), 'runtime.json'), 'utf8')); } catch {}
        }
        if (runtime) {
          const verification = verifyOwnedRuntime(runtime);
          if (verification.verified) {
            try {
              terminateVerifiedRuntime(runtime);
              runtime = {
                ...runtime,
                phase: 'recovered-terminated',
                manualActionRequired: false,
                recovery: {at: new Date().toISOString(), reason: verification.reason},
              };
            } catch (error) {
              runtime = {
                ...runtime,
                phase: 'recovery-failed',
                manualActionRequired: true,
                recovery: {at: new Date().toISOString(), reason: `verified process could not be terminated: ${error.message}`},
              };
            }
          } else if (verification.alive) {
            runtime = {
              ...runtime,
              phase: 'orphaned-unverified',
              manualActionRequired: true,
              recovery: {at: new Date().toISOString(), reason: verification.reason},
            };
          } else {
            runtime = {
              ...runtime,
              phase: 'exited',
              manualActionRequired: false,
              recovery: {at: new Date().toISOString(), reason: verification.reason},
            };
          }
          t.runtime = runtime;
          if (t.workspaceLease) {
            t.workspaceLease.status = runtime.manualActionRequired ? 'locked-unverified' : 'retained';
          }
          try { atomicJson(path.join(directory(name), 'runtime.json'), runtime); } catch {}
        }
        t.status = 'failed';
        t.error = t.runtime?.manualActionRequired
          ? `Manager restarted with an unverified residual runtime (PID ${t.runtime.pid}); workspace lock retained for manual resolution`
          : 'Manager restarted; the old runtime is no longer reusable, so inspect the workspace and create a new task for follow-up work';
      }
      save(t);
      acceptance.restoreGrant(t.id);
    }
    research.restore();
  }
  function patchFor(t) {
    // No credential copying. Runtime reads the configured credential store.
    // The task-budget plugin is mounted by absolute path and reads only the
    // task's own budget file; it does not touch the DSH installation.
    const patch = [
      {id: 'credentials', config: {path: path.resolve(config.credentialsFile), watch: false}},
      {id: 'session-log-deepseek', config: {enabled: false}},
      {id: 'session-telemetry-otel', disabled: true},
      {id: 'session-title-llm', disabled: true},
      {id: 'spill-local', config: {root: path.join(directory(t.id), 'tmp', 'spill')}},
      {id: 'sdk-jsonrpc-server', config: {maxTokensAsSuccess: false}},
      // A new plugin row must be inserted; a flat {id} row would be an override
      // targeting an existing entry and would never mount.
      {insert: [
        {id: 'task-budget', name: BUDGET_PLUGIN, config: {budgetFile: budgetFileFor(directory(t.id)).replaceAll('\\', '/')}},
      ]},
    ];
    fs.writeFileSync(t.patch, JSON.stringify(patch, null, 2)); // JSON is a valid YAML patch list.
  }
  function defaultForkWorker(t, runtime = {}) {
    return fork(path.join(HERE, 'worker.mjs'), [
      `--waxwing-owner=${runtime.ownerMarker}`,
      `--waxwing-task=${t.id}`,
    ], {
      execPath: config.node, cwd: HERE, windowsHide: true,
      env: {
        ...cleanEnvironment(path.join(directory(t.id), 'tmp')),
        WAXWING_OWNER_MARKER: runtime.ownerMarker,
        WAXWING_TASK_ID: t.id,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
  }
  const forkWorker = options.forkWorker ?? defaultForkWorker;
  function runtimeFile(id) {
    return path.join(directory(id), 'runtime.json');
  }
  function persistRuntimeRecord(t, rec, extra = {}) {
    const record = {
      taskId: t.id,
      pid: rec.w.pid ?? null,
      ownerMarker: rec.ownerMarker,
      startedAt: rec.startedAt,
      roundId: rec.roundId,
      phase: rec.phase,
      health: rec.health,
      lastHeartbeatAt: rec.lastHeartbeatAt ? new Date(rec.lastHeartbeatAt).toISOString() : null,
      updatedAt: new Date().toISOString(),
      ...extra,
    };
    atomicJson(runtimeFile(t.id), record);
    t.runtime = record;
    return record;
  }
  /**
   * The Runtime module owns one round. The manager injects the effects it still
   * owns: task records, lifecycle transitions, the runtime.json projection, the
   * process fork, and the Provider-fallback handoff that only fires after a
   * release. No filesystem layout, Git, acceptance, or usage logic lives here.
   */
  const runtime = new Runtime({
    spawn: ({task, ownerMarker}) => forkWorker(task, {ownerMarker}),
    latest: id => repository.peek(id) ?? null,
    event: ({task, payload}) => event(task, payload),
    save: ({task}) => save(task),
    transition: ({task, action}) => transition(task, action),
    persist: ({task, rec, extra}) => persistRuntimeRecord(task, rec, extra),
    log: ({task, rec, chunk}) => {
      if (rec.logBytes > 1024 * 1024) return;
      rec.logBytes += chunk.length;
      // Managed credentials are never read by this manager or passed in arguments.
      fs.appendFileSync(path.join(directory(task.id), 'runtime.log'), chunk.toString().replace(/sk-[\w-]+/g, '[redacted]'));
    },
    untrusted: ({id, detail}) => markUntrusted(id, detail),
    terminal: ({task, rec, message}) => settleTerminal(task, rec, message),
    terminalMissing: ({task, rec, message}) => settleMissingTerminal(task, rec, message),
    workerBusy: ({task, rec, message}) => settleWorkerBusy(task, rec, message),
    released: ({fallback}) => handoffReleased(fallback),
    ackTimeout: ({task, rec, roundId, timeoutMs}) => settleAckTimeout(task, rec, roundId, timeoutMs),
    roundTimeout: ({rec, timeoutMs}) => stopAfterRoundTimeout(rec, timeoutMs),
  });
  /**
   * Liveness facade. A live handle keeps the workspace locked, so every caller
   * that used to read the raw handles map still reads the same truth here.
   */
  const workers = {
    has: id => runtime.has(id),
    get: id => runtime.get(id),
    keys: () => runtime.ids(),
  };
  const tasks = new TaskTransaction({
    runtime,
    repository,
    save,
    event: (task, payload) => event(task, payload),
    workspace: workspaceLeases,
    acceptance: {
      revoke: task => acceptance.revoke(task),
      report: task => acceptance.exportReport(task, {policySection: policyReportSection(task)}),
    },
    gracefulExitTimeoutMs: DEFAULT_EXIT_TIMEOUT_MS,
    forceExitTimeoutMs: FORCE_EXIT_TIMEOUT_MS,
    untrusted: (id, detail) => markUntrusted(id, detail),
    terminate: async ({rec}) => {
      if (process.platform === 'win32') {
        const kill = spawn('taskkill', ['/PID', String(rec.w.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        await once(kill, 'exit');
      } else {
        rec.w.kill('SIGKILL');
      }
    },
  });
  /** Persist a terminal result or error, applying first-round Provider fallback. */
  function settleTerminal(task, rec, message) {
    const ok = message.kind === 'result' && message.finishReason === 'completed';
    // Task-level fallback: if the first round fails and a fallback provider
    // exists, switch and retry. The retry itself is dispatched only from the
    // released handoff below, never from this terminal message.
    if (!ok && task.rounds.length === 1 && task.provider?.name !== config.fallbackProvider) {
      const fallbackName = config.fallbackProvider;
      if (fallbackName) {
        try {
          const fallbackProvider = providerByName(fallbackName);
          event(task, {kind: 'provider_fallback', from: task.provider?.name, to: fallbackName, error: message.error || message.finishReason});
          const round1 = task.rounds[0];
          round1.result = {text: message.text ?? '', finishReason: message.finishReason, error: message.error || `Provider ended with ${message.finishReason}`};
          round1.finishedAt = new Date().toISOString();
          task.provider = fallbackProvider;
          task.model = fallbackProvider.model || config.model;
          const failed = transition(task, 'fail');
          failed.error = null;
          save(failed);
          runtime.deferFallback(failed.id, {
            taskId: failed.id,
            prompt: round1.prompt,
            maxTokens: round1.maxTokens,
            effort: supportsEffort(fallbackProvider) ? round1.effort ?? null : null,
            providerName: fallbackName,
          });
          return;
        } catch (fallbackError) {
          // Fallback provider not found; proceed with the normal failure.
          event(task, {kind: 'provider_fallback_failed', error: fallbackError.message});
        }
      }
    }
    const changed = transition(task, ok ? 'finish' : 'fail');
    changed.output = message.text ?? ''; changed.finishReason = message.finishReason;
    changed.error = ok ? null : (message.error ?? `Provider ended with ${message.finishReason}`);
    changed.rounds.at(-1).result = {text: changed.output, finishReason: changed.finishReason, error: changed.error};
    changed.rounds.at(-1).finishedAt = new Date().toISOString();
    event(changed, {kind: 'round_finished', roundId: message.roundId, status: changed.status}); save(changed);
  }
  /** A release without a result or error is a protocol violation, not a success. */
  function settleMissingTerminal(task, rec, message) {
    const failed = task.status === 'running' ? transition(task, 'fail') : task;
    failed.error = `Task ${task.id}: worker released ${message.roundId} without a result or error`;
    event(failed, {kind: 'round_protocol_error', roundId: message.roundId, reason: 'missing terminal message'});
    save(failed);
  }
  /** A busy worker means its previous round never released; fail explicitly. */
  function settleWorkerBusy(task, rec, message) {
    const failed = task.status === 'running' ? transition(task, 'fail') : task;
    failed.error = `Task ${task.id}: worker_busy for ${message.roundId}; the previous round is still active`;
    event(failed, {kind: 'worker_busy', reportedRoundId: message.roundId});
    runtime.reportHealth(failed, rec, 'unhealthy', 'worker_busy');
    save(failed);
  }
  /** Deferred Provider fallback starts only after the failed round released. */
  function handoffReleased(fallback) {
    if (!fallback) return;
    const failed = repository.peek(fallback.taskId);
    if (!failed) return;
    void executeRun(failed, fallback.prompt, fallback.maxTokens, fallback.effort).catch(error => {
      const latest = repository.peek(fallback.taskId);
      if (latest && latest.status !== 'failed') {
        const failedTask = transition(latest, 'fail');
        failedTask.error = `Fallback to ${fallback.providerName} also failed: ${error.message}`;
        try { save(failedTask); } catch {}
      }
    });
  }
  /** An unacknowledged round is untrusted, but its process is deliberately kept. */
  function settleAckTimeout(task, rec, roundId, timeoutMs) {
    const failed = transition(task, 'fail');
    failed.error = `Task ${task.id}: worker did not acknowledge round ${roundId} within ${timeoutMs / 1000}s; the process was not terminated`;
    runtime.reportHealth(failed, rec, 'unhealthy', 'ack timeout');
    event(failed, {kind: 'round_ack_timeout', roundId});
    try { save(failed); } catch {}
  }
  /** A round deadline requests a stop; a failed stop must not look like a timeout. */
  function stopAfterRoundTimeout(rec, timeoutMs) {
    const id = rec.id;
    stop(id, false, `Round exceeded ${Math.round(timeoutMs / 1000)} seconds`).catch(error => {
      // A stop that cannot confirm exit leaves status=stopping and the
      // worker handle in place, so the workspace stays locked.
      const cur = repository.peek(id);
      if (cur && cur.status === 'running') {
        const failed = transition(cur, 'fail');
        failed.error = `Task ${id} timed out, but stopping it failed: ${error.message}`;
        try { save(failed); } catch {}
      }
    });
  }
  /**
   * Apply an already-validated round. The Runtime module owns the unique
   * roundId, the run -> ack -> result|error -> released ordering, the ACK,
   * heartbeat, and round timers, and the release gate. This function owns the
   * task record, the grant revocations, and the startup-failure bookkeeping.
   */
  async function executeRun(t, userPrompt, maxTokens, effort = null) {
    let current = repository.peek(t.id) ?? t;
    const active = runtime.get(current.id);
    // A terminal result is persisted immediately, but the worker still owns the
    // round until it sends `released`. Both rework and provider fallback wait at
    // this gate; neither is allowed to race the worker's busy flag.
    if (active && active.phase !== 'idle') {
      const released = await runtime.waitForRelease(current.id);
      current = repository.peek(t.id) ?? current;
      if (!released) {
        throw new Error(`Task ${t.id}: previous runtime exited before releasing its round; create a new task`);
      }
    }
    if (current.status === 'running') {
      throw new Error('Task is already running; wait for the current round to finish');
    }
    // The policy is read at round start; the recorded prompt stays the raw user
    // instruction and each round keeps the version/hash actually applied.
    const policy = policyForRound();
    const effectivePrompt = policy.meta.applied ? `${userPrompt}\n---\n${policy.text}` : userPrompt;
    const roundId = runtime.createRoundId();
    const next = tasks.beginRun(current, task => {
      task.error = null;
      task.output = null;
      task.maxTokens = maxTokens;
      task.effort = effort;
      task.runtimeHealth = 'starting';
    });
    // Keep one audit copy of the applied policy so a later file edit cannot
    // rewrite the report's historical body/hash.
    if (policy.meta.applied) {
      next.policySnapshot = {version: policy.meta.version, sha256: policy.meta.sha256, text: policy.text};
    }
    next.rounds.push({
      roundId,
      number: next.rounds.length + 1,
      prompt: userPrompt,
      startedAt: new Date().toISOString(),
      maxTokens,
      effort,
      policy: policy.meta,
    });
    save(next);
    event(next, {kind: 'round_started', roundId, number: next.rounds.length, maxTokens, effort});
    try {
      runtime.openRound(next, {
        roundId,
        prompt: effectivePrompt,
        maxTokens,
        effort,
        // Only pass budgetFile for DSH SDK providers.
        budgetFile: next.provider?.type === 'dsh-sdk' ? budgetFileFor(directory(next.id)) : null,
        timeouts: roundTimeouts(config),
      });
    } catch (error) {
      markUntrusted(next.id, 'startup/communication failure');
      throw failStart(next.id, error);
    }
    // The worker may have emitted error/exit/result synchronously inside send;
    // report the current persisted state rather than the pre-send snapshot.
    return statusSummary(repository.peek(next.id) ?? next);
  }
  async function stop(id, closed, reason) {
    const result = await tasks.stop(id, {closed, reason});
    return statusSummary(result.task);
  }
  /** Preview/deletion preconditions and the fingerprint live in the module. */
  function deletionPreview(t) {
    return acceptance.preview(t, {directory: directory(t.id), live: workers.has(t.id)});
  }
  async function createTask(a = {}) {
    // All request, budget, workspace, and occupancy checks happen before any
    // task directory or record is written. A rejected request therefore leaves
    // the task list, directories, files, and grants untouched.
    const id = `task-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const preflight = preflightCreate(a, id);
    const dir = directory(id);
    const created = tasks.create({
      taskId: id,
      request: a,
      directory: dir,
      makeDirectories: () => {
        fs.mkdirSync(dir);
        fs.mkdirSync(path.join(dir, 'home'));
        fs.mkdirSync(path.join(dir, 'tmp'));
      },
      removeDirectory: () => fs.rmSync(dir, {recursive: true, force: true}),
      preflight: {
        ...preflight,
        workspaceMode: a.workspaceMode ?? config.workspaceMode ?? 'auto',
        conflictFor: workspace => {
          const conflict = workspaceConflict(workspace);
          return conflict ? {...conflict, live: workers.has(conflict.id)} : null;
        },
      },
      buildRecord: ({lease}) => {
        const executionWorkspace = resolveWorkspace(lease.executionWorkspace);
        const t = {
          id,
          schemaVersion: 2,
          sessionId: `session-${id}`,
          workspace: executionWorkspace,
          sourceWorkspace: lease.sourceWorkspace,
          workspaceLease: lease,
          home: path.join(dir, 'home'),
          patch: path.join(dir, 'runtime.patch.json'),
          model: preflight.provider.model || config.model,
          provider: preflight.provider,
          plan: a.plan ?? a.prompt,
          criteria: a.criteria ?? 'Delegating Agent must inspect outputs and run its own checks',
          status: 'created',
          rounds: [],
          eventSequence: 0,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          acceptance: null,
          effort: preflight.effort,
          usageLimits: preflight.usageLimits,
        };
        if (a.kind === 'research' && typeof a.batchId === 'string' && typeof a.shardId === 'string') {
          t.kind = 'research';
          t.batchId = a.batchId;
          t.shardId = a.shardId;
        }
        // Only write DSH runtime patch for DSH SDK providers.
        if (preflight.provider.type === 'dsh-sdk') patchFor(t);
        return t;
      },
    });
    return executeRun(created.task, preflight.prompt, preflight.maxTokens, preflight.effort);
  }
  async function action(name, a = {}) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('Arguments must be an object');
    switch (name) {
      case 'list': return [...repository.values()].map(t => {
        const snapshot = usageSnapshot(t);
        const item = compactTask(t, false, snapshot.listUsage);
        if (snapshot.statusUsage.limitState === 'blocked') item.limitBlocked = true;
        else if (snapshot.statusUsage.limitState === 'warning' ||
          snapshot.statusUsage.limitState === 'unavailable') item.limitWarning = true;
        return item;
      });
      case 'status': {
        const t = get(a.id), q = statusQuery(a);
        if (q.view === 'summary') return statusSummary(t);
        if (q.view === 'result') return resultPage(t, q.offset, q.limit);
        if (q.view === 'usage') return usagePage(t, q.offset, q.limit);
        if (q.view === 'report') return reportPage(t, q.offset, q.limit);
        if (q.view === 'workspace') return workspacePage(t, q.offset, q.limit);
        if (q.view === 'diff') return diffPage(t, q.offset, q.limit);
        if (q.view === 'log') return logPage(t, q.offset, q.limit);
        return historyPage(t, q.offset, q.limit);
      }
      case 'wait': return waitForTask(a);
      case 'research_start': return research.start(a);
      case 'research_status': return research.status(a.id);
      case 'research_wait': return research.wait(a.id, {timeoutSeconds: a.timeoutSeconds});
      case 'research_collect': return research.collect(a.id, {offset: a.offset, limit: a.limit});
      case 'research_cancel': return research.cancel(a.id);
      case 'create': return createTask(a);
      case 'rework': {
        const t = get(a.id);
        // Strict validation happens before any state, round, budget, grant, or file change.
        const currentLimits = effectiveUsageLimits(t);
        const requestedLimits = resolveLimitOverride(a.usageLimits, currentLimits);
        const override = parseOverride(a);
        const requested = parseOptionalMaxTokens(a.maxTokens);
        const requestedEffort = parseOptionalEffort(a.effort);
        if (requestedEffort !== undefined && !supportsEffort(t.provider)) {
          throw new Error(`effort is not supported by provider "${t.provider?.name ?? 'unknown'}" (${t.provider?.type ?? 'unknown'})`);
        }
        validatePrompt(a.prompt);
        const snapshot = usageSnapshot(t, {persist: false});
        const usage = snapshot.statusUsage;
        const decision = decideRework({
          baseBlockedReason: baseReworkBlockedReason(t),
          usage,
          override,
        });
        if (!decision.allowed) throw new Error(decision.reason);
        const maxTokens = resolveRoundBudget({requested, inherited: t.maxTokens, fallback: config.maxTokens});
        const effort = supportsEffort(t.provider)
          ? resolveRoundEffort({requested: requestedEffort, inherited: t.effort ?? undefined,
            fallback: config.defaultEffort ?? DEFAULT_EFFORT})
          : null;
        const afterLimits = requestedLimits ?? currentLimits;
        if (decision.overridden) {
          t.lastLimitOverride = {at: new Date().toISOString(), reason: override.reason};
          const payload = overrideEvent({
            at: t.lastLimitOverride.at,
            reason: override.reason,
            usage,
            before: currentLimits,
            after: afterLimits,
          });
          delete payload.at;
          event(t, payload);
        }
        if (requestedLimits) t.usageLimits = requestedLimits;
        return executeRun(t, a.prompt, maxTokens, effort);
      }
      case 'cleanup_worktree': {
        const t = get(a.id);
        const result = workspaceLeases.release({task: t, live: workers.has(t.id)});
        event(t, {kind: 'worktree_cleaned', ...result});
        save(t);
        return {id: t.id, ...result};
      }
      case 'cancel': return stop(a.id, false);
      case 'close': return stop(a.id, true);
      case 'accept': {
        // Lifecycle first, then evidence: an illegal status must still report
        // "Cannot accept task in ..." exactly as before.
        const t = transition(get(a.id), 'accept');
        const accepted = acceptance.accept(t, {evidence: a.evidence, policySection: policyReportSection(t)});
        event(accepted.task, {kind: 'accepted', evidence: a.evidence});
        return statusSummary(save(accepted.task));
      }
      case 'export': {
        const t = get(a.id);
        const exported = acceptance.exportReport(t, {policySection: policyReportSection(t)});
        save(exported.task);
        return {file: exported.file, hash: exported.hash};
      }
      case 'preview_delete': return deletionPreview(get(a.id));
      case 'grant_delete': {
        // This endpoint is intentionally omitted from the MCP tool catalogue.
        // The trusted delegating party must obtain explicit human permission; the local OS account is the prototype trust boundary.
        // The module requires the complete, exact task ID before it previews.
        acceptance.assertConfirmation(a.id, a.confirmation);
        const t = get(a.id);
        return acceptance.grant(t, {
          directory: directory(t.id),
          live: workers.has(t.id),
          confirmation: a.confirmation,
        });
      }
      case 'delete': {
        // Preview, archived-report hash, grant scope, and fingerprint equality
        // are one decision inside the module; the manager only reaps records.
        const t = get(a.id);
        const deleted = acceptance.removeTask(t, {directory: directory(t.id), live: workers.has(t.id)});
        repository.delete(a.id);
        eventSequences.delete(a.id);
        return deleted;
      }
      default: throw new Error(`Unknown action: ${name}`);
    }
  }
  async function shutdown() {
    if (shuttingDown) return; shuttingDown = true;
    await Promise.allSettled([...workers.keys()].map(id => stop(id, true)));
  }
  return {action, restore: restoreTasks, shutdown};
}
