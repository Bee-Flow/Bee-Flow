// @typecheck
/**
 * Find — or create — the `kb_sources` row an ingest hangs its document off.
 *
 * ── WHY IT IS NOT IN routes/ ANY MORE ───────────────────────────────
 * It lived in `routes/knowledgeBases/shared.js`, which meant
 * `integrations/kbIngestTools.js` — a tool the agent runtime loads, nowhere
 * near an HTTP request — had to require a ROUTE module to attach a source to a
 * knowledge base. Attaching a source is what an ingest does, not what the HTTP
 * layer does, so it belongs beside the other source machinery. The KB routes
 * still import it from `shared.js`, which re-exports it.
 */

/**
 * Find — or create — the kb_sources row a legacy ingest route should hang its
 * document off, so `POST /:id/ingest/text|file|url`, the sitemap walk, the n8n
 * import and the `knowledge_base_ingest` routine action all produce the same
 * source model the new API exposes.
 *
 * NEVER throws: the source is bookkeeping, the ingest is the product. A KB
 * whose kb_sources table is not there yet (or a lost race on the find) must
 * still accept the document, so failures resolve to `null` and the caller
 * simply ingests without a sourceId.
 *
 * The find is jsonb containment of `configMatch` in `config` (KbSourcesStore.findOne), which is what
 * makes "the upload source of this KB" and "the webpage source for THIS url"
 * stable across requests. Two simultaneous first-ingests can still create two
 * rows; findOne returns the oldest afterwards, so the duplicate is cosmetic.
 *
 * @param {string} kbId
 * @param {string} kind — a KbSourcesStore.SOURCE_KINDS value
 * @param {object} [opts]
 * @param {string} [opts.name]
 * @param {object} [opts.config] - stored on create
 * @param {object|null} [opts.configMatch] - JSON subset that identifies "the same" source
 * @param {string|null} [opts.createdBy]
 * @returns {Promise<object|null>} the mapped source row, or null when unavailable
 */
const log = require('../../../telemetry/log');
async function ensureKbSource(kbId, kind, { name = '', config = {}, configMatch = null, createdBy = null } = {}) {
    if (!kbId || !kind) return null;
    try {
        const kbSourcesStore = require('../../../stores/kbSources');
        const existing = await kbSourcesStore.findOne(kbId, kind, { configMatch });
        if (existing) return existing;
        return await kbSourcesStore.create({ knowledgeBaseId: kbId, kind, name, config, createdBy });
    } catch (e) {
        log.warn(`[KB] Could not attach a '${kind}' source to KB ${kbId}: ${e.message}`);
        return null;
    }
}

module.exports = { ensureKbSource };
