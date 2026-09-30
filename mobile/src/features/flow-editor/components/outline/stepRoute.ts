/**
 * The addresses the build screen sends people to.
 *
 * The node editor is app/automations/[id]/steps/[stepId].tsx: `id` is the
 * routine's id — or, before a new routine has been created, its draft key
 * (FlowDraft.key), which the editor's useFlowDraft resolves to the same open
 * store — and `stepId` is the step's address (nested.ts: a held step's
 * container path, `loop_1/ai_2`), which expo-router URI-encodes as one
 * segment. `section` names the editor section to open (sectionForIssue), for
 * a finding; `flowlet`, the flowlet the step lives in (its build screen is
 * app/automations/[id]/flowlets/[layerKey].tsx).
 *
 * Both are route OBJECTS, so their `pathname` is a literal that
 * src/meta/routes.test.ts holds to a screen under app/.
 */

import type { Href } from 'expo-router';

export function stepEditorPath(flowId: string, address: string, section?: string | null, flowlet?: string | null): Href {
    const params: Record<string, string> = { id: flowId, stepId: address };
    if (section) params.section = section;
    if (flowlet) params.flowlet = flowlet;
    return { pathname: '/automations/[id]/steps/[stepId]', params };
}

/** One flowlet of a routine, built on its own screen (definition.layers[key]). */
export function flowletPath(flowId: string, key: string): Href {
    return { pathname: '/automations/[id]/flowlets/[layerKey]', params: { id: flowId, layerKey: key } };
}

/** A routine's build screen. */
export function buildPath(automationId: string): Href {
    return { pathname: '/automations/[id]/build', params: { id: automationId } };
}

/** The step editor's address as a string (a link to share, a deep link); `stepEditorPath` for navigating. */
export function stepEditorHref(automationId: string, stepId: string, section?: string | null): string {
    const base = `/automations/${encodeURIComponent(automationId)}/steps/${encodeURIComponent(stepId)}`;
    return section ? `${base}?section=${encodeURIComponent(section)}` : base;
}
