// PROTOTYPE — task persistence and worker orchestration, independent of HTTP.
// The HTTP surface lives in server.mjs; tests drive this module in-process
// with an injected worker factory (forking is unavailable in some sandboxes).
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fork, spawn} from 'node:child_process';
import {once} from 'node:events';
import {config,HERE,ROOT,RUNS,REPORTS,RUNTIME,ensureDirs,atomicJson,cleanEnvironment,
  canonicalPath,canonicalExistingPath,isDriveRoot,sameOrDescendantPath} from './common.mjs';
import {transition} from '../src/tasks/lifecycle.mjs';
import {budgetFileFor, resolveRoundBudget} from './budget.mjs';
import {DEFAULT_EFFORT, resolveRoundEffort} from './effort.mjs';
import {UsageModule} from '../src/usage/module.mjs';
import {ExecutionPolicy} from '../src/tasks/execution-policy.mjs';
import {capabilitiesFor, prepareTask, resolveProvider} from '../src/providers/registry.mjs';
import {Runtime, DEFAULT_EXIT_TIMEOUT_MS, FORCE_EXIT_TIMEOUT_MS, roundTimeouts} from '../src/runtime/module.mjs';
import {RuntimeSettlement} from '../src/runtime/settlement.mjs';
import {WorkspaceLeaseManager} from '../src/workspace/lease-manager.mjs';
import {TaskRepository} from '../src/tasks/repository.mjs';
import {TaskTransaction} from '../src/tasks/transaction.mjs';
import {ChangeNotifier} from '../src/tasks/change-notifier.mjs';
import {
  normalizeTaskDetail,
  taskListView,
  taskPageView,
  taskSummaryView,
  workspaceLabel,
} from '../src/tasks/view.mjs';
import {DEFAULT_PAGE_LIMIT, MAX_PAGE_LIMIT, pageOf, safeOffset, safePageLimit} from '../src/view/page.mjs';
import {terminateVerifiedRuntime, verifyOwnedRuntime} from '../src/runtime/identity.mjs';
import {AcceptanceService} from '../src/acceptance/service.mjs';
import {ResearchBatchService} from '../src/research/service.mjs';
import {TaskCommandModule} from '../src/tasks/command.mjs';
import {TaskRework} from '../src/tasks/rework.mjs';
import {validateOperation} from '../src/operations/catalogue.mjs';


// Default responses are communication-sized summaries. Full instructions and
// results stay in task.json and the exported report; callers opt into pages of
// the raw result or the complete record with status view=result|history.
const SUMMARY_LIMIT = 120;
const ERROR_LIMIT = 240;
const PREVIEW_LIMIT = 400;
const DEFAULT_WAIT_SECONDS = 30;
const MAX_WAIT_SECONDS = 86400;
const ACTIVE_TASK = new Set(['created', 'running', 'stopping']);
const STATUS_VIEWS = ['summary', 'result', 'history', 'usage', 'report', 'workspace', 'diff', 'log'];
const isHighSurrogate = c => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = c => c >= 0xdc00 && c <= 0xdfff;

