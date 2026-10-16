// @typecheck
'use strict';
/**
 * Which document contracts a caller has read over MCP, kept between calls.
 *
 * builder_read_document records the contract it returned on the draft wrap
 * (`_documentContracts`) and builder_add_fill_document refuses a document whose
 * contract is not there. Over MCP every call builds a fresh wrap, so the read
 * was forgotten before the next call and a fill_document step could never be
 * configured. This keeps the read for a short time.
 *
 * Scope: one entry per (user, automation). Never shared across users or
 * automations, in memory only, expires after TTL_MS since the last read.
 */

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 500;

/** @type {Map<string, { at: number, contracts: Record<string, any> }>} */
const reads = new Map();

/** @param {string} userId @param {string} automationId */
const keyOf = (userId, automationId) => JSON.stringify([userId, automationId]);

function sweep(now) {
    for (const [k, v] of reads) if (now - v.at > TTL_MS) reads.delete(k);
    while (reads.size > MAX_ENTRIES) reads.delete(reads.keys().next().value);
}

/**
 * Put the contracts this caller read earlier on a fresh draft wrap.
 * @param {{ userId?: string, automationId?: string, _documentContracts?: Record<string, any> }} wrap
 */
function restore(wrap, now = Date.now()) {
    if (!wrap.userId || !wrap.automationId) return;
    const entry = reads.get(keyOf(wrap.userId, wrap.automationId));
    if (!entry || now - entry.at > TTL_MS) return;
    wrap._documentContracts = { ...entry.contracts, ...(wrap._documentContracts || {}) };
}

/**
 * Remember the contracts on the wrap after a call. A call that read nothing
 * leaves the stored entry (and its expiry) untouched.
 * @param {{ userId?: string, automationId?: string, _documentContracts?: Record<string, any> }} wrap
 */
function remember(wrap, now = Date.now()) {
    if (!wrap.userId || !wrap.automationId || !wrap._documentContracts) return;
    const key = keyOf(wrap.userId, wrap.automationId);
    sweep(now);
    reads.set(key, { at: now, contracts: { ...wrap._documentContracts } });
}

function clear() { reads.clear(); }

module.exports = { restore, remember, clear, TTL_MS };
