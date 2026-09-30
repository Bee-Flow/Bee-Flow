/**
 * Saving which knowledge bases a chat is grounded on — why a change did not
 * land, in the web's words (conversationKbApi.js's refusal reasons and
 * KnowledgeBasePanel.jsx's sentences), pinned by kbSelection.lockstep.test.ts.
 */

import { ApiError } from '@/core/api/client';

/** knowledgeBaseClaim.js MAX_ATTACHED_KBS: more is refused before it is sent. */
export const MAX_ATTACHED_KBS = 50;

export type KbRefusal = 'invalid' | 'rejected' | 'too_many' | 'forbidden' | 'gone' | 'unavailable' | 'failed';

const STATUS_REASONS: Readonly<Record<number, KbRefusal>> = { 403: 'forbidden', 404: 'gone', 503: 'unavailable' };

export function kbRefusalOf(err: unknown): KbRefusal {
    const status = err instanceof ApiError ? err.status : undefined;
    if (status && STATUS_REASONS[status]) return STATUS_REASONS[status] as KbRefusal;
    if (status !== 400) return 'failed';
    const invalid = (err as ApiError).body && typeof (err as ApiError).body === 'object' ? ((err as ApiError).body as { invalid?: unknown }).invalid : null;
    return Array.isArray(invalid) && invalid.some((v) => typeof v === 'string') ? 'invalid' : 'rejected';
}

export const KB_REFUSAL_WORDS: Readonly<Record<KbRefusal, { i18nKey: string; en: string }>> = {
    invalid: { i18nKey: 'chat.composer.kb_error_invalid', en: 'Some of those knowledge bases are not available to you. Nothing was changed.' },
    too_many: { i18nKey: 'chat.composer.kb_error_too_many', en: 'A chat can use at most {count} knowledge bases.' },
    forbidden: { i18nKey: 'chat.composer.kb_error_forbidden', en: 'Only the owner can change what this chat is grounded on.' },
    gone: { i18nKey: 'chat.composer.kb_error_gone', en: 'This chat is no longer available.' },
    unavailable: { i18nKey: 'chat.composer.kb_error_unavailable', en: 'This server cannot store knowledge bases on a chat yet.' },
    rejected: { i18nKey: 'chat.composer.kb_error_failed', en: 'That change could not be saved. Nothing was changed.' },
    failed: { i18nKey: 'chat.composer.kb_error_failed', en: 'That change could not be saved. Nothing was changed.' },
};

/** Whether two selections name the same bases, in any order. */
export function sameSelection(a: readonly string[], b: readonly string[]): boolean {
    return a.length === b.length && a.every((id) => b.includes(id));
}
