// Legacy usage entry point. The metrics live in `src/usage/metrics.mjs` and
// limit evaluation lives in `src/usage/module.mjs`; these wrappers keep the
// 0.1 call shape (task + directory, global configuration) working until the
// compatibility layer is removed.
import path from 'node:path';
import {HERE, config} from './common.mjs';
import {UsageModule} from '../src/usage/module.mjs';

export {
    listSummaryOf,
    metricsForTask,
    usageViewFor,
} from '../src/usage/metrics.mjs';

function legacyModule() {
    return new UsageModule({
        configuration: {
            limits: config.usageLimits,
            providersDir: config.providersDir,
            pricingFile: path.join(HERE, 'pricing.json'),
        },
    });
}

/** Legacy snapshot with limits composed by the module. Never throws. */
export function usageForTask(task, taskDir, options = {}) {
    return legacyModule().snapshot(task, taskDir, options);
}

/** Bounded list-level usage summary. Never throws. */
export function usageForList(task, taskDir) {
    return legacyModule().list(task, taskDir);
}

/** Default status summary: totals, cumulative limits, and per-round rows. Never throws. */
export function usageForStatus(task, taskDir) {
    return legacyModule().status(task, taskDir);
}

/** Full usage view payload. Never throws. */
export function usageForView(task, taskDir) {
    return legacyModule().view(task, taskDir);
}
