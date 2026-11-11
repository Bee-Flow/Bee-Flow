/**
 * Custom block: the ceilings a block is saved under.
 *
 * The defaults live with the vocabulary (server/shared/blockTemplate/vocabulary.mjs). An
 * operator may move the three that are checked at save, a whole number each, 0 = unlimited:
 *
 *   STUDIO_APP_BLOCK_TEMPLATE_CHARS   characters of one template            (60000)
 *   STUDIO_APP_BLOCK_NODES            elements and texts in one template    (3000)
 *   STUDIO_APP_BLOCK_DEPTH            levels of nesting                     (32)
 *
 * How many items a repeat draws (1000) and how much one block draws in all (20000) are decided
 * in the browser, which has no channel for an instance setting: those two are the constants
 * MAX_REPEAT and MAX_OUTPUT_NODES of the vocabulary.
 */

import { BLOCK_LIMITS } from '../../shared/blockTemplate/index.mjs';

export type BlockSaveLimits = { maxChars: number; maxNodes: number; maxDepth: number };

function limitFromEnv(value: string | undefined, fallback: number): number {
    const raw = String(value ?? '').trim();
    if (!raw) return fallback;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return fallback;
    return n === 0 ? Infinity : n;
}

/** The save limits for this process. Read on every call: a test sets the environment per case. */
export function blockSaveLimits(env: Record<string, string | undefined> = process.env): BlockSaveLimits {
    return {
        maxChars: limitFromEnv(env.STUDIO_APP_BLOCK_TEMPLATE_CHARS, BLOCK_LIMITS.MAX_TEMPLATE_CHARS),
        maxNodes: limitFromEnv(env.STUDIO_APP_BLOCK_NODES, BLOCK_LIMITS.MAX_NODES),
        maxDepth: limitFromEnv(env.STUDIO_APP_BLOCK_DEPTH, BLOCK_LIMITS.MAX_DEPTH),
    };
}
