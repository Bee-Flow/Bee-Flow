/**
 * crypto.mts: the content of the KB query log, sealed under a key of the organisation.
 *
 * Key: HKDF over the org root key (auth/orgEscrow), bound to org and knowledge base,
 * so every KB has its own key and a leaked one opens one KB only. The log is read by
 * the KB's managers and by background jobs with no session in scope, so the key cannot
 * be a user's: like shared project chats, on the `zk` tier the server operator can read
 * this content (it chains back to MASTER_ENCRYPTION_KEY). The setting says so.
 *
 * Envelope: the one every encrypted column uses (stores/lib/fieldEnvelope.js), AES-256-GCM,
 * AAD `kbql:v1:{orgId}:{kbId}:{rowId}:{field}`. A ciphertext moved to another row, KB or
 * field fails its tag check instead of reading as the wrong text.
 *
 * Policy: when the organisation has content encryption off (or the `messages` surface off)
 * the value is stored as plain text, as the other stores do. Reading is format-driven: an
 * envelope is opened, anything else is returned as is. A write that needs a key and cannot
 * get one throws KbQueryLogKeyUnavailable; the recorder then skips that log row (the search
 * itself never fails).
 */

import { createRequire } from 'node:module';
import { hkdfSync } from 'node:crypto';

const nodeRequire = createRequire(import.meta.url);

export const KB_QUERY_LOG_HKDF_SALT = Buffer.from('beeflow:kbquerylog:hkdf-salt:v1');

export class KbQueryLogKeyUnavailable extends Error {
    code = 'KB_QUERY_LOG_KEY_UNAVAILABLE';
    constructor(message = 'The encryption key for the knowledge-base query log is not available') {
        super(message);
        this.name = 'KbQueryLogKeyUnavailable';
    }
}

export type KbQueryLogField = 'query' | 'chunks' | 'answer' | 'citations' | 'review_note';

export interface CryptoDeps {
    getOrgRootKey: (orgId: string | null) => Promise<Buffer>;
    resolveOrgId: (orgId: string | null | undefined) => string;
    /** Whether content of this organisation is sealed. Strict: throws when the policy cannot be read. */
    sealingEnabled: (orgId: string | null) => Promise<boolean>;
}

function defaultDeps(): CryptoDeps {
    return {
        getOrgRootKey: (orgId) => nodeRequire('../../../auth/orgEscrow.js').getOrgRootKey(orgId),
        resolveOrgId: (orgId) => nodeRequire('../../../stores/integrationConnectionStore.js').resolveOrgId(orgId),
        sealingEnabled: async (orgId) => {
            const policy = nodeRequire('../../../stores/encryptionPolicy.js');
            const p = await policy.resolvePolicy(orgId, { strict: true });
            return !!p.enabled && policy.shouldEncrypt(p, policy.SURFACES.MESSAGES);
        },
    };
}

let deps: CryptoDeps | null = null;
const d = (): CryptoDeps => deps ?? (deps = defaultDeps());

/** Test hook: replace the dependencies; no argument restores the real ones. */
export function _setCryptoDeps(next?: Partial<CryptoDeps> | null): void {
    deps = next ? { ...defaultDeps(), ...next } : null;
}

export function fieldAad(orgId: string, kbId: string, rowId: string, field: string): string {
    return `kbql:v1:${orgId}:${kbId}:${rowId}:${field}`;
}

/** The per-KB key. Pure; exported for tests. */
export function deriveKbKey(ork: Buffer, orgId: string, kbId: string): Buffer {
    if (!Buffer.isBuffer(ork) || ork.length !== 32) throw new Error('[KbQueryLog] org root key must be a 32-byte Buffer');
    if (!kbId) throw new Error('[KbQueryLog] kbId is required');
    return Buffer.from(hkdfSync('sha256', ork, KB_QUERY_LOG_HKDF_SALT, `beeflow:kbquerylog:v1:key:${orgId}:${kbId}`, 32));
}

async function keyFor(rawOrgId: string | null, kbId: string): Promise<{ key: Buffer; orgId: string }> {
    const orgId = d().resolveOrgId(rawOrgId);
    let ork: Buffer;
    try {
        // Copy at once: the escrow cache zeroes its buffer when an entry expires.
        ork = Buffer.from(await d().getOrgRootKey(rawOrgId));
    } catch (err) {
        throw new KbQueryLogKeyUnavailable(`org root key unavailable: ${(err as Error).message}`);
    }
    if (ork.length !== 32 || !ork.some((b) => b !== 0)) throw new KbQueryLogKeyUnavailable('org root key is not usable');
    return { key: deriveKbKey(ork, orgId, kbId), orgId };
}

/**
 * Seal `value` for storage. null/undefined stay null. Plain text when the org has
 * encryption off. Throws KbQueryLogKeyUnavailable when the policy or key cannot be had.
 */
export async function sealField(orgId: string | null, kbId: string, rowId: string, field: KbQueryLogField, value: string | null | undefined): Promise<string | null> {
    if (value === null || value === undefined) return null;
    const { buildEnvelope, isEnvelope } = nodeRequire('../../../stores/lib/fieldEnvelope.js');
    let on: boolean;
    try {
        on = await d().sealingEnabled(orgId);
    } catch (err) {
        throw new KbQueryLogKeyUnavailable(`encryption policy unavailable: ${(err as Error).message}`);
    }
    const text = String(value);
    if (!on) {
        // A stored plain value that happens to look like an envelope would be opened as one on read.
        return isEnvelope(text) ? ` ${text}` : text;
    }
    const { key, orgId: id } = await keyFor(orgId, kbId);
    return JSON.stringify(buildEnvelope(text, key, fieldAad(id, kbId, rowId, field)));
}

/**
 * Read a stored value: an envelope is opened (throws FieldDecryptError when the AAD or key is
 * wrong), anything else is plain text and returned as is. null stays null.
 */
export async function openField(orgId: string | null, kbId: string, rowId: string, field: KbQueryLogField, stored: string | null | undefined): Promise<string | null> {
    if (stored === null || stored === undefined) return null;
    const { openEnvelope, isEnvelope } = nodeRequire('../../../stores/lib/fieldEnvelope.js');
    if (!isEnvelope(stored)) return String(stored);
    const { key, orgId: id } = await keyFor(orgId, kbId);
    return openEnvelope(stored, key, fieldAad(id, kbId, rowId, field));
}
