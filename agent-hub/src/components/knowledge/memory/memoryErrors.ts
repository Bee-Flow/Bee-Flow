import type { WriteResult } from './useMemories';

type T = (key: string, fallback: string, params?: Record<string, unknown>) => string;

/** The sentence for a refused memory write; `code` is the server's `body.code`. */
export function memoryRefusal(t: T, code: string | null, status: number | null): string | null {
    if (code === 'sensitive_identifier') {
        return t('knowledge.memory_err_identifier', 'This looks like a password, account or ID number. Those are never stored.');
    }
    if (code === 'sensitive_not_allowed') {
        return t('knowledge.memory_err_sensitive', 'This is about a sensitive topic. Turn on sensitive topics in Settings → Memory to keep it, if your organisation allows it.');
    }
    if (code === 'memory_disabled') {
        return t('knowledge.memory_err_disabled', 'Memory is turned off for your organisation, so nothing can be added.');
    }
    if (status === 409 && code === 'memory_unreadable') {
        return t('knowledge.memory_err_unreadable', 'This memory can no longer be opened; you can delete it.');
    }
    return null;
}

export function writeFailureMessage(t: T, result: WriteResult, fallback: string): string {
    if (result.ok) return fallback;
    return memoryRefusal(t, result.code, result.status) ?? fallback;
}
