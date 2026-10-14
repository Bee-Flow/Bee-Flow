// "New automation" without the builder: POST /api/automation with a fresh,
// empty definition and open the row it made. The Studio "New" menu, the
// New-form dialog and the AI router's hand-off all create through here, so
// the body a draft starts with is written down once.
//
// `authFetch` rather than `apiClient`, like the rest of api/queries/automation
// (see http.ts): one attempt, never retried — a retried create is a second
// draft — and a refusal throws the server's text verbatim, which the callers
// put in front of the person ("Could not create the form. …").

import { API_BASE, authFetch } from '../../../utils/helpers';

/** What a create needs from its caller: where to go next and how to say "Untitled". */
export interface AutomationDraftCtx {
    /** Opens the new row in the builder; null/absent leaves navigation to the caller. */
    onNavigate?: ((target: string) => void) | null;
    t: (key: string, fallback?: string) => string;
}

export interface AutomationDraftOptions {
    title?: string | null;
    /** Replaces the manual trigger (the Form item passes a form trigger). */
    trigger?: Record<string, unknown> | null;
}

// A fresh automation row: the same body BuilderShell.ensureAutomationCreated
// posts on first save (title + a manual-trigger graph shaped like the
// server's emptyDefinition), so the builder opens on a document it already
// understands. `trigger` lets the Form item swap in a form trigger.
export async function createAutomationDraft(
    { onNavigate, t }: AutomationDraftCtx,
    { title, trigger }: AutomationDraftOptions = {},
): Promise<string | undefined> {
    const res = await authFetch(`${API_BASE}/api/automation`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            title: title || t('studio.new.untitled_automation', 'Untitled automation'),
            definition: {
                schemaVersion: 1,
                trigger: trigger || { id: 'trg', type: 'trigger', kind: 'manual', output: {} },
                steps: [],
                edges: [],
                vars: {},
            },
        }),
    });
    if (!res.ok) throw new Error(await res.text().catch(() => `HTTP ${res.status}`));
    const body = await res.json();
    const id = body?.automation?.id || body?.id;
    if (id && onNavigate) onNavigate(`studio/automations/${id}`);
    return id;
}
