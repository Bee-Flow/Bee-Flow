/**
 * The bounds of the document compare. Every one is an environment variable
 * with a generous default, and 0 means unlimited (an operator on a big server
 * may want a 10 000-slide deck compared in full). Read fresh on every call, so
 * a change needs no restart and a test can set one for a single case.
 *
 *   DOCUMENT_COMPARE_MAX_TEXT_BLOCKS    2000       blocks per side compared in detail (past it: counts only)
 *   DOCUMENT_COMPARE_MAX_WORD_TOKENS    2000       words per line diffed word by word (past it: line replaced)
 *   DOCUMENT_COMPARE_MAX_LISTED_ROWS    500        sheet rows listed per tab (past it: changed rows and neighbours)
 *   DOCUMENT_COMPARE_MAX_LCS_CELLS      4000000    cells of one alignment table (past it: matched by position)
 *   DOCUMENT_COMPARE_MAX_PAIRING_CELLS  250000     cells of one similarity-pairing table (past it: by position)
 */

/** A whole number >= 0 from the environment, 0 = unlimited (Infinity); unset, empty or garbage gives `fallback`. */
export function capFromEnv(name: string, fallback: number, env: Record<string, string | undefined> = process.env): number {
    const raw = env[name];
    if (raw == null || raw.trim() === '') return fallback;
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return n === 0 ? Number.POSITIVE_INFINITY : Math.floor(n);
}

export interface CompareLimits {
    maxTextBlocks: number;
    maxWordTokens: number;
    maxListedRows: number;
    maxLcsCells: number;
    maxPairingCells: number;
}

export function compareLimits(env: Record<string, string | undefined> = process.env): CompareLimits {
    return {
        maxTextBlocks: capFromEnv('DOCUMENT_COMPARE_MAX_TEXT_BLOCKS', 2000, env),
        maxWordTokens: capFromEnv('DOCUMENT_COMPARE_MAX_WORD_TOKENS', 2000, env),
        maxListedRows: capFromEnv('DOCUMENT_COMPARE_MAX_LISTED_ROWS', 500, env),
        maxLcsCells: capFromEnv('DOCUMENT_COMPARE_MAX_LCS_CELLS', 4_000_000, env),
        maxPairingCells: capFromEnv('DOCUMENT_COMPARE_MAX_PAIRING_CELLS', 250_000, env),
    };
}
