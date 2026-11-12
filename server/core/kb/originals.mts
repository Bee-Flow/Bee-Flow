/**
 * originals.mts: the uploaded file of a knowledge-base document, kept next to its extracted text.
 *
 * A knowledge base used to keep only the text of a document; the bytes that came in were dropped
 * (core/kb/sources/upload.js). A base can now opt in (`knowledge_bases.keep_originals`) to keep the
 * original too, so a person can download it and an agent can hand it over (`kb_get_original`).
 *
 * ── WHERE AND HOW ───────────────────────────────────────────────────
 * Under `orgs/<tenantId>/kb/<kbId>/<documentId>/<sha256>` in object storage, sealed with the
 * organisation key like a notebook file (stores/lib/notebookFileCrypto.js), when the organisation has
 * an encryption policy. The key and the hash sit on the documents row (`original_storage_key`,
 * `original_sha256`, plus `original_mime`, `original_size`); the key never reaches a client, which
 * gets `has_original`. The `orgs/` prefix is not served by the storage proxy
 * (routes/storageProxy.js allows `users/<id>/` and `shared/` only): the one door is the download
 * route, behind the same access check as the document's text.
 *
 * ── PRIVACY: A COPY MUST NOT BYPASS THE REDACTION ───────────────────
 * When the Privacy Shield redacts text at ingest (core/kb/ingestPrivacy.js), `original_content` IS
 * the redacted text, "there is no copy of the original anywhere", and that is the feature. Keeping
 * the file would put the unredacted data back next to it. So `keepOriginal` refuses on its own when
 * redaction is in force for the base (or the document came out redacted), whatever the caller or
 * the UI did; the knowledge-base payload reports it as `originals_blocked_reason`.
 *
 * ── NOTHING HERE MAY FAIL AN INGEST ─────────────────────────────────
 * The text is what makes a document searchable. A refused, oversized or failed copy is a result
 * value (and a log line), never a throw, so callers can ignore it. Only the deletions that an
 * erasure depends on take `strict`.
 *
 * Size cap: `KB_ORIGINAL_MAX_MB` (default 50, 0 = unlimited).
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export type OriginalsBlockedReason = 'privacy_redaction' | null;

export interface KbRow {
    id: string;
    tenant_id: string;
    organization_id?: string | null;
    keep_originals?: boolean;
}

interface DocRow {
    id: string;
    status?: string | null;
    pii_status?: string | null;
    title?: string | null;
    original_storage_key?: string | null;
    original_mime?: string | null;
    original_size?: string | number | null;
    original_sha256?: string | null;
    original_filename?: string | null;
}

export interface KeepArgs {
    tenantId: string;
    kbId: string;
    documentId: string;
    buffer: Buffer;
    mime?: string | null;
    filename?: string | null;
}

export type KeepResult = { kept: true; key: string; size: number } | { kept: false; reason: 'kb_missing' | 'document_missing' | 'privacy_redaction' | 'too_large' | 'storage_unavailable' | 'failed' };

export interface OriginalFile {
    buffer: Buffer;
    mime: string;
    filename: string;
    size: number;
}

export interface DocRef {
    tenantId: string;
    kbId: string;
    documentId: string;
}

/** The seams: storage, the database, the crypto and the shield lookup. Tests hand in doubles. */
export interface OriginalsDeps {
    getKb: (kbId: string) => Promise<KbRow | null>;
    getDoc: (ref: DocRef) => Promise<DocRow | null>;
    saveDoc: (ref: DocRef, fields: { key: string; mime: string; size: number; sha256: string; filename: string }) => Promise<boolean>;
    clearDoc: (ref: DocRef) => Promise<void>;
    clearKb: (kb: { id: string; tenant_id: string }) => Promise<void>;
    anyOriginals: (kbId: string) => Promise<boolean>;
    redactionInForce: (kb: KbRow) => Promise<boolean>;
    storageAvailable: () => boolean;
    upload: (key: string, bytes: Buffer, contentType: string) => Promise<void>;
    read: (key: string) => Promise<Buffer>;
    remove: (key: string) => Promise<void>;
    removePrefix: (prefix: string) => Promise<void>;
    seal: (kb: KbRow, key: string, bytes: Buffer) => Promise<Buffer>;
    info: (msg: string) => void;
    warn: (msg: string, detail?: unknown) => void;
}

const DEFAULT_MAX_MB = 50;

/** The cap in bytes; 0 means unlimited. A value that is not a number >= 0 falls back to the default. */
export function maxOriginalBytes(env: NodeJS.ProcessEnv = process.env): number {
    const raw = env.KB_ORIGINAL_MAX_MB;
    if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_MB * 1024 * 1024;
    const mb = Number(raw);
    if (!Number.isFinite(mb) || mb < 0) return DEFAULT_MAX_MB * 1024 * 1024;
    return Math.floor(mb * 1024 * 1024);
}

