/**
 * "Build it with AI" — the pure half of the web's Studio/Forms/form/
 * AiDraftPanel.jsx (aiDraft.lockstep.test.ts runs its isBlankForm beside this
 * one). One box, two modes: a fresh form (no questions, or the product's own
 * placeholder three) takes a BRIEF and the whole form is drafted; a form with
 * questions takes a REQUEST, and the current questions travel along so a kept
 * question keeps its name — and its answers column.
 */

import { ApiError } from '@/core/api/client';

export type DraftMode = 'create' | 'revise';

const DEFAULT_NAMES = ['name', 'email', 'message'];

/** The product's own placeholder form, or no questions at all: a brief, not a request. */
export function isBlankForm(form: { fields?: unknown; title?: unknown } | null | undefined): boolean {
    const fields = Array.isArray(form?.fields) ? (form?.fields as { name?: unknown }[]) : [];
    if (!fields.length) return true;
    return (
        fields.length === DEFAULT_NAMES.length &&
        fields.every((f, i) => f?.name === DEFAULT_NAMES[i]) &&
        (!form?.title || form.title === 'Get in touch')
    );
}

/** The request body: a brief for `create`, a note for `revise`; the current form either way. */
export function draftBody(mode: DraftMode, text: string, current: unknown): Record<string, unknown> {
    const value = text.trim();
    return mode === 'revise' ? { mode, note: value, current } : { mode, brief: value, current };
}

/** The server's longest brief (automation/formDraft.js MAX_BRIEF_CHARS). */
export const MAX_BRIEF_CHARS = 12000;

/** Why a draft failed, as a sentence key and its English — the web's errorText. */
export function draftErrorWords(err: unknown): { key: string; fallback: string } | null {
    const code = err instanceof ApiError ? err.code : (err as { code?: unknown } | null)?.code;
    if (code === 'no_model') return { key: 'forms.ai.err_no_model', fallback: 'No AI model is set up for this workspace yet.' };
    if (code === 'ai_unusable') {
        return { key: 'forms.ai.err_unusable', fallback: 'The AI did not return a usable form. Try again, or describe it more concretely.' };
    }
    if (code === 'no_brief' || code === 'no_note') return { key: 'forms.ai.err_no_text', fallback: 'Type or paste something first.' };
    if (err instanceof ApiError && err.status === 429) {
        return { key: 'forms.ai.err_rate', fallback: 'Too many drafts in a minute — wait a moment and try again.' };
    }
    return null;
}
