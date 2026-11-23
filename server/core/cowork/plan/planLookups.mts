/**
 * What the plan modules need to know about a tool name, read from the places that already know: the app index the
 * agent tool picker is built from, the side-effect map the automation runner dry-runs by, and the list of reads that
 * go to the open web (the one a run started by a mail is held to).
 *
 * The plan modules take these as a parameter (./planTypes.mts ToolLookups), so they stay pure and a test hands in its
 * own; this is the one place the real ones are wired.
 */

import { createRequire } from 'node:module';
import type { Effect, ToolLookups } from './planTypes.mts';

const nodeRequire = createRequire(import.meta.url);

/** The real lookups. Each module is loaded on first use, so requiring this file loads no registry. */
export function toolLookups(): ToolLookups {
    return {
        appOfTool(tool) {
            const { appIdForTool } = nodeRequire('../../agentRuntime/toolPolicy/appIndex.js') as { appIdForTool: (name: string) => string | null };
            return appIdForTool(tool);
        },
        effectOfTool(tool) {
            const { effectOf } = nodeRequire('../../automationModel/sideEffectMap.js') as { effectOf: (name: string) => Effect };
            return effectOf(tool);
        },
        isOpenWebRead(tool) {
            const { OUTSIDE_READS } = nodeRequire('../../agentRuntime/toolPolicy/mailRun.mts') as { OUTSIDE_READS: ReadonlySet<string> };
            return OUTSIDE_READS.has(tool);
        },
    };
}