function shortMessage(error) {
  const text = error?.message ?? String(error);
  return text.length > 240 ? `${text.slice(0, 239)}…` : text;
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
  const executionPolicy = new ExecutionPolicy({
    configuration: () => config.executionPolicy,
    baseDirectory: HERE,
  });
  // Reports, hashes, preview fingerprints, and human grants belong to the
  // Acceptance module. The manager only injects the data directories and the
  // policy appendix, so no close path can write a report without it.
  const acceptance = new AcceptanceService({
    reportsDir: REPORTS,
    grantsDir: RUNTIME,
    policySection: task => executionPolicy.reportSection(task),
  });
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
      return !workers.live(id) || rec.phase === 'idle';
    },
  });
  let shuttingDown = false;

  const usageModule = new UsageModule({
    configuration: {
      limits: config.usageLimits,
      providersDir: config.providersDir,
      pricingFile: path.join(HERE, 'pricing.json'),
    },
  });

  const directory = id => repository.directory(id);
  const get = id => repository.get(id);
  /** The only task write path: record and events commit together. */
  const commit = (task, events = []) => {
    const saved = repository.commit(task, events);
    taskChanges.touch(task.id);
    return saved;
  };
  const save = task => commit(task);
  function fullView(t) {
    return {...t, live: workers.live(t.id), cleanupAuthorized: acceptance.hasGrant(t.id),
      dataDirectory: directory(t.id), report: path.join(REPORTS, `${t.id}.md`),
      runtime: t.runtime ?? null};
  }
  function effectiveMaxTokens(t) {
    try { return resolveRoundBudget({inherited: t.maxTokens, fallback: config.maxTokens}); }
    catch { return null; }
  }
  /** The adapter declares whether it accepts reasoning effort. */
  function supportsEffort(provider) {
    try { return capabilitiesFor(provider).effort; } catch { return false; }
  }
  /** Built-in providers plus JSON provider files share one resolver. */
  function providerByName(name) {
    return resolveProvider(config.providersDir, name, {model: config.model});
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
    return workspaceLeases.conflictFor(workspace, [...repository.values()], {
      excludeId,
      live: id => workers.live(id),
    });
  }
  /**
   * One read-only decision for both the rework action and status summaries.
   * Runtime facts are read through this closure, so a retained handle's
   * unreworkable reason and the closing flag stay next to the handle itself.
   */
  const rework = new TaskRework({
    usage: usageModule,
    maxRounds: () => config.maxRounds,
    isShuttingDown: () => shuttingDown,
    runtimeFacts: t => {
      const rec = workers.get(t.id);
      return {
        closing: Boolean(rec?.closing),
        live: workers.live(t.id),
        unreworkableReason: rec?.unreworkableReason ?? null,
      };
    },
    workspaceConflict,
    directory: id => directory(id),
    providerSupportsEffort: supportsEffort,
    resolveBudget: resolveRoundBudget,
    resolveEffort: resolveRoundEffort,
    defaultEffort: () => config.defaultEffort ?? DEFAULT_EFFORT,
  });
  /** Never throws; an unavailable usage source becomes an unavailable limit state. */
  function usageSnapshot(t, options = {}) {
    return usageModule.snapshot(t, directory(t.id), options);
  }
  const commandModule = new TaskCommandModule({
    limitsForRequest: (task, value) => usageModule.limitsForRequest(task, value),
    canStart: () => shuttingDown ? 'Manager is shutting down' : null,
    preflight: ({request, taskId, validated}) => preflightCreate(request, taskId, validated),
  });
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
  /** Resolve workspace/provider/budget after TaskCommandModule validates the request. */
  function preflightCreate(a, taskId, validated = commandModule.validateCreate(a)) {
    const usageLimits = validated.usageLimits;
    const requested = validated.maxTokens;
    const requestedEffort = validated.effort;
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
      prompt: validated.prompt,
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
    // "May still be running" means the handle is retained and no exit event
    // has been observed; an exited-but-unforgotten handle is not a live risk.
    const runtimeUnconfirmed = workers.held(id) && !runtime.hasExited(id);
    const message = `Task ${id} failed to start: ${error.message}${runtimeUnconfirmed ? '; runtime exit not confirmed (process may still be running)' : ''}`;
    const cur = repository.peek(id);
    if (cur) {
      const outcome = settlement.startFailed({
        task: cur,
        error: error.message,
        message,
        runtimeUnconfirmed,
      });
      const persistError = persistFailure(outcome);
      if (persistError) {
        return new Error(`${message}; failure could not be persisted: ${persistError.message}`);
      }
    }
    return new Error(message);
  }
  /**
   * Persist a projected failure once. Event and save errors stay observable
   * instead of being silently swallowed; async callers log, while failStart
   * folds the error into the error it throws.
   */
  function persistFailure(outcome) {
    let persistError = null;
    try {
      commit(outcome.task, outcome.event ? [outcome.event] : []);
    } catch (error) {
      persistError = error;
    }
    if (persistError) {
      try {
        console.error(`Waxwing: could not persist failure projection for ${outcome.task.id}: ${persistError.message}`);
      } catch {}
    }
    return persistError;
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
    if (!usage) usage = usageModule.list(t, directory(t.id));
    const item = taskListView(t, {
      summary: withPaths ? null : summary,
      usage,
      runtimeHealth: t.runtimeHealth ?? t.runtime?.health ?? 'unknown',
      effort: effectiveEffort(t),
      workspaceMode: t.workspaceLease?.mode ?? 'legacy',
      error: t.error ? error.text : null,
    });
    item.maxTokens = effectiveMaxTokens(t);
    item.cleanupAuthorized = acceptance.hasGrant(t.id);
    item.live = workers.live(t.id);
    if (t.error && error.truncated) item.errorTruncated = true;
    if (withPaths) {
      const sourceWorkspace = t.sourceWorkspace ?? t.workspaceLease?.sourceWorkspace ?? t.workspace;
      item.workspaceMode = item.workspaceMode ?? t.workspaceLease?.mode ?? 'legacy';
      item.workspaceLabel = item.workspaceLabel ?? workspaceLabel(item.workspaceMode);
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
    const last = t.rounds.at(-1);
    // One usage computation supplies both the compact item and status.usage.
    // The last round's policy notice is a status warning, not a list flag.
    const snapshot = usageSnapshot(t, {
      extraWarnings: last?.policy?.warning ? [last.policy.warning] : [],
    });
    const base = compactTask(t, true, snapshot.listUsage);
    const resultText = latestResultText(t);
    const preview = clip(resultText, PREVIEW_LIMIT);
    const statusUsage = snapshot.statusUsage;
    const reworkBlocked = rework.blockedReason(t, statusUsage);
    const summary = taskSummaryView(t, {
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
    return normalizeTaskDetail(t, summary);
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
    return taskPageView(t.id, 'result', pageOf(text, offset, limit), {
      round: last?.number ?? null,
      finishReason: last?.result?.finishReason ?? null,
    });
  }
  /** Complete persisted record as reconstructable JSON text, one page at a time. */
  function historyPage(t, offset, limit) {
    const text = JSON.stringify(fullView(t), null, 2);
    return taskPageView(t.id, 'history', pageOf(text, offset, limit));
  }
  /** Usage metrics and per-request detail as reconstructable JSON text. */
  function usagePage(t, offset, limit) {
    const payload = usageModule.view(t, directory(t.id));
    const text = JSON.stringify(payload, null, 2);
    return taskPageView(t.id, 'usage', pageOf(text, offset, limit));
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
      live: workers.live(t.id),
      executionWorkspace: t.workspace,
      sourceWorkspace: t.sourceWorkspace ?? inspected.sourceWorkspace,
      workspaceLease: t.workspaceLease ?? null,
      details: inspected,
      runtime,
    };
    const text = JSON.stringify(payload, null, 2);
    return taskPageView(t.id, 'workspace', pageOf(text, offset, limit));
  }
  function diffPage(t, offset, limit) {
    const inspected = workspaceLeases.inspect(t.workspaceLease, t.workspace);
    return taskPageView(t.id, 'diff', pageOf(inspected.diff ?? '', offset, limit), {
      branch: inspected.branch ?? null,
      baseCommit: inspected.baseCommit ?? null,
      status: inspected.status ?? '',
    });
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
    return taskPageView(t.id, 'log', pageOf(content, offset, limit), {path: file});
  }
  function reportPage(t, offset, limit) {
    const content = acceptance.content(t);
    return taskPageView(t.id, 'report', pageOf(content, offset, limit));
  }
  function restoreTasks() {
    for (const restored of repository.restore()) {
      const name = restored.id;
      let t = restored;
      if (['running', 'stopping'].includes(t.status)) {
        let runtime = t.runtime;
        if (!runtime) {
          try { runtime = JSON.parse(fs.readFileSync(path.join(directory(name), 'runtime.json'), 'utf8')); } catch {}
        }
        if (runtime) {
          const verification = verifyOwnedRuntime(runtime);
          const outcome = settlement.recover({task: t, runtime, identity: verification});
          if (outcome.decision !== 'not-recoverable') {
            runtime = outcome.runtime;
            t = outcome.task;
            try { atomicJson(path.join(directory(name), 'runtime.json'), runtime); } catch {}
          }
        } else {
          t = {
            ...t,
            status: 'failed',
            error: 'Manager restarted; the old runtime is no longer reusable, so inspect the workspace and create a new task for follow-up work',
          };
        }
      }
      commit(t);
      acceptance.restoreGrant(t.id);
    }
    research.restore();
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
    return record;
  }
  /**
   * The Runtime module owns one round. The manager injects the effects it still
   * owns: task records, lifecycle transitions, the runtime.json projection, the
   * process fork, and the Provider-fallback handoff that only fires after a
   * release. No filesystem layout, Git, acceptance, or usage logic lives here.
   */
  /**
   * One settlement rule for every runtime fact: the task status, the event,
   * the lease conclusion, and the handle decision. The manager only persists
   * and dispatches what it returns.
   */
  const settlement = new RuntimeSettlement({
    terminate: record => terminateVerifiedRuntime(record),
    fallbackProvider: name => providerByName(name),
    defaultModel: () => config.model,
    supportsEffort: provider => supportsEffort(provider),
  });
  const runtime = new Runtime({
    spawn: ({task, ownerMarker}) => forkWorker(task, {ownerMarker}),
    latest: id => repository.peek(id) ?? null,
    commit: ({task, payload}) => commit(task, payload ? [payload] : []),
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
  }, {settlement});
  /**
   * Liveness facade. Two questions must stay distinct: `live` means the owned
   * process has not been observed to exit, so it may still write files; `held`
   * means the handle is retained until `forget`, which is what a failed final
   * save needs in order to retry.
   */
  const workers = {
    live: id => runtime.isLive(id),
    held: id => runtime.has(id),
    get: id => runtime.get(id),
    liveKeys: () => runtime.liveIds(),
  };
  const tasks = new TaskTransaction({
    runtime,
    repository,
    save,
    event: (task, payload) => commit(task, [payload]),
    commit: (task, events) => commit(task, events),
    workspace: workspaceLeases,
    acceptance,
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
    settlement,
  });
  /** Persist a terminal result or error, applying first-round Provider fallback. */
  function settleTerminal(task, rec, message) {
    let fallback = null;
    try {
      fallback = settlement.firstRoundFailure(task, message, config.fallbackProvider);
    } catch (error) {
      commit(task, [{kind: 'provider_fallback_failed', error: error.message}]);
    }
    if (fallback) {
      commit(fallback.task, [fallback.event]);
      runtime.deferFallback(fallback.fallback.taskId, fallback.fallback);
      return;
    }
    const outcome = settlement.terminal({task, message});
    commit(outcome.task, [outcome.event]);
  }
  /** A release without a result or error is a protocol violation, not a success. */
  function settleMissingTerminal(task, rec, message) {
    const outcome = settlement.missingTerminal({task, message});
    commit(outcome.task, [outcome.event]);
  }
  /** A busy worker means its previous round never released; fail explicitly. */
  function settleWorkerBusy(task, rec, message) {
    const outcome = settlement.workerBusy({task, message});
    const saved = commit(outcome.task, [outcome.event]);
    runtime.reportHealth(saved, rec, outcome.health.health, outcome.health.detail);
  }
  /** Deferred Provider fallback starts only after the failed round released. */
  function handoffReleased(fallback) {
    if (!fallback) return;
    const failed = repository.peek(fallback.taskId);
    if (!failed) return;
    void executeRun(failed, fallback.prompt, fallback.maxTokens, fallback.effort).catch(error => {
      const latest = repository.peek(fallback.taskId);
      if (latest && latest.status !== 'failed') {
        persistFailure(settlement.fallbackFailed({
          task: latest,
          providerName: fallback.providerName,
          message: `Fallback to ${fallback.providerName} also failed: ${error.message}`,
        }));
      }
    });
  }
  /** An unacknowledged round is untrusted, but its process is deliberately kept. */
  function settleAckTimeout(task, rec, roundId, timeoutMs) {
    const outcome = settlement.ackTimeout({task, roundId, timeoutMs});
    const saved = commit(outcome.task, [outcome.event]);
    runtime.reportHealth(saved, rec, outcome.health.health, outcome.health.detail);
  }
  /** A round deadline requests a stop; a failed stop must not look like a timeout. */
  function stopAfterRoundTimeout(rec, timeoutMs) {
    const id = rec.id;
    stop(id, false, `Round exceeded ${Math.round(timeoutMs / 1000)} seconds`).catch(error => {
      // A stop that cannot confirm exit leaves status=stopping and the
      // worker handle in place, so the workspace stays locked.
      const cur = repository.peek(id);
      if (cur && cur.status === 'running') {
        persistFailure(settlement.stopFailed({
          task: cur,
          timeoutMs,
          message: `Task ${id} timed out, but stopping it failed: ${error.message}`,
        }));
      }
    });
  }
  /**
   * Apply an already-validated round. The Runtime module owns the unique
   * roundId, the run -> ack -> result|error -> released ordering, the ACK,
   * heartbeat, and round timers, and the release gate. This function owns the
   * task record, the grant revocations, and the startup-failure bookkeeping.
   */
  async function executeRun(t, userPrompt, maxTokens, effort = null, runOptions = {}) {
    // The policy is read at round start; the recorded prompt stays the raw user
    // instruction and each round keeps the version/hash actually applied.
    const policy = executionPolicy.round();
    const effectivePrompt = executionPolicy.prompt(userPrompt, policy);
    const prepared = await tasks.prepareRun(t.id, {
      prompt: userPrompt,
      maxTokens,
      effort,
      policy,
      configure: runOptions.configure,
      events: runOptions.events,
    });
    const {task: next, roundId} = prepared;
    try {
      runtime.openRound(next, {
        roundId,
        prompt: effectivePrompt,
        maxTokens,
        effort,
        // Only a provider that declares a budget patch gets a per-round file.
        budgetFile: capabilitiesFor(next.provider).budgetPatch ? budgetFileFor(directory(next.id)) : null,
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
    return acceptance.preview(t, {directory: directory(t.id), live: workers.live(t.id)});
  }
  async function createTask(a = {}) {
    // All request, budget, workspace, and occupancy checks happen before any
    // task directory or record is written. A rejected request therefore leaves
    // the task list, directories, files, and grants untouched.
    const id = `task-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    const preflight = commandModule.create(a, {taskId: id});
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
          return conflict ? {...conflict, live: workers.live(conflict.id)} : null;
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
        // The adapter writes whatever files its task needs before round one.
        prepareTask(preflight.provider, t, {directory: dir, credentialsFile: config.credentialsFile});
        return t;
      },
    });
    return executeRun(created.task, preflight.prompt, preflight.maxTokens, preflight.effort);
  }
  // Handler table keyed by the operation catalogue. `action` owns the shared
  // validation; a new operation adds its catalogue entry and one handler here.
  const handlers = {
    list() {
      return [...repository.values()].map(t => {
        const snapshot = usageSnapshot(t);
        const item = compactTask(t, false, snapshot.listUsage);
        const flags = usageModule.listFlags(snapshot);
        if (flags.limitBlocked) item.limitBlocked = true;
        else if (flags.limitWarning) item.limitWarning = true;
        return item;
      });
    },
    status(a) {
      const t = get(a.id), q = statusQuery(a);
      if (q.view === 'summary') return statusSummary(t);
      if (q.view === 'result') return resultPage(t, q.offset, q.limit);
      if (q.view === 'usage') return usagePage(t, q.offset, q.limit);
      if (q.view === 'report') return reportPage(t, q.offset, q.limit);
      if (q.view === 'workspace') return workspacePage(t, q.offset, q.limit);
      if (q.view === 'diff') return diffPage(t, q.offset, q.limit);
      if (q.view === 'log') return logPage(t, q.offset, q.limit);
      return historyPage(t, q.offset, q.limit);
    },
    wait: a => waitForTask(a),
    research_start: a => research.start(a),
    research_status: a => research.status(a.id),
    research_wait: a => research.wait(a.id, {timeoutSeconds: a.timeoutSeconds}),
    research_collect: a => research.collect(a.id, {offset: a.offset, limit: a.limit}),
    research_cancel: a => research.cancel(a.id),
    create: a => createTask(a),
    rework(a) {
      const t = get(a.id);
      // One read-only decision supplies the prompt, limits, and override event.
      // The record change is applied only inside prepareRun's commit, so a gate
      // failure leaves both task.json and events.jsonl unchanged.
      const decision = rework.decide(t, a);
      if (!decision.allowed) throw new Error(decision.reason);
      return executeRun(t, decision.prompt, decision.maxTokens, decision.effort, {
        configure: value => Object.assign(value, decision.record),
        events: decision.event ? [decision.event] : [],
      });
    },
    cleanup_worktree(a) {
      const t = get(a.id);
      const {lease, ...result} = workspaceLeases.release({task: t, live: workers.live(t.id)});
      commit({...t, workspaceLease: lease ?? t.workspaceLease}, [
        {kind: 'worktree_cleaned', ...result},
      ]);
      return {id: t.id, ...result};
    },
    cancel: a => stop(a.id, false),
    close: a => stop(a.id, true),
    accept(a) {
      // Lifecycle first, then evidence: an illegal status must still report
      // "Cannot accept task in ..." exactly as before.
      const t = transition(get(a.id), 'accept');
      const accepted = acceptance.acceptAndSave(t, {
        evidence: a.evidence,
        save,
      });
      const saved = commit(accepted, [{kind: 'accepted', evidence: a.evidence}]);
      return statusSummary(saved);
    },
    export(a) {
      const t = get(a.id);
      return acceptance.exportAndSave(t, {save});
    },
    preview_delete: a => deletionPreview(get(a.id)),
    grant_delete(a) {
      // This endpoint is intentionally omitted from the MCP tool catalogue.
      // The trusted delegating party must obtain explicit human permission; the local OS account is the prototype trust boundary.
      // The module requires the complete, exact task ID before it previews.
      acceptance.assertConfirmation(a.id, a.confirmation);
      const t = get(a.id);
      return acceptance.grant(t, {
        directory: directory(t.id),
        live: workers.live(t.id),
        confirmation: a.confirmation,
      });
    },
    delete(a) {
      // Preview, archived-report hash, grant scope, and fingerprint equality
      // are one decision inside the module; the manager only reaps records.
      const t = get(a.id);
      return acceptance.removeTaskAndForget(t, {
        directory: directory(t.id),
        live: workers.live(t.id),
        forget: id => {
          repository.delete(id);
        },
      });
    },
  };
  async function action(name, a = {}) {
    // Shape, unknown fields, bounds, and operation-specific rules come from the
    // shared catalogue; handlers only add ordering and domain policy.
    a = validateOperation(name, a);
    const handler = handlers[name];
    if (!handler) throw new Error(`Unknown action: ${name}`);
    return handler(a);
  }
  async function shutdown() {
    if (shuttingDown) return; shuttingDown = true;
    await Promise.allSettled([...workers.liveKeys()].map(id => stop(id, true)));
  }
  return {action, restore: restoreTasks, shutdown};
}
