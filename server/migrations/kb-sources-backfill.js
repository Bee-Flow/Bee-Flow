#!/usr/bin/env node
/**
 * Migration: give every existing knowledge-base document a SOURCE (K1).
 *
 * Before the source model a `documents` row only knew its `source_type`
 * ('upload' | 'text' | 'web' | 'n8n' | 'support_ticket' | 'notebook_source' |
 * 'webpage_source' | …). The Sources tab needs the other half: *which* upload
 * bucket, *which* page, *which* importer. This walks the existing rows and
 * builds the synthetic sources that describe what already happened:
 *
 *   upload          → ONE `upload` source per KB, "Uploaded files"
 *   text            → ONE `text` source per document (named after its title)
 *   web             → ONE `webpage` source per unique URL; several pages of the
 *                     same origin (a sitemap walk) are bundled into ONE source
 *                     for that origin, with `config.crawl.maxPages`
 *   everything else → ONE `legacy` source per (KB, source_type), carrying the
 *                     original kind in `config.sourceType`
 *
 * The find-or-create keys (`config @> …`) are deliberately the SAME ones the
 * live wrapper routes use (routes/knowledgeBases/shared.js ensureKbSource), so
 * a document ingested tomorrow lands on the source this migration created
 * today instead of next to it.
 *
 * It also fixes two columns the model needs: `status` becomes 'duplicate'
 * wherever `duplicate_of` is filled, and `created_by` falls back to the row's
 * `tenant_id` (the owner) where it is unknown.
 *
 * Second stage — usage contexts. 'ai_step' is a new context
 * (routes/knowledgeBases/shared.js VALID_USAGE_CONTEXTS). Every KB that is
 * offered to agents also becomes selectable in an automation's ai-step, AND
 * every KB id that an automation ALREADY references gets it whether or not it
 * was ever offered to agents — otherwise a routine whose owner once switched
 * "Agents" off silently loses its knowledge base. That second set is logged,
 * because it is the interesting one.
 *
 * Idempotent. Only rows with `source_id IS NULL` are assigned, sources are
 * found before they are created, and both context updates skip KBs that
 * already carry 'ai_step'. Safe to re-run; safe to run on a live install.
 *
 * NOT wired into boot: it is a full scan of `documents` and belongs in a
 * deploy step, not in every replica's startup path.
 *
 *   node server/migrations/kb-sources-backfill.js --dry-run   # writes nothing
 *   node server/migrations/kb-sources-backfill.js
 */

const DEFAULT_UPLOAD_NAME = 'Uploaded files';
const DEFAULT_TEXT_NAME = 'Text snippet';

/** documents.source_type values that get a first-class source kind. */
const NATIVE_KINDS = Object.freeze({ upload: 'upload', text: 'text', web: 'webpage' });

function truncate(value, max = 200) {
    const s = String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) : s;
}

function originOf(url) {
    try { return new URL(String(url)).origin; } catch (_) { return null; }
}

function hostOf(url) {
    try { return new URL(String(url)).hostname; } catch (_) { return null; }
}

/**
 * Decide which sources a KB's unassigned documents need — pure, so the shape
 * of the backfill can be asserted without a database.
 *
 * @param {Array<{id:string,title:string,source_type:string,source_uri:string}>} docs
 * @returns {Array<{kind:string,name:string,config:object,configMatch:object,documentIds:string[]}>}
 */
function planSourcesForKb(docs) {
    const plan = [];
    const uploads = [];
    const webByKey = new Map();   // key → { config, configMatch, name, ids }
    const legacyByType = new Map(); // source_type → ids

    for (const doc of docs || []) {
        const sourceType = String(doc.source_type || 'text');
        const kind = NATIVE_KINDS[sourceType];

        if (kind === 'upload') {
            uploads.push(doc.id);
            continue;
        }

        if (kind === 'text') {
            const name = truncate(doc.title) || DEFAULT_TEXT_NAME;
            plan.push({
                kind: 'text',
                name,
                // documentId keys the source to THIS row (so a re-run finds it
                // again); title is what the wrapper route matches on, and jsonb
                // containment makes `{title}` match `{title, documentId}`.
                config: { title: name, documentId: doc.id },
                configMatch: { documentId: doc.id },
                documentIds: [doc.id],
            });
            continue;
        }

        if (kind === 'webpage') {
            const url = doc.source_uri || null;
            const origin = url ? originOf(url) : null;
            // Group per origin first; a group of one collapses to that page's
            // own URL below, so a single ingested page keeps its exact address.
            const key = origin || `url:${url || doc.id}`;
            if (!webByKey.has(key)) {
                webByKey.set(key, { origin, urls: [], titles: [], ids: [] });
            }
            const bucket = webByKey.get(key);
            bucket.urls.push(url);
            bucket.titles.push(doc.title);
            bucket.ids.push(doc.id);
            continue;
        }

        if (!legacyByType.has(sourceType)) legacyByType.set(sourceType, []);
        legacyByType.get(sourceType).push(doc.id);
    }

    if (uploads.length > 0) {
        plan.push({
            kind: 'upload',
            name: DEFAULT_UPLOAD_NAME,
            config: {},
            // An empty match means "any upload source of this KB" — there is
            // exactly one by construction, and `config @> '{}'` finds it.
            configMatch: {},
            documentIds: uploads,
        });
    }

    for (const bucket of webByKey.values()) {
        if (bucket.ids.length === 1) {
            const url = bucket.urls[0];
            const name = truncate(bucket.titles[0]) || hostOf(url) || truncate(url) || 'Web page';
            plan.push({
                kind: 'webpage',
                name,
                config: url ? { url } : {},
                configMatch: url ? { url } : {},
                documentIds: bucket.ids,
            });
            continue;
        }
        // More than one page from the same origin: that was a crawl.
        const origin = bucket.origin;
        plan.push({
            kind: 'webpage',
            name: hostOf(origin) || truncate(origin) || 'Website',
            config: { url: origin, crawl: { maxPages: bucket.ids.length } },
            configMatch: { url: origin },
            documentIds: bucket.ids,
        });
    }

    for (const [sourceType, ids] of legacyByType.entries()) {
        plan.push({
            kind: 'legacy',
            name: sourceType,
            config: { sourceType },
            configMatch: { sourceType },
            documentIds: ids,
        });
    }

    return plan;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] — report what would happen, write nothing
 * @param {object}  [opts.db] — { getOne, getAll, run } (injectable for tests)
 * @param {function} [opts.log=console.log]
 */
