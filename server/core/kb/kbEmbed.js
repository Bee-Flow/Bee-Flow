const crypto = require('crypto');
const configStore = require('../../stores/configStore');
const { getServiceHeaders } = require('../serviceAuth');
const log = require('../../telemetry/log');

const SEARCH_SERVICE_URL = process.env.SEARCH_SERVICE_URL || 'https://services.beeflow.nl';

/**
 * SimHash (64-bit) over normalized tokens of `text`.
 * Used for near-duplicate detection — small hamming distance (≤3) means
 * two documents are ~99% the same text modulo whitespace / casing.
 *
 * Returns a signed BigInt fitting Postgres BIGINT, or null for empty input.
 */
function simhash64(text) {
    if (!text) return null;
    const normalized = String(text)
        .toLowerCase()
        .replace(/https?:\/\/\S+/g, '')
        .replace(/\d{5,}/g, '')
        .replace(/[^a-z0-9\s]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    if (!normalized) return null;
    const tokens = normalized.split(' ').filter(t => t.length > 2);
    if (tokens.length === 0) return null;

    const v = new Array(64).fill(0);
    for (const tok of tokens) {
        const h = crypto.createHash('md5').update(tok).digest(); // nosemgrep: ajinabraham.njsscan.crypto.crypto_node.node_md5 -- feature hashing for a local similarity vector (simhash), not a security hash
        for (let bit = 0; bit < 64; bit++) {
            const byte = h[bit >> 3];
            const isSet = (byte >> (bit & 7)) & 1;
            v[bit] += isSet ? 1 : -1;
        }
    }
    // Convert bit vector to 64-bit two's-complement signed BigInt.
    let unsigned = 0n;
    for (let i = 0; i < 64; i++) if (v[i] > 0) unsigned |= (1n << BigInt(i));
    // Postgres BIGINT is signed; map high bit to negative range.
    const signed = unsigned >= (1n << 63n) ? unsigned - (1n << 64n) : unsigned;
    // Node's Postgres driver accepts BigInt for bigint columns.
    return signed;
}

/**
 * Read Azure embedding credentials from configStore.
 * Returns { use_azure, azure_endpoint?, azure_key?, azure_model? }
 */
async function getAzureIngestParams() {
    const useAzure = !!(await configStore.getConfig('use_azure_doc_processing'));
    if (!useAzure) return { use_azure: false };
    return {
        use_azure: true,
        azure_endpoint: await configStore.getConfig('azure_openai_embedding_endpoint') || '',
        azure_key: await configStore.getSecret('azure_openai_embedding_key') || '',
        azure_model: await configStore.getConfig('azure_openai_embedding_model') || 'text-embedding-3-small',
    };
}

function byteLength(content) {
    try { return Buffer.byteLength(String(content), 'utf8'); } catch (_) { return null; }
}

/** Local ingestion embeds with the configured model; the search service uses its own. */
const isLocalIngest = (azureParams, kbProvider) => !!azureParams.use_azure || kbProvider === 'local';

/**
 * Chunk + embed `content` for an existing documents row. Local dispatcher or
 * the search-service depending on org config. Throws on failure; the caller
 * decides whether the row is deleted (legacy) or marked 'error' (record mode).
 * @returns {Promise<number>} chunks created
 */
async function embedDocumentContent(tenantId, kbId, docId, content, { title, sourceUri, lang, pages = null }) {
    const azureParams = await getAzureIngestParams();
    const { resolveKbProvider } = require('./resolveProvider');
    const kbProvider = await resolveKbProvider();
    const useLocalIngest = isLocalIngest(azureParams, kbProvider);

    if (useLocalIngest) {
        // ── Local ingestion path ─────────────────────────────────────
        // Chunk + embed locally via the embedding dispatcher in
        // localKBIngest (configured provider → Azure → CPU). Bypasses
        // the external search-service entirely.
        log.info(`[KBHelpers] Embedding: local dispatcher (kb_provider=${kbProvider}${azureParams.use_azure ? ', use_azure=true' : ''})`);
        log.info(`[KBHelpers] Chunking + embedding ${content.length} chars locally`);
        try {
            const { ingestLocally } = require('./localKBIngest');
            // `pages` present, each chunk gets the page its text starts on and
            // a citation can say "p. 12". Only the local path can do this: the
            // search-service chunks on its own side and never sees the pages.
            const result = await ingestLocally(tenantId, kbId, docId, content, { title, sourceUri, lang, pages });
            return result.chunks_created || 0;
        } catch (localErr) {
            log.error('[KBHelpers] Local ingestion failed:', localErr.message);
            throw new Error(`Local ingestion failed: ${localErr.message}`);
        }
    }

    // ── Search-service path (non-Azure) ──────────────────────────
    log.info(`[KBHelpers] Embedding: Local vLLM (bge-m3) via search-service`);
    log.info(`[KBHelpers] Sending ${content.length} chars to search-service`);

    const ingestRes = await fetch(`${SEARCH_SERVICE_URL}/kb/ingest/json`, {
        method: 'POST',
        headers: getServiceHeaders(),
        body: JSON.stringify({
            tenant_id: tenantId,
            knowledge_base_id: kbId,
            document_id: docId,
            content,
            title,
            source_uri: sourceUri,
            lang,
            ...azureParams,
        }),
        signal: AbortSignal.timeout(120000)
    });

    if (!ingestRes.ok) {
        const err = await ingestRes.text();
        throw new Error(`Search-service ingestion failed: ${err}`);
    }
    const result = await ingestRes.json();
    return result.chunks_created || 0;
}

module.exports = { SEARCH_SERVICE_URL, simhash64, getAzureIngestParams, byteLength, isLocalIngest, embedDocumentContent };
