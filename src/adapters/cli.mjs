// Public CLI adapter. prototype/cli.mjs remains the 0.1.x compatibility module.
export {
  HELP_TEXT,
  WAIT_GRACE_MS,
  WAIT_INITIAL_MS,
  WAIT_MAX_MS,
  main,
  nextWaitDelay,
  parseCommandArgs,
  parseResearchCollectArgs,
  parseStatusArgs,
  parseWaitArgs,
  wait,
  waitTimeoutMs,
} from '../../prototype/cli.mjs';
