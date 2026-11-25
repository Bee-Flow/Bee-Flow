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

/**
 * What a person calls a tool: its app's name, then what the rest of the tool name says ("Fireflies: list transcripts",
 * "Google Drive: list recent"); null when no app owns it or the registry cannot say.
 */
export function toolLabel(tool: string, appId: string | null): string | null {
    if (!appId) return null;
    let app: { label?: unknown } | null = null;
    try {
        const { featureModule } = nodeRequire('../../featureModules.js') as { featureModule: (name: string) => { appEntryFor: (id: string) => { label?: unknown } | null } };
        app = featureModule('automation/toolRegistry').appEntryFor(appId);
    } catch {
        return null;
    }
    const label = typeof app?.label === 'string' ? app.label.trim() : '';
    if (!label) return null;
    const own = new Set(label.toLowerCase().split(/\s+/));
    const words = tool.split('_').filter(Boolean);
    while (words.length > 1 && own.has(String(words[0]).toLowerCase())) words.shift();
    const rest = words.join(' ');
    return rest && !own.has(rest.toLowerCase()) ? `${label}: ${rest}` : label;
}

/** The real lookups. Each module is loaded on first use, so requiring this file loads no registry. */
export function toolLookups(): ToolLookups {
    const appOfTool = (tool: string): string | null => {
        const { appIdForTool } = nodeRequire('../../agentRuntime/toolPolicy/appIndex.js') as { appIdForTool: (name: string) => string | null };
        return appIdForTool(tool);
    };
    return {
        appOfTool,
        effectOfTool(tool) {
            const { effectOf } = nodeRequire('../../automationModel/sideEffectMap.js') as { effectOf: (name: string) => Effect };
            return effectOf(tool);
        },
        labelOfTool: (tool) => toolLabel(tool, appOfTool(tool)),
        isOpenWebRead(tool) {
            const { OUTSIDE_READS } = nodeRequire('../../agentRuntime/toolPolicy/mailRun.mts') as { OUTSIDE_READS: ReadonlySet<string> };
            return OUTSIDE_READS.has(tool);
        },
    };
}
