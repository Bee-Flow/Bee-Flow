// "Describe the look" in the form editor: the owner says what the form should
// look like and the fast-tier model answers with custom CSS for it.
//
// The ONLY place that knows this wire contract (server:
// routes/automation/formsAi.js, POST /api/automation/:id/forms/style-assist):
//   { triggerStepId?, prompt, style?, theme?, customCss? } → { css, notes, removed }
// `css` already went through the server's sanitizeFormCss; the renderer runs
// its own mirror over it again before anything is applied.

import { apiClient } from './client';

export interface StyleAssistInput {
    prompt: string;
    style?: Record<string, unknown> | null;
    theme?: Record<string, unknown> | null;
    customCss?: string | null;
}

export interface StyleAssistAnswer {
    css: string;
    /** What the model says it did, in its own words (English). */
    notes: string[];
    /** What the server's sanitiser took out of the model's CSS. */
    removed: string[];
}

/** What the editor calls: the automation and the page are already bound in. */
export type StyleAssist = (input: StyleAssistInput) => Promise<StyleAssistAnswer>;

type Post = (path: string, body: unknown) => Promise<unknown>;

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()) : []);

/** The answer as the editor reads it, whatever the server sent. */
export function readStyleAssistAnswer(raw: unknown): StyleAssistAnswer {
    const body = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    return {
        css: typeof body.css === 'string' ? body.css : '',
        notes: strings(body.notes),
        removed: strings(body.removed),
    };
}

/**
 * The style helper for one automation's form page, or null when there is no
 * saved automation to ask about yet (the editor then explains why the button
 * is off). `triggerStepId` names the trigger whose form it is, when not the
 * main one.
 */
export function styleAssistFor(automationId: string | null | undefined, triggerStepId: string | null = null, post: Post = (path, body) => apiClient.post(path, body)): StyleAssist | null {
    if (!automationId) return null;
    const path = `/api/automation/${encodeURIComponent(automationId)}/forms/style-assist`;
    return async ({ prompt, style = null, theme = null, customCss = null }) => {
        const body: Record<string, unknown> = { prompt };
        if (triggerStepId) body.triggerStepId = triggerStepId;
        if (style) body.style = style;
        if (theme) body.theme = theme;
        if (customCss) body.customCss = customCss;
        return readStyleAssistAnswer(await post(path, body));
    };
}
