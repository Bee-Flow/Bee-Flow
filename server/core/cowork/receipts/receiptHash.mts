/**
 * The two hashes of a receipt chain (./issueReceipts.mts writes them, ./verifyReceipts.mts checks them): the hash of a
 * receipt's content, as sha256 over its JSON with every object's keys sorted (so the same content always hashes the
 * same, whatever order a reader parsed it in), and the link, sha256 over the previous receipt's hash and this one's.
 * The same construction as the compliance evidence chain (server/compliance/evidence), kept here so core does not
 * reach up into compliance.
 */

import { createHash } from 'node:crypto';

/** JSON with every object's keys in code-point order; undefined fields are left out, as JSON.stringify does. */
export function canonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
    if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : canonicalJson(v))).join(',')}]`;
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The hash of a receipt's content, hex. */
export function hashPayload(payload: unknown): string {
    return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

/** The link between a receipt and the one before it, hex. */
export function linkHash(prevHash: string, payloadHash: string): string {
    return createHash('sha256').update((prevHash || '') + payloadHash).digest('hex');
}
