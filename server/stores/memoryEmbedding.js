// @typecheck
/**
 * stores/memoryEmbedding.js — embedding of memory rows: the provider -> CPU ->
 * GPU dispatch (getEmbedding), the deadline around it (embedOne), storing and
 * dropping a row's vectors, and re-indexing one row (indexMemory). Split out of
 * stores/memoryStore.js.
 *
 * Embedding dispatch (in order):
 *   1. Configured global embedding provider (preferred — same model used
 *      by KB / web-search inference)
 *   2. In-process CPU embedder (Xenova/multilingual-e5-small, MIT, 384-dim)
 *   3. Optional self-hosted GPU service via `EMBED_API_URL` (legacy path)
 *   4. Null — caller falls back to keyword retrieval
 *
 * Switching providers changes the vector dimension; existing memories
 * remain readable but won't rank against new embeddings (cosineSimilarity
 * returns 0 across mismatched dims). A re-embed migration is future work.
 */

const { run, getOne } = require('../db');
const { toV1BaseUrl } = require('../utils/azureUrl');
const log = require('../telemetry/log');
const { validateDim } = require('./memoryVectors');
const { dep } = require('./memoryDeps');
const memoryIndex = dep('memoryIndex');
const { resolveEmbedTarget } = dep('embedTarget');
const { resolveWriteContext, sealEmbedding, hydrateRows, PLAINTEXT_WRITE } = dep('memoryCrypto');

/** The store's schema-init memo, installed by stores/memoryStore (read per call). */
const initDB = () => dep('initDB')();

// Optional self-hosted GPU embedding service (legacy). Disabled when
// the env var is unset — admins relying on it must set it explicitly.
const EMBED_API_URL = process.env.EMBED_API_URL || null;
const EMBED_MODEL = process.env.EMBED_MODEL || 'Qwen/Qwen3-Embedding-4B';

/**
 * Get embedding vector for text. Tries (1) configured global provider,
 * then (2) in-process CPU embedder, then (3) optional self-hosted GPU
 * service. Returns the float array on success or null on full failure
 * so callers can degrade to keyword-only retrieval.
 *
 * @param {string} text
 * @param {{ kind?: 'query'|'passage', timeoutMs?: number }} [opts]
 *   `kind` is the e5 prefix of the CPU tier; `timeoutMs` bounds the provider
 *   call (the caller bounds the whole chain, see embedOne).
 */
async function getEmbedding(text, opts = {}) {
    if (!text) return null;
    const providerTimeout = opts.timeoutMs || 8000;

    // (1) Configured global embedding provider — OpenAI-compatible /v1/embeddings.
    try {
        const target = await resolveEmbedTarget();
        // Self-hosted runtimes have no API key — accept them keyless, the same
        // way core/embed/dispatch.js does, or every local embedding provider
        // silently degrades to the CPU embedder below.
        const { isLocalProviderType } = require('../core/providers/localModels');
        if (target?.endpoint && target?.modelId && (target.apiKey || isLocalProviderType(target.providerType))) {
            const root = target.endpoint.replace(/\/+$/, '');
            const isAzure = target.providerType === 'azure';
            // Azure v1 GA: no api-version, the deployment name goes in the body as `model`.
            const url = isAzure
                ? `${toV1BaseUrl(target.endpoint)}/embeddings`
                : (root.endsWith('/v1') ? `${root}/embeddings` : `${root}/v1/embeddings`);
            const headers = isAzure
                ? { 'Content-Type': 'application/json', 'api-key': target.apiKey }
                : {
                    'Content-Type': 'application/json',
                    ...(target.apiKey ? { Authorization: `Bearer ${target.apiKey}` } : {}),
                };
            const body = JSON.stringify({ model: target.modelId, input: [text] });
            const res = await fetch(url, { method: 'POST', headers, body, signal: AbortSignal.timeout(providerTimeout) });
            if (res.ok) {
                const data = /** @type {{ data?: Array<{ embedding?: number[] }> }} */ (await res.json());
                const vec = data?.data?.[0]?.embedding;
                if (Array.isArray(vec)) return vec;
            }
        }
    } catch (_) { /* try next tier */ }

    // (2) CPU embedder — in-process, no external call.
    try {
        const { cpuEmbed } = require('../core/embed/cpuEmbed');
        const vecs = await cpuEmbed([text], { kind: opts.kind || 'passage' });
        if (vecs.length > 0) return vecs[0];
    } catch (_) { /* try next tier */ }

    // (3) Legacy self-hosted GPU service (`EMBED_API_URL`).
    if (EMBED_API_URL) {
        try {
            const res = await fetch(EMBED_API_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model: EMBED_MODEL, input: [text] }),
                signal: AbortSignal.timeout(5000),
            });
            if (res.ok) {
                const data = /** @type {{ data?: Array<{ embedding?: number[] }> }} */ (await res.json());
                return data?.data?.[0]?.embedding || null;
            }
        } catch (_) { /* fall through */ }
    }

    return null;
}

/** Cosine similarity between two vectors. */
function cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;
    let dot = 0, magA = 0, magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    return denom === 0 ? 0 : dot / denom;
}

