// The one-time "this runs with your own connections" notice
// (server routes/automation/runs.js, automation/callerNotice.js): the ONLY place
// that knows the wire contract of GET /:id/caller-notice and
// POST /:id/caller-notice/seen.

import { API_BASE, authFetch } from '@/utils/helpers';
import { AutomationRequestError, getAutomationJson } from './http';

export interface CallerNotice {
    /** The automation runs on the caller's own connections and the viewer is not its owner. */
    applies: boolean;
    seen: boolean;
    /** The apps the run will act in, as the server names them ("Google"). */
    providers: string[];
    /** Places the OWNER controls that the run writes to: knowledge_base, tables, document_library, generated_files. */
    destinations: string[];
    /** The keys of everything the notice names; sent back when the person confirms. */
    items: string[];
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((p): p is string => typeof p === 'string') : []);

/** What the viewer has to be told before their first run. */
export async function fetchCallerNotice(automationId: string): Promise<CallerNotice> {
    const body = await getAutomationJson(automationId, '/caller-notice', 'Caller notice');
    const o = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    return {
        applies: o.applies === true,
        seen: o.seen === true,
        providers: strings(o.providers),
        destinations: strings(o.destinations),
        items: strings(o.items),
    };
}

/** Remember that the viewer has read it: the items they were shown go back, so only those are recorded. */
export async function acknowledgeCallerNotice(automationId: string, items: string[]): Promise<void> {
    const res = await authFetch(`${API_BASE}/api/automation/${encodeURIComponent(automationId)}/caller-notice/seen`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items }),
    });
    if (!res.ok) throw new AutomationRequestError(`Caller notice ${res.status}`, res.status, null);
}
