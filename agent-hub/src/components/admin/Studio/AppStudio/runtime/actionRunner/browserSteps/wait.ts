import { CANCELLED, sleep } from '../core';
import type { BrowserStepModule } from '../browserSteps';

/** The longest pause the browser holds: LIMITS.MAX_CLIENT_WAIT_SECONDS (browserSteps.lockstep.test.ts holds the two equal). */
export const MAX_WAIT_SECONDS = 30;

/**
 * wait (server/appStudio/componentSpecs/steps/wait.js): holds the next step back
 * for whole seconds, at most MAX_WAIT_SECONDS. A surface that went away in the
 * meantime ends the sequence there, as a cancelled run. A longer wait, or one until a
 * moment, fails the step: only a run on the server holds it.
 */
const entry: BrowserStepModule = {
    kind: 'wait',
    run: async ({ ctx }, step) => {
        // A long wait is a server run's (the validator refuses it in a page-walked action): never shortened silently here.
        if ((step.until !== undefined && step.until !== null) || Number(step.seconds) > MAX_WAIT_SECONDS) {
            throw new Error(ctx.tr('studio_apps_h2.wait.runtime_too_long', 'This wait is longer than a page can hold. It needs an action that runs on the server.'));
        }
        const seconds = Math.min(Math.max(Math.trunc(Number(step.seconds)) || 0, 0), MAX_WAIT_SECONDS);
        if (!seconds) return;
        await sleep(seconds * 1000);
        if (!ctx.alive.current) throw CANCELLED;
    },
};

export default entry;
