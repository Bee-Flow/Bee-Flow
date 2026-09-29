// The automation template gallery: the ONLY place that knows the wire
// contract of GET /api/automation/templates (the organisation's own templates
// first, `source: 'org'`, then the built-in ones).
//
// `authFetch` rather than `apiClient`, like the other automation reads: the
// callers render a failure as a sentence, and the tests mock `authFetch`.

import { useQuery } from '@tanstack/react-query';
import { API_BASE, authFetch } from '../../../utils/helpers';

/** One card in the gallery (no definition: picking a template fetches it). */
export interface TemplateCard {
    id: string;
    title: string;
    description: string;
    /** Built-in templates only; an organisation template has none. */
    category: string | null;
    icon: string | null;
    tags: string[];
    source: 'org' | 'builtin';
    /** Organisation templates: who saved it, and whether that was the viewer. */
    createdByName: string | null;
    mine: boolean;
    createdAt: string | null;
    requiredIntegrations: string[];
    /** 'push-pending': the trigger needs the Bee Flow connector to fire. */
    triggerReadiness: string | null;
    triggerKind: string | null;
    /** The app an app-event trigger listens to (nextcloud, gmail, …). */
    triggerApp: string | null;
    stepCount: number | null;
}

export const automationTemplateKeys = {
    list: ['automation', 'templates'] as const,
};

const text = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x) : []);

/** Normalise one /templates body. Exported for the test; tolerant of junk. */
export function parseTemplates(body: unknown): TemplateCard[] {
    const raw = body && typeof body === 'object' ? body as Record<string, unknown> : {};
    const rows = Array.isArray(raw.templates) ? raw.templates : [];
    const out: TemplateCard[] = [];
    for (const r of rows) {
        if (!r || typeof r !== 'object') continue;
        const row = r as Record<string, unknown>;
        const id = text(row.id);
        if (!id) continue;
        out.push({
            id,
            title: text(row.title) || id,
            description: text(row.description) || '',
            category: text(row.category),
            icon: text(row.icon),
            tags: strings(row.tags),
            source: row.source === 'org' ? 'org' : 'builtin',
            createdByName: text(row.createdByName),
            mine: row.mine === true,
            createdAt: text(row.createdAt),
            requiredIntegrations: strings(row.requiredIntegrations),
            triggerReadiness: text(row.triggerReadiness),
            triggerKind: text(row.triggerKind),
            triggerApp: text(row.triggerApp),
            stepCount: typeof row.stepCount === 'number' && Number.isFinite(row.stepCount) ? row.stepCount : null,
        });
    }
    return out;
}

export async function fetchAutomationTemplates(signal?: AbortSignal): Promise<TemplateCard[]> {
    const res = await authFetch(`${API_BASE}/api/automation/templates`, { signal });
    if (!res.ok) {
        let message = 'The templates could not be loaded.';
        try {
            const body = await res.json();
            if (body && typeof body.error === 'string' && body.error) message = body.error;
        } catch { /* not JSON: keep the sentence */ }
        throw new Error(message);
    }
    return parseTemplates(await res.json());
}

/** The gallery. Read on mount, so a template saved a moment ago shows up when the launcher comes back. */
export function useAutomationTemplates() {
    return useQuery({
        queryKey: automationTemplateKeys.list,
        queryFn: ({ signal }) => fetchAutomationTemplates(signal),
    });
}
