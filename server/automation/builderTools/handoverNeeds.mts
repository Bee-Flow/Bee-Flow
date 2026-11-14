/**
 * What a finalised automation still needs before it is of use: the data the
 * hand-over card in the builder chat draws its buttons from, and the list the
 * assistant reads to end with "To use it: ...". A finalised automation is
 * saved and INACTIVE; whether the person must switch it on, share a form link,
 * start it by hand or connect an app first follows from the definition.
 *
 * The vocabulary (in this order, without duplicates):
 *   'connect:<app id>'  an app the draft USES (a step's tool, an AI step's
 *                       tool list, a code step's allowed tools, an app-event
 *                       trigger's provider) that is not connected for this
 *                       user. Never an app the draft does not use: an
 *                       unconnected app stays invisible to the assistant.
 *   'activate'          a trigger that starts runs by itself (schedule, app
 *                       event, webhook, form, agent call, app trigger).
 *   'share-form'        a form trigger: people reach it by its link.
 *   'run-once'          a manual trigger: the person starts it.
 * A building block (layer_input trigger) needs none of these.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

type Step = Record<string, any>;
type Definition = { trigger?: Step | null, triggers?: Step[] | null, steps?: Step[], layers?: Record<string, unknown> } | null | undefined;

export type HandoverNeed = 'activate' | 'share-form' | 'run-once' | `connect:${string}`;

// Trigger kinds that start runs on their own once the automation is active.
const SELF_STARTING = new Set(['schedule', 'app_event', 'webhook', 'form', 'agent_call', 'app_trigger']);

/** The tool names the draft's steps call, in walk order, root graph and layers. */
function usedTools(def: Definition): string[] {
    const { walkSteps } = nodeRequire('../../core/automationModel/automationGraph');
    const out = new Set<string>();
    const add = (t: unknown) => { if (typeof t === 'string' && t) out.add(t); };
    walkSteps(def, (s: Step) => {
        if (s.type === 'integration_action') add(s.tool);
        if (s.type === 'ai_step' && s.allowTools && Array.isArray(s.tools)) s.tools.forEach(add);
        if (s.type === 'code' && Array.isArray(s.allowedTools)) s.allowedTools.forEach(add);
    });
    return [...out];
}

/** The registry app ids an app-event trigger provider runs on (empty when it names none). */
function providerApps(provider: unknown): string[] {
    if (typeof provider !== 'string' || !provider) return [];
    const { getTriggerSource } = nodeRequire('../triggerSources');
    const availability = getTriggerSource(provider)?.availability;
    return availability?.kind === 'tools' && Array.isArray(availability.apps) ? availability.apps.filter((a: unknown) => typeof a === 'string') : [];
}

/**
 * The apps the draft uses that this user has not connected. `available` is the
 * user's resolved tool set (draftWrap._availableToolNames); without it nothing
 * is claimed, because "we were not told" is not "not connected".
 */
function unconnectedApps(def: Definition, triggers: Step[], available: Set<string> | null | undefined): string[] {
    if (!(available instanceof Set)) return [];
    const { findOwnerOfTool, toolNamesForApps } = nodeRequire('../toolRegistry');
    const connected = (app: string) => [...toolNamesForApps([app])].some((n: string) => available.has(n));
    const apps = new Set<string>();
    for (const tool of usedTools(def)) {
        if (available.has(tool)) continue;
        const owner = findOwnerOfTool(tool);
        if (owner && !connected(owner.app)) apps.add(owner.app);
    }
    for (const t of triggers) {
        if (t.kind !== 'app_event') continue;
        const candidates = providerApps(t.appEvent?.provider);
        if (candidates.length && !candidates.some(connected)) apps.add(candidates[0]);
    }
    return [...apps];
}

/**
 * The hand-over list for a finalised definition. Lookups that fail (a registry
 * or trigger source that will not load) drop only the connect entries.
 */
export function handoverNeeds(def: Definition, { availableToolNames = null }: { availableToolNames?: Set<string> | null } = {}): HandoverNeed[] {
    const triggers = [def?.trigger, ...(Array.isArray(def?.triggers) ? def.triggers : [])]
        .filter((t): t is Step => !!t && typeof t === 'object' && typeof t.kind === 'string');
    const needs: HandoverNeed[] = [];
    try {
        for (const app of unconnectedApps(def, triggers, availableToolNames)) needs.push(`connect:${app}`);
    } catch (err) {
        nodeRequire('../../utils/bestEffort').fallback('automation/builderTools/handoverNeeds', err);
    }
    if (triggers.some((t) => SELF_STARTING.has(t.kind))) needs.push('activate');
    if (triggers.some((t) => t.kind === 'form')) needs.push('share-form');
    if (triggers.some((t) => t.kind === 'manual')) needs.push('run-once');
    return needs;
}
