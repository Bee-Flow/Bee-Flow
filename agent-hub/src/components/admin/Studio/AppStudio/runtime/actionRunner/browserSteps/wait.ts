import { CANCELLED, sleep } from '../core';
import type { BrowserStepModule } from '../browserSteps';

/** The longest pause the browser holds: LIMITS.MAX_CLIENT_WAIT_SECONDS (browserSteps.lockstep.test.ts holds the two equal). */
export const MAX_WAIT_SECONDS = 30;

/**
 * wait (server/appStudio/componentSpecs/steps/wait.js): holds the next step back
 * for whole seconds, at most MAX_WAIT_SECONDS. A surface that went away in the
 * meantime ends the sequence there, as a cancelled run.
 */
const entry: BrowserStepModule = {
    kind: 'wait',
    run: async ({ ctx }, step) => {
        const seconds = Math.min(Math.max(Math.trunc(Number(step.seconds)) || 0, 0), MAX_WAIT_SECONDS);
        if (!seconds) return;
        await sleep(seconds * 1000);
        if (!ctx.alive.current) throw CANCELLED;
    },
};

export default entry;