async function up({ dryRun = false, db = require('../db'), log = console.log } = {}) {
    const tag = `[Migration] kb-sources-backfill${dryRun ? ' (dry-run)' : ''}`;
    const stats = {
        knowledgeBases: 0, sourcesCreated: 0, sourcesReused: 0, documentsAssigned: 0,
        duplicatesMarked: 0, createdByFilled: 0, aiStepFromAgent: 0, aiStepFromAutomations: 0,
        automationKbIds: [],
    };

    // Preflight: the K1 schema has to be there. A dry run must not create it.
    const hasColumn = await db.getOne(
        `SELECT 1 AS ok FROM information_schema.columns
          WHERE table_name = 'documents' AND column_name = 'source_id'`,
    );
    const hasTable = await db.getOne(`SELECT to_regclass('public.kb_sources') AS t`);
    if (!hasColumn || !hasTable || !hasTable.t) {
        log(`${tag}: kb_sources / documents.source_id not present yet — start the server once (stores/knowledgeBases.initDB) and re-run.`);
        return stats;
    }

    // ── Stage 1: sources ────────────────────────────────────────────
    const kbRows = await db.getAll(
        `SELECT d.knowledge_base_id AS kb_id, COUNT(*)::int AS pending, MAX(kb.tenant_id) AS tenant_id
           FROM documents d
           JOIN knowledge_bases kb ON kb.id = d.knowledge_base_id
          WHERE d.source_id IS NULL
          GROUP BY d.knowledge_base_id
          ORDER BY d.knowledge_base_id`,
    );

    for (const kbRow of kbRows || []) {
        const kbId = kbRow.kb_id;
        stats.knowledgeBases++;
        const docs = await db.getAll(
            `SELECT id, title, source_type, source_uri
               FROM documents
              WHERE knowledge_base_id = $1 AND source_id IS NULL
              ORDER BY created_at ASC, id ASC`,
            [kbId],
        );
        const plan = planSourcesForKb(docs);
        let created = 0;
        let reused = 0;
        let assigned = 0;

        for (const entry of plan) {
            let sourceId = null;
            const found = await db.getOne(
                `SELECT id FROM kb_sources
                  WHERE knowledge_base_id = $1 AND kind = $2 AND config @> $3::jsonb
                  ORDER BY created_at ASC LIMIT 1`,
                [kbId, entry.kind, JSON.stringify(entry.configMatch || {})],
            );
            if (found) {
                sourceId = found.id;
                reused++;
            } else if (!dryRun) {
                const inserted = await db.getOne(
                    `INSERT INTO kb_sources (knowledge_base_id, kind, name, config, refresh_mode, created_by)
                     VALUES ($1, $2, $3, $4::jsonb, 'manual', $5)
                     RETURNING id`,
                    [kbId, entry.kind, truncate(entry.name), JSON.stringify(entry.config || {}), kbRow.tenant_id || null],
                );
                sourceId = inserted ? inserted.id : null;
                created++;
            } else {
                created++;
            }

            if (!dryRun && sourceId) {
                const res = await db.run(
                    `UPDATE documents SET source_id = $1, updated_at = now()
                      WHERE id = ANY($2::uuid[]) AND source_id IS NULL`,
                    [sourceId, entry.documentIds],
                );
                assigned += (res && res.rowCount) || 0;
            } else {
                assigned += entry.documentIds.length;
            }
        }

        stats.sourcesCreated += created;
        stats.sourcesReused += reused;
        stats.documentsAssigned += assigned;
        log(`${tag}: KB ${kbId} — ${docs.length} document${docs.length === 1 ? '' : 's'} → ${plan.length} source${plan.length === 1 ? '' : 's'} (${created} new, ${reused} existing), ${assigned} assigned`);
    }

    // ── Stage 2: the two columns the model reads ────────────────────
    if (dryRun) {
        const dup = await db.getOne(
            `SELECT COUNT(*)::int AS n FROM documents WHERE duplicate_of IS NOT NULL AND status = 'processed'`,
        );
        stats.duplicatesMarked = Number(dup && dup.n) || 0;
        const cb = await db.getOne(
            `SELECT COUNT(*)::int AS n FROM documents WHERE created_by IS NULL AND tenant_id IS NOT NULL`,
        );
        stats.createdByFilled = Number(cb && cb.n) || 0;
    } else {
        const dup = await db.run(
            `UPDATE documents SET status = 'duplicate', updated_at = now()
              WHERE duplicate_of IS NOT NULL AND status = 'processed'`,
        );
        stats.duplicatesMarked = (dup && dup.rowCount) || 0;
        const cb = await db.run(
            `UPDATE documents SET created_by = tenant_id, updated_at = now()
              WHERE created_by IS NULL AND tenant_id IS NOT NULL`,
        );
        stats.createdByFilled = (cb && cb.rowCount) || 0;
    }

    // ── Stage 3: usage_contexts gains 'ai_step' ─────────────────────
    const AGENT_TO_AI_STEP_WHERE = `
             WHERE COALESCE(usage_contexts, '[]'::jsonb) ? 'agent'
               AND NOT (COALESCE(usage_contexts, '[]'::jsonb) ? 'ai_step')`;
    if (dryRun) {
        const r = await db.getOne(`SELECT COUNT(*)::int AS n FROM knowledge_bases ${AGENT_TO_AI_STEP_WHERE}`);
        stats.aiStepFromAgent = Number(r && r.n) || 0;
    } else {
        const r = await db.run(
            `UPDATE knowledge_bases
                SET usage_contexts = COALESCE(usage_contexts, '[]'::jsonb) || '["ai_step"]'::jsonb
             ${AGENT_TO_AI_STEP_WHERE}`,
        );
        stats.aiStepFromAgent = (r && r.rowCount) || 0;
    }

    // Every KB an automation actually points at, whether or not it was ever
    // offered to agents. Same scan kbUsage does: any `knowledgeBaseIds` array,
    // at any depth of the definition.
    try {
        const rows = await db.getAll(
            `SELECT DISTINCT (x #>> '{}') AS kb_id
               FROM automations a,
                    LATERAL jsonb_path_query(a.definition_json, '$.**.knowledgeBaseIds[*]') AS x`,
        );
        const ids = Array.from(new Set((rows || [])
            .map(r => (r && r.kb_id ? String(r.kb_id) : null))
            .filter(id => id && /^[0-9a-f-]{36}$/i.test(id))));
        stats.automationKbIds = ids;
        if (ids.length > 0) {
            if (dryRun) {
                const r = await db.getOne(
                    `SELECT COUNT(*)::int AS n FROM knowledge_bases
                      WHERE id = ANY($1::uuid[])
                        AND NOT (COALESCE(usage_contexts, '[]'::jsonb) ? 'ai_step')`,
                    [ids],
                );
                stats.aiStepFromAutomations = Number(r && r.n) || 0;
            } else {
                const r = await db.run(
                    `UPDATE knowledge_bases
                        SET usage_contexts = COALESCE(usage_contexts, '[]'::jsonb) || '["ai_step"]'::jsonb
                      WHERE id = ANY($1::uuid[])
                        AND NOT (COALESCE(usage_contexts, '[]'::jsonb) ? 'ai_step')`,
                    [ids],
                );
                stats.aiStepFromAutomations = (r && r.rowCount) || 0;
            }
            // Logged on purpose: these are the KBs a routine depends on that
            // the agent context did not already cover.
            log(`${tag}: automations reference ${ids.length} knowledge base${ids.length === 1 ? '' : 's'} [${ids.join(', ')}] — ${stats.aiStepFromAutomations} gained 'ai_step'`);
        }
    } catch (e) {
        log(`${tag}: automations scan skipped (${e.message})`);
    }

    log(`${tag}: ${stats.knowledgeBases} knowledge base(s), ${stats.sourcesCreated} source(s) created, ${stats.sourcesReused} reused, ${stats.documentsAssigned} document(s) assigned, ${stats.duplicatesMarked} marked duplicate, ${stats.createdByFilled} created_by filled, ${stats.aiStepFromAgent + stats.aiStepFromAutomations} KB(s) gained 'ai_step'`);
    return stats;
}

module.exports = { up, planSourcesForKb };

if (require.main === module) {
    const dryRun = process.argv.includes('--dry-run');
    up({ dryRun }).then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
