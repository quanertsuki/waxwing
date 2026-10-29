// Deprecated compatibility facade. Restart recovery and close projection now
// live in `RuntimeSettlement`; this class keeps the old method names until
// 0.3.0 and maps its results back to the previous shape.
import {terminateVerifiedRuntime} from './identity.mjs';
import {RuntimeSettlement, MANUAL_RETAINED, NORMAL_RETAINED} from './settlement.mjs';

export class RuntimeLifecycle {
  constructor({
    terminate = record => terminateVerifiedRuntime(record),
    now = () => new Date().toISOString(),
    closeOutcome = null,
  } = {}) {
    this.settlement = closeOutcome?.settlement ?? new RuntimeSettlement({terminate, now});
  }

  recover(args = {}) {
    return this.settlement.recover(args);
  }

  /** Close projection with the pre-0.3.0 result fields. */
  exit(args = {}) {
    const outcome = this.settlement.close(args);
    const decision = args.exitConfirmed !== true
      ? 'exit-unconfirmed'
      : args.closeError ? 'cleanup-failed' : 'exited';
    return {...outcome, decision, workspaceRetained: true};
  }
}

export {MANUAL_RETAINED, NORMAL_RETAINED};
