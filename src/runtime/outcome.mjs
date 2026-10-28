function validTask(task) {
  return Boolean(task) && typeof task === 'object' && Array.isArray(task.rounds);
}

function validMessage(message) {
  return Boolean(message) && typeof message === 'object' &&
    (message.kind === 'result' || message.kind === 'error');
}

function detached(task) {
  return {
    ...task,
    rounds: task.rounds.map(round => ({
      ...round,
      result: round.result && typeof round.result === 'object'
        ? {...round.result}
        : round.result,
    })),
  };
}

/**
 * Project a confirmed runtime outcome into the task fields, event, and
 * lifecycle action the manager must persist. This module never writes files or
 * sends messages; it owns only the terminal decision order.
 */
export class RuntimeOutcomeSettlement {
  constructor({
    transition,
    now = () => new Date().toISOString(),
    fallbackProvider = () => null,
    defaultModel = () => null,
    supportsEffort = () => false,
  } = {}) {
    if (typeof transition !== 'function') throw new Error('transition dependency is required');
    this.transition = transition;
    this.now = now;
    this.fallbackProvider = fallbackProvider;
    this.defaultModel = defaultModel;
    this.supportsEffort = supportsEffort;
  }

  terminal({task, message} = {}) {
    if (!validTask(task)) throw new Error('task record is required');
    if (!validMessage(message)) throw new Error('terminal runtime message is required');
    const ok = message.kind === 'result' && message.finishReason === 'completed';
    const finishReason = message.finishReason ?? (ok ? 'completed' : 'error');
    const error = ok ? null : message.error ?? `Provider ended with ${finishReason}`;
    const action = ok ? 'finish' : 'fail';
    const changed = this.transition(detached(task), action);
    changed.output = message.text ?? '';
    changed.finishReason = finishReason;
    changed.error = error;
    const last = changed.rounds.at(-1);
    if (last) {
      last.result = {
        text: changed.output,
        finishReason: changed.finishReason,
        error,
      };
      last.finishedAt = this.now();
    }
    return {
      task: changed,
      action,
      event: {
        kind: 'round_finished',
        roundId: message.roundId,
        status: changed.status,
      },
      fallback: null,
    };
  }

  /**
   * Decide first-round fallback before the normal terminal projection. The
   * handoff is a deferred action; this module never dispatches it.
   */
  firstRoundFailure(task, message, fallbackName = null) {
    if (!validTask(task)) throw new Error('task record is required');
    if (!validMessage(message)) throw new Error('terminal runtime message is required');
    const ok = message.kind === 'result' && message.finishReason === 'completed';
    if (ok || task.rounds.length !== 1 || !fallbackName ||
        task.provider?.name === fallbackName) {
      return null;
    }
    const provider = this.fallbackProvider(fallbackName);
    if (!provider) return null;
    const candidate = detached(task);
    const round = candidate.rounds[0];
    const at = this.now();
    round.result = {
      text: message.text ?? '',
      finishReason: message.finishReason ?? 'error',
      error: message.error || `Provider ended with ${message.finishReason ?? 'error'}`,
    };
    round.finishedAt = at;
    const failed = this.transition(candidate, 'fail');
    failed.provider = provider;
    failed.model = provider.model || this.defaultModel();
    failed.error = null;
    return {
      task: failed,
      action: 'fail',
      event: {
        kind: 'provider_fallback',
        from: task.provider?.name ?? null,
        to: fallbackName,
        error: message.error || message.finishReason,
      },
      fallback: {
        taskId: task.id,
        prompt: round.prompt,
        maxTokens: round.maxTokens,
        effort: this.supportsEffort(provider) ? round.effort ?? null : null,
        providerName: fallbackName,
      },
    };
  }

  missingTerminal({task, message} = {}) {
    if (!validTask(task)) throw new Error('task record is required');
    const failed = task.status === 'running' ? this.transition(detached(task), 'fail') : detached(task);
    failed.error = `Task ${task.id}: worker released ${message?.roundId} without a result or error`;
    return {
      task: failed,
      action: failed.status === task.status ? null : 'fail',
      event: {
        kind: 'round_protocol_error',
        roundId: message?.roundId,
        reason: 'missing terminal message',
      },
      health: null,
    };
  }

  workerBusy({task, message} = {}) {
    if (!validTask(task)) throw new Error('task record is required');
    const failed = task.status === 'running' ? this.transition(detached(task), 'fail') : detached(task);
    failed.error = `Task ${task.id}: worker_busy for ${message?.roundId}; the previous round is still active`;
    return {
      task: failed,
      action: failed.status === task.status ? null : 'fail',
      event: {kind: 'worker_busy', reportedRoundId: message?.roundId},
      health: {health: 'unhealthy', detail: 'worker_busy'},
    };
  }

  ackTimeout({task, roundId, timeoutMs} = {}) {
    if (!validTask(task)) throw new Error('task record is required');
    const failed = this.transition(detached(task), 'fail');
    failed.error = `Task ${task.id}: worker did not acknowledge round ${roundId} within ${timeoutMs / 1000}s; the process was not terminated`;
    return {
      task: failed,
      action: 'fail',
      event: {kind: 'round_ack_timeout', roundId},
      health: {health: 'unhealthy', detail: 'ack timeout'},
    };
  }
}
