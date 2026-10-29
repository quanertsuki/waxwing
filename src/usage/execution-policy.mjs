// The execution-policy Module lives in `src/tasks/`: it shapes the prompt at
// round start and the policy section of a report, not usage metrics. This path
// remains as a forwarding import for 0.1 callers until 0.3.0.
export {DEFAULT_POLICY_FILE, ExecutionPolicy, digestText} from '../tasks/execution-policy.mjs';
