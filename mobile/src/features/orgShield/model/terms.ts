/**
 * The org's own "always hide" terms and its "never hide" list — the checks
 * CustomTermsTable.jsx and AllowTermsChips.jsx run before a save, mirroring
 * what the PUT handler refuses. The regex engine is the specification: a
 * pattern is compiled the way the server compiles it and its own message is
 * reported.
 */

import type { CustomTerm } from './types';

export type TermProblem =
    | { kind: 'missing_pattern' }
    | { kind: 'too_long' }
    | { kind: 'bad_regex'; message: string };

export function validateTerm(term: Pick<CustomTerm, 'pattern' | 'type' | 'caseSensitive'>): TermProblem | null {
    if (!term.pattern || !term.pattern.trim()) return { kind: 'missing_pattern' };
    if (term.pattern.length > 500) return { kind: 'too_long' };
    if (term.type !== 'regex') return null;
    try {
        new RegExp(term.pattern, term.caseSensitive ? '' : 'i');
        return null;
    } catch (e) {
        return { kind: 'bad_regex', message: e instanceof Error ? e.message : String(e) };
    }
}

// nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_insecure_random_generator -- a client-side id for a term in the list, not a token; the timestamp keeps it unique
export function newTermId(now = Date.now(), random = Math.random()): string {
    return `term-${now}-${Math.round(random * 1e6)}`;
}

/** Add or replace (by id) one term. */
export function upsertTerm(terms: readonly CustomTerm[], next: CustomTerm): CustomTerm[] {
    return terms.some((t) => t.id === next.id)
        ? terms.map((t) => (t.id === next.id ? { ...t, ...next } : t))
        : [...terms, next];
}

export function labelTaken(terms: readonly CustomTerm[], label: string, exceptId?: string): boolean {
    const wanted = label.trim().toLowerCase();
    return terms.some((t) => t.id !== exceptId && t.label.trim().toLowerCase() === wanted);
}

/** `normaliseAllowValue` (server/core/dlp/allowTerms.js): only letters and digits count. */
export function allowKey(value: string): string {
    return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

export type AllowProblem = 'empty' | 'too_long' | 'duplicate';

export function allowProblem(existing: readonly string[], raw: string): AllowProblem | null {
    const key = allowKey(raw);
    if (!key) return 'empty';
    if (raw.length > 120) return 'too_long';
    if (existing.some((x) => allowKey(x) === key)) return 'duplicate';
    return null;
}
