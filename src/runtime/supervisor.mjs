// Deprecated compatibility class. Release and exit gates are implemented in
// `module.mjs` and used directly by `Runtime`; this facade remains until 0.3.0.
import {
  recordHasExited,
  settleRecordRelease,
  waitForRecordExit,
  waitForRecordRelease,
} from './module.mjs';

export class RuntimeSupervisor {
  settleRelease(record, value) {
    settleRecordRelease(record, value);
  }

  waitForRelease(record) {
    return waitForRecordRelease(record);
  }

  hasExited(record) {
    return recordHasExited(record);
  }

  waitForExit(record, timeoutMs) {
    return waitForRecordExit(record, timeoutMs);
  }
}