/** The prefix every original of a base sits under. */
export function kbPrefix(tenantId: string, kbId: string): string {
    return `orgs/${tenantId}/kb/${kbId}/`;
}

export function originalKey(tenantId: string, kbId: string, documentId: string, sha256: string): string {
    return `${kbPrefix(tenantId, kbId)}${documentId}/${sha256}`;
}

function defaultDeps(): OriginalsDeps {
    const log = nodeRequire('../../telemetry/log.js');
    const storage = () => nodeRequire('../../stores/storageStore.js');
    const db = () => nodeRequire('../../db.js');
    return {
        getKb: (kbId) => nodeRequire('../../stores/knowledgeBases.js').getKB(kbId),
        getDoc: ({ tenantId, kbId, documentId }) => db().getOne(
            `SELECT id, status, pii_status, title, original_storage_key, original_mime, original_size, original_sha256,
                    metadata->>'originalFilename' AS original_filename
               FROM documents WHERE id = $1 AND knowledge_base_id = $2 AND tenant_id = $3`,
            [documentId, kbId, tenantId],
        ),
        saveDoc: async ({ tenantId, kbId, documentId }, f) => {
            const row = await db().getOne(
                `UPDATE documents
                    SET original_storage_key = $4, original_mime = $5, original_size = $6, original_sha256 = $7,
                        metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('originalFilename', $8::text)
                  WHERE id = $1 AND knowledge_base_id = $2 AND tenant_id = $3 RETURNING id`,
                [documentId, kbId, tenantId, f.key, f.mime, f.size, f.sha256, f.filename],
            );
            return !!row;
        },
        clearDoc: async ({ tenantId, kbId, documentId }) => {
            await db().run(
                `UPDATE documents SET original_storage_key = NULL, original_mime = NULL, original_size = NULL, original_sha256 = NULL
                  WHERE id = $1 AND knowledge_base_id = $2 AND tenant_id = $3`,
                [documentId, kbId, tenantId],
            );
        },
        clearKb: async (kb) => {
            await db().run(
                `UPDATE documents SET original_storage_key = NULL, original_mime = NULL, original_size = NULL, original_sha256 = NULL
                  WHERE knowledge_base_id = $1 AND tenant_id = $2 AND original_storage_key IS NOT NULL`,
                [kb.id, kb.tenant_id],
            );
        },
        anyOriginals: async (kbId) => !!(await db().getOne(
            'SELECT 1 AS present FROM documents WHERE knowledge_base_id = $1 AND original_storage_key IS NOT NULL LIMIT 1', [kbId],
        )),
        redactionInForce: (kb) => redactionInForce(kb),
        storageAvailable: () => storage().isAvailable(),
        upload: (key, bytes, contentType) => storage().uploadFile(key, bytes, contentType),
        read: (key) => nodeRequire('../../stores/lib/notebookFileCrypto.js').readBuffer(key),
        remove: (key) => storage().deleteFile(key),
        removePrefix: async (prefix) => {
            const { mode, configured } = storage().getStatus();
            // No object store was ever set up (a test, an install without one): nothing can be kept there.
            if (!mode && !configured) return;
            if (!mode) throw new Error('object storage is configured but unreachable');
            await storage().deletePrefix(prefix);
        },
        seal: async (kb, key, bytes) => {
            const crypto = nodeRequire('../../stores/lib/documentCrypto.js');
            const resource = { type: 'notebook-file', id: key, userId: kb.tenant_id, organizationId: kb.organization_id ?? null };
            const context = await crypto.writeContext(resource, true);
            if (!context) return bytes;
            return nodeRequire('../../stores/lib/notebookFileCrypto.js').sealBuffer(resource, key, bytes, context);
        },
        info: (msg) => log.info(msg),
        warn: (msg, detail) => log.warn(msg, detail),
    };
}

/**
 * Does the ingest privacy screening rewrite text for this base? True when the shield that applies to
 * it is on for knowledge bases, its action rewrites or holds (tokenise, block; "warn" and "pass" keep
 * the real text) and the detection service is installed (without it every document comes out
 * `unscanned` and nothing is redacted).
 */
