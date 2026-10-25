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
import {loadProvider, loadProviders} from '../src/providers/registry.mjs';
import {
  DEFAULT_ACK_TIMEOUT_MS,
  HEARTBEAT_STALE_MS,
  createRoundId,
  isRoundId,
} from '../src/runtime/protocol.mjs';
import {WorkspaceLeaseManager} from '../src/workspace/lease-manager.mjs';
import {RuntimeSupervisor} from '../src/runtime/supervisor.mjs';
import {TaskRepository} from '../src/tasks/repository.mjs';
import {terminateVerifiedRuntime, verifyOwnedRuntime} from '../src/runtime/identity.mjs';
import {previewTaskDeletion, reportContent, writeTaskReport} from '../src/acceptance/service.mjs';

const BUDGET_PLUGIN = path.join(HERE, 'budget-plugin.mjs').replaceAll('\\', '/');

// Default responses are communication-sized summaries. Full instructions and
// results stay in task.json and the exported report; callers opt into pages of
// the raw result or the complete record with status view=result|history.
const SUMMARY_LIMIT = 120;
const ERROR_LIMIT = 240;
const PREVIEW_LIMIT = 400;
const DEFAULT_PAGE_LIMIT = 2000;
const MAX_PAGE_LIMIT = 4000;
const STATUS_VIEWS = ['summary', 'result', 'history', 'usage', 'report', 'workspace', 'diff', 'log'];
const USAGE_LIMIT_FIELDS = ['enabled', 'warnCostCny', 'blockCostCny', 'warnRequests', 'blockRequests'];
const COST_LIMIT_FIELDS = ['warnCostCny', 'blockCostCny'];
const REQUEST_LIMIT_FIELDS = ['warnRequests', 'blockRequests'];
const DEFAULT_POLICY_FILE = 'execution-policy.md';
const OVERRIDE_REASON_LIMIT = 1000;
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
/**
 * Validate a whole or partial limit object. The same function protects create,
 * rework, and direct HTTP calls, so the MCP schema is not the only guard.
 */