/**
 * Embed one text within a deadline. `{ vector, dim }` or null (no tier answered
 * in time, or the vector has an unusable length). The deadline bounds the WHOLE
 * provider -> CPU -> GPU chain: a cold CPU model can take a minute to load, and
 * the retrieval path must not wait for it. The chain keeps running in the
 * background, so the next call finds the model warm.
 *
 * @param {string} text
 * @param {{ kind?: 'query'|'passage', timeoutMs?: number }} [opts]
 */
async function embedOne(text, { kind = 'passage', timeoutMs = 30_000 } = {}) {
    if (!text) return null;
    let timer;
    try {
        const vector = await Promise.race([
            getEmbedding(text, { kind, timeoutMs }),
            new Promise((resolve) => { timer = setTimeout(() => resolve(null), timeoutMs); }),
        ]);
        return Array.isArray(vector) && validateDim(vector.length) ? { vector, dim: vector.length } : null;
    } catch (_) {
        return null;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Write a freshly computed vector for a row, in the row's own mode. A sealed
 * write puts it in `embedding_enc` only; a plaintext write fills the JSONB
 * column and, with pgvector, the typed `embedding_<dim>` column. One statement
 * for the shared columns; resets the embed-attempt bookkeeping.
 */
async function _storeVector(memoryId, vector, wctx) {
    const c = sealEmbedding(memoryId, vector, wctx);
    // With a typed column to fill, the attempt counter is reset by that write
    // (writeVector), so a row whose typed write keeps failing still reaches the
    // backfill's attempt ceiling instead of looping on paid embeds.
    const typed = !c.embedding_enc && memoryIndex.isPgvectorAvailable();
    const reset = typed ? '' : ', embed_attempts = 0, embed_failed_at = NULL';
    await run(`UPDATE user_memories SET embedding = $1, embedding_enc = $2, embedding_dim = $3${reset} WHERE id = $4`,
        [c.embedding, c.embedding_enc, c.embedding_dim, memoryId]);
    if (c.embedding_enc) {
        // Sealed: no plaintext index of any kind may survive on this row (it
        // may have been plaintext until this update).
        await memoryIndex.scrubSealedIndexes();
        return true;
    }
    return typed ? memoryIndex.writeVector(memoryId, vector) : true;
}

/**
 * Embed content and store the vector (fire-and-forget). When the row is sealed
 * the vector goes to `embedding_enc` and the plaintext JSONB column is NULLed:
 * an embedding can be inverted back toward its text, so it is content.
 *
 * A failed embed clears the vectors of the OLD text (they no longer describe
 * the row) and counts an attempt, so the backfill job picks the row up.
 */
async function embedAndStore(memoryId, content, wctx) {
    try {
        const embedded = await embedOne(content, { kind: 'passage' });
        if (embedded) {
            if (!(await _storeVector(memoryId, embedded.vector, wctx))) await memoryIndex.noteEmbedFailure(memoryId);
        } else {
            await _dropVectors(memoryId);
            await memoryIndex.noteEmbedFailure(memoryId);
        }
    } catch (e) {
        log.warn('[MemoryStore] Embedding failed for', memoryId, e.message);
    }
}

/** Forget every stored vector of a row (its text changed or was never embedded). */
async function _dropVectors(memoryId) {
    const typed = memoryIndex.vectorColumnNames().map(c => `, "${c}" = NULL`).join('');
    await run(`UPDATE user_memories SET embedding = NULL, embedding_enc = NULL, embedding_dim = NULL${typed} WHERE id = $1`, [memoryId]);
}

/**
 * (Re)build the vector of one existing row from its stored text, in whatever
 * mode the row is in: a sealed row is opened with its key and its new vector
 * is sealed again; a plaintext row gets the JSONB and typed vectors. Used by
 * the backfill job, which therefore never needs to know about encryption.
 *
 * @param {string} memoryId
 * @param {string} [content]  override of the stored text (plaintext callers)
 * @returns {Promise<{ ok: boolean, dim?: number }>}
 */
async function indexMemory(memoryId, content) {
    await initDB();
    const row = await getOne('SELECT * FROM user_memories WHERE id = $1', [memoryId]);
    if (!row) return { ok: false };
    try {
        const [m] = await hydrateRows([row]);
        const text = m && typeof m.content === 'string' ? m.content : null;
        if (!text) throw new Error('unreadable');
        const sealedRow = typeof row.content === 'string' && row.content.startsWith('{"_bfenc"');
        const ctx = await resolveWriteContext({ userId: row.user_id, projectId: row.project_id });
        // A sealed row stays sealed whatever the policy says now; it needs a key.
        const wctx = sealedRow ? { encrypt: true, keys: ctx.keys } : (row.embedding_enc ? ctx : PLAINTEXT_WRITE);
        if (wctx.encrypt && !wctx.keys) throw new Error('no key');
        const embedded = await embedOne(sealedRow ? text : (content || text), { kind: 'passage' });
        if (!embedded) throw new Error('no embedding');
        if (!(await _storeVector(memoryId, embedded.vector, wctx))) throw new Error('vector not stored');
        return { ok: true, dim: embedded.dim };
    } catch (e) {
        await memoryIndex.noteEmbedFailure(memoryId).catch(() => {});
        return { ok: false };
    }
}

module.exports = { getEmbedding, cosineSimilarity, embedOne, embedAndStore, indexMemory };