export async function redactionInForce(kb: KbRow): Promise<boolean> {
    try {
        const { resolveShieldFor } = nodeRequire('../privacy/orgShield.js');
        const privacy = nodeRequire('./ingestPrivacy.js');
        const shield = await resolveShieldFor({ orgId: kb.organization_id || null, userId: kb.tenant_id || null });
        if (!privacy.scanEnabledFor(shield)) return false;
        if (privacy.isLegacyWarn(shield) || shield.piiDetectionAction === 'pass') return false;
        return await privacy.guardInstalled();
    } catch {
        // The policy cannot be read: a copy that might bypass a redaction is not kept.
        return true;
    }
}

/** Why a base cannot keep originals right now, for its payload. */
export async function originalsBlockedReason(kb: KbRow, deps: Partial<OriginalsDeps> = {}): Promise<OriginalsBlockedReason> {
    const check = deps.redactionInForce || redactionInForce;
    return (await check(kb)) ? 'privacy_redaction' : null;
}

export type OriginalWithheldReason = 'not_kept' | 'privacy_redaction' | null;

/** True when the document's text came out of the privacy screening redacted. */
function isRedactedDoc(doc: Pick<DocRow, 'status' | 'pii_status'> | null | undefined): boolean {
    return !!doc && (doc.status === 'redacted' || doc.pii_status === 'redacted');
}

/**
 * Why a kept original may not be handed out now, or null when it may. Asked by both doors (the download
 * route through openOriginal, and kb_get_original) on every request, so a file stays behind once the base
 * stops keeping originals, once the document came out redacted, or once redaction is in force for the base.
 */
export async function originalWithheldReason(
    kb: KbRow | null | undefined,
    doc: Pick<DocRow, 'status' | 'pii_status'> | null | undefined,
    deps: Partial<Pick<OriginalsDeps, 'redactionInForce'>> = {},
): Promise<OriginalWithheldReason> {
    if (!kb || !kb.keep_originals) return 'not_kept';
    if (isRedactedDoc(doc)) return 'privacy_redaction';
    const check = deps.redactionInForce || redactionInForce;
    return (await check(kb)) ? 'privacy_redaction' : null;
}

/** The file name a download carries: the one that came in, else the title, with an extension from the type when it has none. */
export function downloadName(doc: Pick<DocRow, 'title' | 'original_filename' | 'original_mime'>): string {
    const base = String(doc.original_filename || doc.title || 'document').replace(/[\\/\0]/g, '_').trim() || 'document';
    if (/\.[A-Za-z0-9]{1,8}$/.test(base)) return base;
    const ext = EXTENSIONS[String(doc.original_mime || '').toLowerCase()];
    return ext ? `${base}.${ext}` : base;
}

const EXTENSIONS: Record<string, string> = {
    'application/pdf': 'pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
    'text/plain': 'txt',
    'text/markdown': 'md',
    'text/csv': 'csv',
    'text/html': 'html',
    'image/png': 'png',
    'image/jpeg': 'jpg',
};

/**
 * Keep `buffer` as the original of a document, encrypted. Never throws for a refusal or a failure:
 * the answer says what happened, and the text ingest it belongs to goes on.
 */
export async function keepOriginal(args: KeepArgs, deps: Partial<OriginalsDeps> = {}): Promise<KeepResult> {
    const d: OriginalsDeps = { ...defaultDeps(), ...deps };
    const ref: DocRef = { tenantId: args.tenantId, kbId: args.kbId, documentId: args.documentId };
    try {
        const kb = await d.getKb(args.kbId);
        if (!kb || String(kb.tenant_id) !== String(args.tenantId)) return { kept: false, reason: 'kb_missing' };
        const doc = await d.getDoc(ref);
        if (!doc) return { kept: false, reason: 'document_missing' };

        // Checked here, not only in the UI: the copy would carry what the redaction took out of the text.
        // An earlier copy of this document would now be the unredacted one beside redacted text, so it goes too.
        const redactedDoc = isRedactedDoc(doc);
        if (redactedDoc || await d.redactionInForce(kb)) {
            d.info(redactedDoc
                ? `[KBOriginals] Not kept: document ${args.documentId} was redacted at ingest`
                : `[KBOriginals] Not kept: privacy redaction is in force for knowledge base ${args.kbId}`);
            if (doc.original_storage_key) await dropOriginal(d, ref, doc.original_storage_key);
            return { kept: false, reason: 'privacy_redaction' };
        }

        const size = args.buffer.length;
        const cap = maxOriginalBytes();
        if (cap > 0 && size > cap) {
            d.info(`[KBOriginals] Not kept: ${size} bytes is over KB_ORIGINAL_MAX_MB (document ${args.documentId})`);
            return { kept: false, reason: 'too_large' };
        }

        if (!d.storageAvailable()) return { kept: false, reason: 'storage_unavailable' };

        const sha256 = createHash('sha256').update(args.buffer).digest('hex');
        const key = originalKey(args.tenantId, args.kbId, args.documentId, sha256);
        if (doc.original_storage_key === key) return { kept: true, key, size };

        const mime = args.mime || 'application/octet-stream';
        await d.upload(key, await d.seal(kb, key, args.buffer), 'application/octet-stream');
        const saved = await d.saveDoc(ref, { key, mime, size, sha256, filename: args.filename || doc.title || 'document' });
        if (!saved) {
            await d.remove(key).catch(() => undefined);
            return { kept: false, reason: 'document_missing' };
        }
        // The old bytes go after the pointer moved: a failure in between leaves a stray blob, never a dangling pointer.
        if (doc.original_storage_key && doc.original_storage_key !== key) {
            await d.remove(doc.original_storage_key).catch((e: Error) => d.warn('[KBOriginals] Could not remove a replaced original:', e.message));
        }
        return { kept: true, key, size };
    } catch (e) {
        d.warn(`[KBOriginals] Could not keep the original of document ${args.documentId}:`, (e as Error).message);
        return { kept: false, reason: 'failed' };
    }
}

