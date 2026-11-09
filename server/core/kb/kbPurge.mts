/**
 * kbPurge.mts: the chunks of a knowledge base, removed before the base itself.
 *
 * Chunks live in two places: the local kb_chunks table and, when the search
 * service is the provider, that service's index. The service only removes
 * chunks per document (DELETE /kb/documents/{id}), so the documents are walked
 * while their rows still exist; the local table is cleared per base.
 * The kept original files of the base (core/kb/originals.mts) go last.
 *
 * Callers: the knowledge-base delete route, web page delete, and account and
 * organisation erasure. `strict` makes a failed removal throw, which erasure
 * needs (a retry must be possible); the routes log and continue as before.
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

export interface KbRef {
    id: string;
    tenant_id: string;
}

export interface KbPurgeDeps {
    resolveKbProvider: () => Promise<string>;
    listDocuments: (kbId: string, opts: { limit: number; offset: number }) => Promise<Array<{ id: string }> | null>;
    purgeDocumentChunks: (kbId: string, docId: string, tenantId: string, opts: { strict: boolean; deleteLocal: () => Promise<void> }) => Promise<void>;
    deleteChunksLocally: (tenantId: string, kbId: string) => Promise<void>;
    deleteOriginals: (kb: KbRef, opts: { strict: boolean }) => Promise<void>;
    warn: (msg: string, detail?: unknown) => void;
}

const PAGE = 200;
const MAX_PAGES = 200;

function defaultDeps(): KbPurgeDeps {
    const log = nodeRequire('../../telemetry/log.js');
    return {
        resolveKbProvider: () => nodeRequire('./resolveProvider.js').resolveKbProvider(),
        listDocuments: (kbId, opts) => nodeRequire('../../stores/knowledgeBases.js').listDocuments(kbId, opts),
        purgeDocumentChunks: (kbId, docId, tenantId, opts) => nodeRequire('./kbReingest.js').purgeDocumentChunks(kbId, docId, tenantId, opts),
        deleteChunksLocally: (tenantId, kbId) => nodeRequire('./localKBIngest.js').deleteChunksLocally(tenantId, kbId),
        deleteOriginals: (kb, opts) => nodeRequire('./originals.mts').deleteOriginalsForKb(kb, opts),
        warn: (msg, detail) => log.warn(msg, detail),
    };
}

const noLocal = async (): Promise<void> => {};

/** Remove every chunk of `kb`, in the search service and in the local table. */
export async function purgeKbChunks(kb: KbRef, { strict = false, deps }: { strict?: boolean; deps?: Partial<KbPurgeDeps> } = {}): Promise<void> {
    const d: KbPurgeDeps = { ...defaultDeps(), ...deps };
    try {
        if ((await d.resolveKbProvider()) !== 'local') {
            for (let page = 0; page < MAX_PAGES; page++) {
                const docs = await d.listDocuments(kb.id, { limit: PAGE, offset: page * PAGE });
                if (!docs || docs.length === 0) break;
                for (const doc of docs) await d.purgeDocumentChunks(kb.id, doc.id, kb.tenant_id, { strict, deleteLocal: noLocal });
                if (docs.length < PAGE) break;
            }
        }
    } catch (e) {
        if (strict) throw e;
        d.warn('[KB] Search-service chunk cleanup failed:', (e as Error).message);
    }
    try {
        await d.deleteChunksLocally(kb.tenant_id, kb.id);
    } catch (e) {
        if (strict) throw e;
        d.warn('[KB] Local chunk cleanup failed:', (e as Error).message);
    }
    // The kept original files of the base (encrypted blobs in object storage), if it kept any.
    try {
        await d.deleteOriginals(kb, { strict });
    } catch (e) {
        if (strict) throw e;
        d.warn('[KB] Original-file cleanup failed:', (e as Error).message);
    }
}