function validateLimitObject(value, label = 'usageLimits') {
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!USAGE_LIMIT_FIELDS.includes(key)) throw new Error(`${label}.${key} is not a supported field`);
  }
  if ('enabled' in value && typeof value.enabled !== 'boolean') {
    throw new Error(`${label}.enabled must be a boolean`);
  }
  for (const key of COST_LIMIT_FIELDS) {
    if (!(key in value)) continue;
    if (typeof value[key] !== 'number' || !Number.isFinite(value[key]) || value[key] <= 0) {
      throw new Error(`${label}.${key} must be a positive finite number`);
    }
  }
  for (const key of REQUEST_LIMIT_FIELDS) {
    if (!(key in value)) continue;
    if (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || value[key] <= 0) {
      throw new Error(`${label}.${key} must be a positive safe integer`);
    }
  }
  return value;
}
/** Validate and copy a complete resolved limit set, including warn < block. */
function resolvedLimitObject(value, label = 'usageLimits') {
  validateLimitObject(value, label);
  for (const key of ['enabled', ...COST_LIMIT_FIELDS, ...REQUEST_LIMIT_FIELDS]) {
    if (!(key in value)) throw new Error(`${label}.${key} is required`);
  }
  const result = {
    enabled: value.enabled,
    warnCostCny: value.warnCostCny,
    blockCostCny: value.blockCostCny,
    warnRequests: value.warnRequests,
    blockRequests: value.blockRequests,
  };
  if (!(result.warnCostCny < result.blockCostCny)) {
    throw new Error(`${label}.warnCostCny must be less than blockCostCny`);
  }
  if (!(result.warnRequests < result.blockRequests)) {
    throw new Error(`${label}.warnRequests must be less than blockRequests`);
  }
  return result;
}
/** Resolve optional per-call limits over a complete base set. */
function resolveLimitOverride(value, base) {
  if (value === undefined) return null;
  validateLimitObject(value);
  return resolvedLimitObject({...base, ...value});
}
function effectiveUsageLimits(t) {
  const raw = isPlainObject(t?.usageLimits) ? {...config.usageLimits, ...t.usageLimits} : config.usageLimits;
  return resolvedLimitObject(raw, 'usageLimits');
}
function parseOverrideOptions(args) {
  if (args.overrideLimits !== undefined && typeof args.overrideLimits !== 'boolean') {
    throw new Error('overrideLimits must be a boolean');
  }
  if (args.overrideReason !== undefined && typeof args.overrideReason !== 'string') {
    throw new Error('overrideReason must be a string');
  }
  if (typeof args.overrideReason === 'string' && args.overrideReason.length > OVERRIDE_REASON_LIMIT) {
    throw new Error(`overrideReason must be at most ${OVERRIDE_REASON_LIMIT} characters`);
  }
  const enabled = args.overrideLimits === true;
  if (enabled && !(typeof args.overrideReason === 'string' && args.overrideReason.trim())) {
    throw new Error('overrideLimits requires a nonempty overrideReason');
  }
  return {enabled, reason: typeof args.overrideReason === 'string' ? args.overrideReason : null};
}
function usageLimitBlockReason(usage) {
  const parts = [];
  if (usage.internalRequests >= usage.limits.blockRequests) {
    parts.push(`${usage.internalRequests} internal requests >= blockRequests ${usage.limits.blockRequests}`);
  }
  if (usage.costLimitReliable && typeof usage.estimatedCostCny === 'number' &&
      usage.estimatedCostCny >= usage.limits.blockCostCny) {
    parts.push(`estimated cost ${usage.estimatedCostCny} CNY >= blockCostCny ${usage.limits.blockCostCny}`);
  }
  return `Cumulative usage limit reached (${parts.join('; ')}); rework requires overrideLimits:true with a nonempty overrideReason`;
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
  const workers = new Map(), grants = new Map();
  const eventSequences = new Map();
  const runtimeSupervisor = new RuntimeSupervisor();
  const workspaceLeases = new WorkspaceLeaseManager({
    defaultMode: config.workspaceMode ?? 'auto',
    worktreeContainerName: config.worktreeContainerName
      ?? config.worktreeParentName
      ?? '.waxwing-worktrees',
  });
  const digest = text => createHash('sha256').update(text).digest('hex');
  let shuttingDown = false;

  const directory = id => repository.directory(id);
  const get = id => repository.get(id);
  const save = task => repository.save(task);
  function fullView(t) {
    return {...t, live: workers.has(t.id), cleanupAuthorized: grants.has(t.id),
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
    if (t.status === 'closed') return 'Task is closed; create a new task for follow-up work';
    if (t.status === 'accepted') return 'Task is accepted; create a new task for follow-up work';
    if (t.status === 'running') return 'Task is running; wait for the round to finish or cancel it';
    const rec = workers.get(t.id);
    // During a normal stop the status is already "stopping" and the owned
    // runtime is closing; mention both so callers do not mistake the window for
    // a released workspace.
    if (rec?.closing) return 'Task is stopping; runtime is closing; wait for exit confirmation';
    if (t.status === 'stopping') return 'Task is stopping; wait for runtime exit confirmation';
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
      ? resolvedLimitObject(config.usageLimits)
      : resolveLimitOverride(a.usageLimits, resolvedLimitObject(config.usageLimits));
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
    const conflict = workspaceConflict(workspacePlan.executionWorkspace) ??
      (workspacePlan.mode === 'worktree' ? workspaceConflict(workspacePlan.sourceWorkspace) : null);
    if (conflict) {
      throw new Error(`Workspace is occupied by task ${conflict.id} (${conflict.status}${workers.has(conflict.id) ? ', runtime not exited' : ''}); close it before creating a new task`);
    }
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
    const item = {
      id: t.id,
      status: t.status,
      roundCount: t.rounds.length,
      live: workers.has(t.id),
      workspace: t.workspace,
      maxTokens: effectiveMaxTokens(t),
      accepted: Boolean(t.acceptance),
      cleanupAuthorized: grants.has(t.id),
      provider: t.provider?.name,
      model: t.model,
      error: t.error ? error.text : null,
      runtimeHealth: t.runtimeHealth ?? t.runtime?.health ?? 'unknown',
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      usage,
    };
    // Status has a bounded result preview; only list needs the prompt summary.
    // Keeping it out of status avoids duplicating similar text in mutation
    // responses and keeps those payloads below the communication size target.
    if (!withPaths) item.summary = summary.text;
    const effort = effectiveEffort(t);
    if (effort) item.effort = effort;
    if (summary.truncated) item.summaryTruncated = true;
    if (t.error && error.truncated) item.errorTruncated = true;
    if (last) item.lastRound = last.number;
    if (withPaths) {
      const sourceWorkspace = t.sourceWorkspace ?? t.workspaceLease?.sourceWorkspace ?? t.workspace;
      item.workspaceMode = t.workspaceLease?.mode ?? 'legacy';
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
    return {
      ...base,
      canRework: reworkBlocked === null,
      reworkBlockedReason: reworkBlocked,
      lastEvent: t.lastEvent ?? null,
      eventCount: t.eventCount ?? 0,
      runtimeReady: Boolean(t.runtimeReady),
      acceptedAt: t.acceptance?.at ?? null,
      resultPreview: preview.text,
      resultPreviewChars: preview.text.length,
      resultTotalChars: resultText.length,
      resultPreviewComplete: !preview.truncated,
      resultPreviewTruncated: preview.truncated,
      resultFinishReason: last?.result?.finishReason ?? null,
      lastRound: last ? {number: last.number, roundId: last.roundId ?? null, startedAt: last.startedAt ?? null,
        finishedAt: last.finishedAt ?? null, maxTokens: last.maxTokens ?? null,
        ...(last.effort ? {effort: last.effort} : {})} : null,
      usage: statusUsage,
      // The default summary keeps only rounds that actually recorded usage;
      // view=usage still exposes every event-only or empty round.
      usageRounds: snapshot.usageRounds.filter(round => round.requests > 0),
    };
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
    const content = reportContent(t, {policySection: policyReportSection(t)});
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
  function grantFile(id) { return path.join(RUNTIME, `${id}.grant.json`); }
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
      if (fs.existsSync(grantFile(t.id))) grants.set(t.id, JSON.parse(fs.readFileSync(grantFile(t.id), 'utf8')));
    }
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
  function clearAckTimer(rec) {
    if (rec.ackTimer) clearTimeout(rec.ackTimer);
    rec.ackTimer = null;
  }
  function clearRuntimeMonitors(rec) {
    clearAckTimer(rec);
    if (rec.timer) clearTimeout(rec.timer);
    rec.timer = null;
    if (rec.heartbeatWatch) clearInterval(rec.heartbeatWatch);
    rec.heartbeatWatch = null;
  }
  function noteIgnored(current, rec, msg, reason) {
    try {
      event(current, {
        kind: 'runtime_message_ignored',
        messageKind: msg?.kind ?? null,
        messageRoundId: msg?.roundId ?? null,
        expectedRoundId: rec.roundId,
        reason,
      });
    } catch {}
  }
  function updateRuntimeHealth(t, rec, health, detail = null) {
    if (rec.health === health) return;
    rec.health = health;
    t.runtimeHealth = health;
    persistRuntimeRecord(t, rec, detail ? {healthDetail: detail} : {});
    try {
      event(t, {kind: 'runtime_health', health, detail});
      save(t);
    } catch {}
  }
  function spawnWorker(t) {
    const ownerMarker = randomUUID();
    const w = forkWorker(t, {ownerMarker});
    const rec = {
      w,
      ownerMarker,
      startedAt: new Date().toISOString(),
      timer: null,
      ackTimer: null,
      heartbeatWatch: null,
      closing: false,
      closeError: null,
      unreworkableReason: null,
      logBytes: 0,
      roundId: null,
      phase: 'idle',
      health: 'starting',
      lastHeartbeatAt: null,
      terminalMessage: null,
      pendingFallback: null,
      releaseWaiters: [],
      rejectedRound: false,
      identityVerified: false,
    };
    workers.set(t.id, rec);
    t.runtimeHealth = rec.health;
    try { persistRuntimeRecord(t, rec); } catch {}
    for (const stream of [w.stdout, w.stderr]) stream?.on?.('data', chunk => {
      if (rec.logBytes > 1024 * 1024) return;
      rec.logBytes += chunk.length;
      // Managed credentials are never read by this manager or passed in arguments.
      fs.appendFileSync(path.join(directory(t.id), 'runtime.log'), chunk.toString().replace(/sk-[\w-]+/g, '[redacted]'));
    });
    w.on('message', msg => {
      const current = repository.peek(t.id); if (!current) return;
      if (msg.kind === 'ready') {
        current.runtimeReady = true;
        if (msg.ownerMarker && msg.ownerMarker !== rec.ownerMarker) {
          rec.unreworkableReason = 'Runtime identity marker did not match; create a new task';
          updateRuntimeHealth(current, rec, 'unhealthy', 'owner marker mismatch');
          return;
        }
        rec.identityVerified = Boolean(msg.ownerMarker === rec.ownerMarker);
        persistRuntimeRecord(current, rec, {
          workerPid: msg.pid ?? rec.w.pid ?? null,
          workerStartedAt: msg.startedAt ?? null,
          identityVerified: rec.identityVerified,
        });
        save(current);
        return;
      }
      if (msg.kind === 'worker_busy') {
        if (msg.roundId === rec.roundId) {
          rec.rejectedRound = true;
          rec.unreworkableReason = 'Worker rejected a run because its previous round was not released';
          clearAckTimer(rec);
          const failed = current.status === 'running' ? transition(current, 'fail') : current;
          failed.error = `Task ${t.id}: worker_busy for ${msg.roundId}; the previous round is still active`;
          event(failed, {kind: 'worker_busy', reportedRoundId: msg.roundId});
          updateRuntimeHealth(failed, rec, 'unhealthy', 'worker_busy');
          save(failed);
        }
        return;
      }
      if (msg.kind === 'protocol_error') {
        rec.unreworkableReason = `Worker protocol error: ${msg.error}`;
        updateRuntimeHealth(current, rec, 'unhealthy', msg.error);
        return;
      }
      if (['ack', 'heartbeat', 'event', 'result', 'error', 'released'].includes(msg.kind)) {
        if (!isRoundId(msg.roundId) || msg.roundId !== rec.roundId) {
          noteIgnored(current, rec, msg, 'roundId does not match the active round');
          return;
        }
      }
      if (msg.kind === 'ack') {
        if (rec.phase !== 'awaiting_ack' || rec.rejectedRound) {
          noteIgnored(current, rec, msg, 'ack arrived outside awaiting_ack');
          return;
        }
        clearAckTimer(rec);
        rec.phase = 'running';
        rec.lastHeartbeatAt = Date.now();
        updateRuntimeHealth(current, rec, 'healthy');
        event(current, {kind: 'round_ack', roundId: msg.roundId});
        save(current);
        return;
      }
      if (msg.kind === 'heartbeat') {
        if (rec.phase !== 'running') return;
        rec.lastHeartbeatAt = Date.now();
        if (rec.health !== 'healthy') updateRuntimeHealth(current, rec, 'healthy');
        return;
      }
      if (msg.kind === 'event') {
        if (current.status !== 'running' || !['running', 'awaiting_ack'].includes(rec.phase)) {
          noteIgnored(current, rec, msg, 'task is not accepting round events');
          return;
        }
        event(current, msg);
        const n = msg.notification;
        current.lastEvent = n.params?.event?.type ?? n.method;
        current.eventCount = (current.eventCount ?? 0) + 1;
        return;
      }
      if (msg.kind === 'close_error') rec.closeError = msg.error;
      if (['result', 'error'].includes(msg.kind)) {
        if (rec.terminalMessage) {
          noteIgnored(current, rec, msg, 'duplicate terminal message');
          return;
        }
        if (current.status !== 'running') {
          noteIgnored(current, rec, msg, 'task is not accepting a terminal message');
          return;
        }
        if (rec.phase !== 'running') {
          noteIgnored(current, rec, msg, 'terminal message arrived before ack');
          return;
        }
        clearAckTimer(rec);
        if (rec.timer) clearTimeout(rec.timer);
        rec.timer = null;
        rec.phase = 'finished';
        rec.terminalMessage = msg;
        const ok = msg.kind === 'result' && msg.finishReason === 'completed';
        // Task-level fallback: if first round fails and fallback provider exists, switch and retry
        if (!ok && current.rounds.length === 1 && current.provider?.name !== config.fallbackProvider) {
          const fallbackName = config.fallbackProvider;
          if (fallbackName) {
            try {
              const fallbackProvider = providerByName(fallbackName);
              event(current, {kind: 'provider_fallback', from: current.provider?.name, to: fallbackName, error: msg.error || msg.finishReason});
              // Mark round 1 as failed, then retry with fallback
              const round1 = current.rounds[0];
              round1.result = {text: msg.text ?? '', finishReason: msg.finishReason, error: msg.error || `Provider ended with ${msg.finishReason}`};
              round1.finishedAt = new Date().toISOString();
              current.provider = fallbackProvider;
              current.model = fallbackProvider.model || config.model;
              const failed = transition(current, 'fail');
              failed.error = null;
              save(failed);
              rec.pendingFallback = {
                taskId: failed.id,
                prompt: round1.prompt,
                maxTokens: round1.maxTokens,
                effort: supportsEffort(fallbackProvider) ? round1.effort ?? null : null,
                providerName: fallbackName,
              };
              return;
            } catch (fallbackError) {
              // Fallback provider not found, proceed with normal failure
              event(current, {kind: 'provider_fallback_failed', error: fallbackError.message});
            }
          }
        }
        const changed = transition(current, ok ? 'finish' : 'fail');
        changed.output = msg.text ?? ''; changed.finishReason = msg.finishReason;
        changed.error = ok ? null : (msg.error ?? `Provider ended with ${msg.finishReason}`);
        changed.rounds.at(-1).result = {text: changed.output, finishReason: changed.finishReason, error: changed.error};
        changed.rounds.at(-1).finishedAt = new Date().toISOString();
        event(changed, {kind: 'round_finished', roundId: msg.roundId, status: changed.status}); save(changed);
        return;
      }
      if (msg.kind === 'released') {
        if (rec.phase === 'idle' || rec.phase === 'exited') {
          noteIgnored(current, rec, msg, 'release arrived while runtime was idle');
          return;
        }
        if (!rec.terminalMessage) {
          const failed = current.status === 'running' ? transition(current, 'fail') : current;
          failed.error = `Task ${t.id}: worker released ${msg.roundId} without a result or error`;
          rec.unreworkableReason = 'Worker released a round without a terminal message';
          event(failed, {kind: 'round_protocol_error', roundId: msg.roundId, reason: 'missing terminal message'});
          save(failed);
        }
        // The protocol-error transition may have replaced this record. Re-read
        // before persisting release metadata so an older object cannot overwrite
        // the failure or reuse an earlier event sequence.
        const released = repository.peek(t.id) ?? current;
        clearRuntimeMonitors(rec);
        rec.phase = 'idle';
        rec.roundId = null;
        rec.terminalMessage = null;
        rec.rejectedRound = false;
        rec.lastHeartbeatAt = null;
        rec.health = 'idle';
        released.runtimeHealth = 'idle';
        event(released, {kind: 'round_released', roundId: msg.roundId});
        persistRuntimeRecord(released, rec);
        save(released);
        runtimeSupervisor.settleRelease(rec, true);
        const fallback = rec.pendingFallback;
        rec.pendingFallback = null;
        if (fallback) {
          const failed = repository.peek(fallback.taskId);
          if (failed) {
            void executeRun(failed, fallback.prompt, fallback.maxTokens, fallback.effort).catch(error => {
              const latest = repository.peek(fallback.taskId);
              if (latest && latest.status !== 'failed') {
                const failedTask = transition(latest, 'fail');
                failedTask.error = `Fallback to ${fallback.providerName} also failed: ${error.message}`;
                try { save(failedTask); } catch {}
              }
            });
          }
        }
        return;
      }
    });
    w.on('error', e => {
      markUntrusted(t.id, 'process error');
      const cur = repository.peek(t.id); if (!cur) return;
      const message = `Task ${t.id} worker error: ${e.message}`;
      clearRuntimeMonitors(rec);
      rec.phase = 'exited';
      runtimeSupervisor.settleRelease(rec, false);
      try { persistRuntimeRecord(cur, rec, {exitReason: message}); } catch {}
      if (cur.status === 'running') {
        const failed = transition(cur, 'fail'); failed.error = message;
        try { save(failed); } catch {}
      }
    });
    w.on('exit', code => {
      clearRuntimeMonitors(rec);
      rec.phase = 'exited';
      runtimeSupervisor.settleRelease(rec, false);
      workers.delete(t.id);
      const cur = repository.peek(t.id);
      try { if (cur) persistRuntimeRecord(cur, rec, {exitCode: code}); } catch {}
      if (cur?.status === 'running') {
        const failed = transition(cur, 'fail');
        failed.error = `Task ${t.id} worker exited (${code}); inspect runtime.log`;
        try { save(failed); } catch {}
      }
    });
    return rec;
  }
  /**
   * Apply an already-validated round. Startup failures become a persisted
   * failed task whose error names the ID; a live handle keeps the lock until
   * its exit is observed.
   */
  async function executeRun(t, userPrompt, maxTokens, effort = null) {
    let current = repository.peek(t.id) ?? t;
    let rec = workers.get(current.id);
    // A terminal result is persisted immediately, but the worker still owns the
    // round until it sends `released`. Both rework and provider fallback wait at
    // this gate; neither is allowed to race the worker's busy flag.
    if (rec && rec.phase !== 'idle') {
      const released = await runtimeSupervisor.waitForRelease(rec);
      current = repository.peek(t.id) ?? current;
      rec = workers.get(t.id);
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
    const roundId = createRoundId();
    const next = transition(current, 'run');
    // A new attempt revokes old acceptance and cleanup authorization.
    grants.delete(next.id); if (fs.existsSync(grantFile(next.id))) fs.unlinkSync(grantFile(next.id));
    next.acceptance = null; next.error = null; next.output = null;
    next.maxTokens = maxTokens;
    next.effort = effort;
    next.runtimeHealth = 'starting';
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
    try { rec = workers.get(next.id) ?? spawnWorker(next); }
    catch (error) {
      markUntrusted(next.id, 'startup/communication failure');
      throw failStart(next.id, error);
    }
    rec.roundId = roundId;
    rec.phase = 'awaiting_ack';
    rec.health = 'starting';
    rec.lastHeartbeatAt = Date.now();
    rec.terminalMessage = null;
    rec.rejectedRound = false;
    rec.pendingFallback = null;
    persistRuntimeRecord(next, rec);
    const ackSeconds = Number(config.ackTimeoutSeconds);
    const ackTimeoutMs = Number.isFinite(ackSeconds) && ackSeconds > 0
      ? ackSeconds * 1000
      : DEFAULT_ACK_TIMEOUT_MS;
    rec.ackTimer = setTimeout(() => {
      if (rec.roundId !== roundId || rec.phase !== 'awaiting_ack') return;
      rec.rejectedRound = true;
      rec.unreworkableReason = `Worker did not acknowledge round ${roundId}; the runtime state is untrusted`;
      clearAckTimer(rec);
      const latest = repository.peek(next.id);
      if (latest?.status === 'running') {
        const failed = transition(latest, 'fail');
        failed.error = `Task ${next.id}: worker did not acknowledge round ${roundId} within ${ackTimeoutMs / 1000}s; the process was not terminated`;
        updateRuntimeHealth(failed, rec, 'unhealthy', 'ack timeout');
        event(failed, {kind: 'round_ack_timeout', roundId});
        try { save(failed); } catch {}
      }
    }, ackTimeoutMs);
    rec.ackTimer.unref?.();
    const heartbeatStaleMs = Number(config.heartbeatStaleMs) > 0
      ? Number(config.heartbeatStaleMs)
      : HEARTBEAT_STALE_MS;
    const heartbeatCheckMs = Number(config.heartbeatCheckMs) > 0
      ? Number(config.heartbeatCheckMs)
      : 5_000;
    rec.heartbeatWatch = setInterval(() => {
      if (rec.roundId !== roundId || rec.phase !== 'running' || !rec.lastHeartbeatAt) return;
      if (Date.now() - rec.lastHeartbeatAt < heartbeatStaleMs) return;
      const latest = repository.peek(next.id);
      if (latest) updateRuntimeHealth(latest, rec, 'unhealthy', `heartbeat stale for ${heartbeatStaleMs}ms; process retained`);
    }, heartbeatCheckMs);
    rec.heartbeatWatch.unref?.();
    rec.timer = setTimeout(() => {
      stop(next.id, false, `Round exceeded ${config.roundTimeoutSeconds} seconds`).catch(error => {
        // A stop that cannot confirm exit leaves status=stopping and the
        // worker handle in place, so the workspace stays locked.
        const cur = repository.peek(next.id);
        if (cur && cur.status === 'running') {
          const failed = transition(cur, 'fail');
          failed.error = `Task ${next.id} timed out, but stopping it failed: ${error.message}`;
          try { save(failed); } catch {}
        }
      });
    }, config.roundTimeoutSeconds * 1000);
    rec.timer.unref?.();
    try {
      // Only pass budgetFile for DSH SDK providers
      const msg = {
        kind: 'run',
        roundId,
        task: next,
        prompt: effectivePrompt,
        maxTokens,
        effort,
        ownerMarker: rec.ownerMarker,
      };
      if (next.provider?.type === 'dsh-sdk') {
        msg.budgetFile = budgetFileFor(directory(next.id));
      }
      rec.w.send(msg);
    } catch (error) {
      clearRuntimeMonitors(rec);
      markUntrusted(next.id, 'IPC send failure');
      throw failStart(next.id, error);
    }
    // The worker may have emitted error/exit/result synchronously inside send;
    // report the current persisted state rather than the pre-send snapshot.
    return statusSummary(repository.peek(next.id) ?? next);
  }
  async function stop(id, closed, reason) {
    let t = get(id);
    if (t.status === 'closed') return statusSummary(t);
    if (t.runtime?.manualActionRequired) {
      throw new Error(`Task ${id} has an unverified residual runtime; confirm PID ${t.runtime.pid} manually before closing`);
    }
    const rec = workers.get(id);
    // A running/stopping record without an owned handle cannot prove that its
    // executor is gone; refuse to mark it closed/cancelled silently.
    if (!rec && ['running', 'stopping'].includes(t.status)) throw new Error(`Task ${id} has no owned runtime handle; exit is unconfirmed, refusing to change state`);
    const target = transition(t, closed ? 'close' : 'stop');
    if (rec) {
      if (rec.closing) throw new Error('Already stopping; refresh state');
      rec.closing = true; clearRuntimeMonitors(rec);
      t.status = 'stopping'; save(t); event(t, {kind: 'stop_requested', closed});
      try { if (rec.w.connected) rec.w.send({kind: 'close'}); }
      catch (error) {
        markUntrusted(id, 'close IPC send failure');
        rec.closeError = rec.closeError ?? `close request failed: ${error.message}`;
      }
      const graceful = await runtimeSupervisor.waitForExit(rec, 14000);
      if (!graceful) {
        // Only the worker handle owned by this manager is addressed.
        if (process.platform === 'win32') {
          const kill = spawn('taskkill', ['/PID', String(rec.w.pid), '/T', '/F'], {windowsHide: true, stdio: 'ignore'});
          await once(kill, 'exit');
        } else rec.w.kill('SIGKILL');
        const gone = await runtimeSupervisor.waitForExit(rec, 5000);
        if (!gone) throw new Error(`Task ${id}: could not confirm worker exit; data and workspace lock retained`);
      }
      // If the process is demonstrably gone but its exit event was missed,
      // release the owned handle now. Until this point the workspace lock held.
      if (runtimeSupervisor.hasExited(rec) && workers.get(id) === rec) workers.delete(id);
      if (rec.closeError) {
        t.status = 'failed'; t.error = `Task ${id} runtime cleanup failed: ${rec.closeError}`;
        save(t); throw new Error(t.error);
      }
    }
    // stop() waits for process exit, so the runtime may have persisted a
    // terminal round state while this call was waiting. Merge the final
    // lifecycle fields into the latest record instead of saving the stale
    // pre-wait snapshot.
    const latest = repository.peek(id) ?? target;
    const finalTask = {
      ...latest,
      status: target.status,
      updatedAt: new Date().toISOString(),
      error: reason ?? target.error,
    };
    if (closed) finalTask.reportHash = report(finalTask).hash;
    event(finalTask, {kind: closed ? 'closed' : 'cancelled'});
    return statusSummary(save(finalTask));
  }
  function report(t) {
    return writeTaskReport(t, {
      reportsDir: REPORTS,
      digest,
      policySection: policyReportSection(t),
    });
  }
  function deletionPreview(t) {
    return previewTaskDeletion(t, {
      directory: directory(t.id),
      reportsDir: REPORTS,
      digest,
      live: workers.has(t.id),
    });
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
      case 'create': {
        // All request, budget, workspace, and occupancy checks happen before
        // any task directory or record is written. A rejected request therefore
        // leaves the task list, directories, files, and grants untouched.
        const id = `task-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
        const preflight = preflightCreate(a, id);
        const dir = directory(id);
        fs.mkdirSync(dir); fs.mkdirSync(path.join(dir, 'home')); fs.mkdirSync(path.join(dir, 'tmp'));
        let lease = null;
        let t;
        try {
          lease = workspaceLeases.materialize(preflight.workspacePlan);
          const executionWorkspace = resolveWorkspace(lease.executionWorkspace);
          t = {
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
          // Only write DSH runtime patch for DSH SDK providers.
          if (preflight.provider.type === 'dsh-sdk') patchFor(t);
          save(t);
        } catch (error) {
          try { workspaceLeases.rollback(lease); } catch {}
          try { repository.delete(id); fs.rmSync(dir, {recursive: true, force: true}); } catch {}
          throw error;
        }
        return executeRun(t, preflight.prompt, preflight.maxTokens, preflight.effort);
      }
      case 'rework': {
        const t = get(a.id);
        // Strict validation happens before any state, round, budget, grant, or file change.
        const currentLimits = effectiveUsageLimits(t);
        const requestedLimits = resolveLimitOverride(a.usageLimits, currentLimits);
        const override = parseOverrideOptions(a);
        const requested = parseOptionalMaxTokens(a.maxTokens);
        const requestedEffort = parseOptionalEffort(a.effort);
        if (requestedEffort !== undefined && !supportsEffort(t.provider)) {
          throw new Error(`effort is not supported by provider "${t.provider?.name ?? 'unknown'}" (${t.provider?.type ?? 'unknown'})`);
        }
        validatePrompt(a.prompt);
        const original = baseReworkBlockedReason(t);
        if (original) throw new Error(original);
        const snapshot = usageSnapshot(t, {persist: false});
        const usage = snapshot.statusUsage;
        if (usage.limitState === 'blocked' && !override.enabled) {
          throw new Error(usageLimitBlockReason(usage));
        }
        const maxTokens = resolveRoundBudget({requested, inherited: t.maxTokens, fallback: config.maxTokens});
        const effort = supportsEffort(t.provider)
          ? resolveRoundEffort({requested: requestedEffort, inherited: t.effort ?? undefined,
            fallback: config.defaultEffort ?? DEFAULT_EFFORT})
          : null;
        const afterLimits = requestedLimits ?? currentLimits;
        if (override.enabled) {
          t.lastLimitOverride = {at: new Date().toISOString(), reason: override.reason};
          event(t, {kind: 'limit_override', reason: override.reason,
            usage: {internalRequests: usage.internalRequests, estimatedCostCny: usage.estimatedCostCny,
              costLimitReliable: usage.costLimitReliable, limitState: usage.limitState},
            limitsBefore: {...currentLimits}, limitsAfter: {...afterLimits}});
        }
        if (requestedLimits) t.usageLimits = requestedLimits;
        return executeRun(t, a.prompt, maxTokens, effort);
      }
      case 'cleanup_worktree': {
        const t = get(a.id);
        if (t.status !== 'closed') throw new Error('Close the task before cleaning its worktree');
        if (workers.has(t.id)) throw new Error('Runtime exit is not confirmed; worktree retained');
        const result = workspaceLeases.cleanup(t.workspaceLease);
        event(t, {kind: 'worktree_cleaned', ...result});
        save(t);
        return {id: t.id, ...result};
      }
      case 'cancel': return stop(a.id, false);
      case 'close': return stop(a.id, true);
      case 'accept': {
        const t = transition(get(a.id), 'accept');
        if (typeof a.evidence !== 'string' || !a.evidence.trim()) throw new Error('Delegating acceptance evidence required');
        t.acceptance = {evidence: a.evidence, at: new Date().toISOString()};
        const r = report(t); t.reportHash = r.hash; event(t, {kind: 'accepted', evidence: a.evidence}); return statusSummary(save(t));
      }
      case 'export': { const t = get(a.id); const r = report(t); t.reportHash = r.hash; save(t); return r; }
      case 'preview_delete': return deletionPreview(get(a.id));
      case 'grant_delete': {
        // This endpoint is intentionally omitted from the MCP tool catalogue.
        // The trusted delegating party must obtain explicit human permission; the local OS account is the prototype trust boundary.
        if (a.confirmation !== a.id) throw new Error('Exact human-confirmed task ID required');
        const preview = deletionPreview(get(a.id));
        const grant = {id: a.id, fingerprint: preview.fingerprint, at: new Date().toISOString(), scope: 'this-task-only'};
        grants.set(a.id, grant); atomicJson(grantFile(a.id), grant); return preview;
      }
      case 'delete': {
        const t = get(a.id), preview = deletionPreview(t), grant = grants.get(a.id);
        if (!grant || grant.fingerprint !== preview.fingerprint) throw new Error('No matching human cleanup authorization; retained all data');
        // Resolved exact task directory, closed runtime, no followed links, external report.
        fs.rmSync(preview.directory, {recursive: true});
        fs.unlinkSync(grantFile(a.id)); grants.delete(a.id); repository.delete(a.id);
        eventSequences.delete(a.id);
        return {deleted: a.id, preserved: preview.preserved};
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