async function dropOriginal(d: OriginalsDeps, ref: DocRef, key: string): Promise<void> {
    await d.remove(key);
    await d.clearDoc(ref);
}

/**
 * The kept original of a document, decrypted; null when there is none or it is withheld
 * (originalWithheldReason). Throws when the bytes cannot be read.
 */
export async function openOriginal(ref: DocRef, deps: Partial<OriginalsDeps> = {}): Promise<OriginalFile | null> {
    const d: OriginalsDeps = { ...defaultDeps(), ...deps };
    const doc = await d.getDoc(ref);
    if (!doc || !doc.original_storage_key) return null;
    const kb = await d.getKb(ref.kbId);
    if (!kb || String(kb.tenant_id) !== String(ref.tenantId)) return null;
    if (await originalWithheldReason(kb, doc, d)) return null;
    const buffer = await d.read(doc.original_storage_key);
    return {
        buffer,
        mime: doc.original_mime || 'application/octet-stream',
        filename: downloadName(doc),
        size: buffer.length,
    };
}

/**
 * Remove the kept original of one document (the blob, then the pointer). `strict` makes a failure
 * throw; otherwise it is logged. Nothing to do for a document without one.
 */
export async function deleteOriginal(ref: DocRef, { strict = false, deps }: { strict?: boolean; deps?: Partial<OriginalsDeps> } = {}): Promise<void> {
    const d: OriginalsDeps = { ...defaultDeps(), ...deps };
    try {
        const doc = await d.getDoc(ref);
        if (!doc || !doc.original_storage_key) return;
        await dropOriginal(d, ref, doc.original_storage_key);
    } catch (e) {
        if (strict) throw e;
        d.warn(`[KBOriginals] Could not remove the original of document ${ref.documentId}:`, (e as Error).message);
    }
}

/** Remove every kept original of a base, before the base itself goes. Skips the storage listing when the base kept none. */
export async function deleteOriginalsForKb(kb: { id: string; tenant_id: string }, { strict = false, deps }: { strict?: boolean; deps?: Partial<OriginalsDeps> } = {}): Promise<void> {
    const d: OriginalsDeps = { ...defaultDeps(), ...deps };
    try {
        if (!(await d.anyOriginals(kb.id))) return;
        await d.removePrefix(kbPrefix(kb.tenant_id, kb.id));
    } catch (e) {
        if (strict) throw e;
        d.warn(`[KBOriginals] Could not remove the originals of knowledge base ${kb.id}:`, (e as Error).message);
    }
}

/**
 * A base that stops keeping originals: remove every kept file, then the pointers on its documents. The
 * pointers go only after the files did, so a failed removal leaves them for the next attempt (switching
 * the option off again, or deleting the base) instead of a blob nothing points at any more. Never throws.
 */
export async function dropOriginalsForKb(kb: { id: string; tenant_id: string }, { deps }: { deps?: Partial<OriginalsDeps> } = {}): Promise<boolean> {
    const d: OriginalsDeps = { ...defaultDeps(), ...deps };
    try {
        if (!(await d.anyOriginals(kb.id))) return true;
        await d.removePrefix(kbPrefix(kb.tenant_id, kb.id));
        await d.clearKb(kb);
        d.info(`[KBOriginals] Removed the kept originals of knowledge base ${kb.id}`);
        return true;
    } catch (e) {
        d.warn(`[KBOriginals] Could not remove the originals of knowledge base ${kb.id}:`, (e as Error).message);
        return false;
    }
}

/** Retrieval rows with the base and `has_original` of their document (core/kb/originalFlags.mts). */
export { withOriginalFlags } from './originalFlags.mts';
