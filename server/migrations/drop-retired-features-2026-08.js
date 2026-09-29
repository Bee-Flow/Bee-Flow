#!/usr/bin/env node
/**
 * Migration: drop the schema owned by four retired product verticals.
 *
 * Retired 2026-08: the ITIL Ticket Assistant, Lead Studio, Tests Studio and
 * Legal Studio (including the Dutch legal sources). Their code, routes, stores
 * and licence gates are gone; this reclaims the tables they owned so a
 * `\dt` on an upgraded install matches a fresh one.
 *
 * Also removes the rows those features wrote into tables that SURVIVE:
 *   • notebooks rows of type 'legal_matter' — a legal matter was a notebook,
 *     so the dossiers live in a table Notebooks still uses. Erased via
 *     notebookCascade: a bare DELETE would only cascade sources/versions,
 *     leaving the encrypted chat (notebook_conversations has no FK), the
 *     uploaded blobs in object storage and the derived chunks/embeddings
 *     behind as orphans no surviving code path could ever delete again.
 *   • the retired capability ids inside organizations.beta_features, so an
 *     org's beta list stops naming features that no longer resolve.
 *
 * The consent ledger (consent_acceptances) is deliberately NOT touched: the
 * optional consents still use it (marketing, and the Art. 9(2)(a) biometric
 * consent voiceprint enrolment requires), as does the Stripe checkout
 * right-of-withdrawal waiver. Its historical rows are legal evidence and are
 * retained even where the document they reference is retired.
 *
 * Idempotent — DROP TABLE IF EXISTS, and the DELETE/UPDATE statements match 0
 * rows on a re-run. Auto-runs from server boot (server/index.js). Manual:
 *   node server/migrations/drop-retired-features-2026-08.js
 */

const { run, getAll } = require('../db');

// Order matters only where a FK points at a table in the same batch; CASCADE
// covers the rest (indexes and dependent constraints go with the table).
const DROP_TABLES = [
    // ── ITIL Ticket Assistant ──
    'ticket_assistant_sync_log',
    'ticket_assistant_connections',
    // ── Lead Studio (CRM tables first — they FK onto leads/campaigns) ──
    'lead_tasks',
    'lead_activities',
    'lead_contacts',
    'lead_generation_jobs',
    'leads',
    'lead_campaigns',
    // ── Tests Studio ──
    'test_run_artifacts',
    'test_run_jobs',
    'test_runs',
    'test_suite_versions',
    'test_suites',
    // ── Legal Studio ──
    'legal_citations',
];

// Config keys the retired features owned (configStore is a key/value table).
const DROP_CONFIG_KEYS = [
    'ticket_assistant_tier_config',
    'email_kb_tier_config',
    'legal_doc_overrides',
    'kvk_api_key',
    'hunter_api_key',
    'apollo_api_key',
    'apify_token',
    'apify_linkedin_actor',
];

// Beta/capability ids that no longer resolve to anything.
const RETIRED_CAPABILITY_IDS = [
    'itil_ticket_assistant',
    'email_knowledge_base',
    'lead_studio',
    'playwright_tests',
    'dutch_legal_sources',
];

async function up() {
    // 1) Legal matters were notebooks. Erase each one through notebookCascade
    //    (blobs, chunks/embeddings, encrypted chat, notebook-owned KBs and the
    //    row itself) before dropping legal_citations, so the FK cascade has
    //    nothing left to chase. Per-matter and best-effort: a matter whose
    //    cleanup fails keeps its row and is retried on the next boot instead
    //    of being deleted with its bytes left behind.
    let matters = 0;
    try {
        const rows = await getAll(`SELECT id, user_id FROM notebooks WHERE type = 'legal_matter'`);
        if (rows?.length) {
            const { deleteNotebookCascade } = require('../core/kb/notebookCascade');
            for (const row of rows) {
                try {
                    const res = await deleteNotebookCascade(row.id, row.user_id);
                    if (res?.deleted) matters++;
                } catch (e) {
                    console.warn(`[drop-retired-features] cascade for legal matter ${row.id} failed:`, e.message);
                }
            }
        }
    } catch (e) {
        // A fresh install may not have the table yet — nothing to clean.
        if (!/does not exist/i.test(e.message)) {
            console.warn('[drop-retired-features] legal_matter cleanup skipped:', e.message);
        }
    }

    // 2) Drop the feature-owned tables. Probe first so a re-run reports 0
    //    rather than claiming it dropped tables that were already gone.
    const dropped = [];
    for (const table of DROP_TABLES) {
        try {
            const existed = await getAll(`SELECT to_regclass($1) AS oid`, [`public.${table}`]);
            if (!existed?.[0]?.oid) continue;
            await run(`DROP TABLE IF EXISTS ${table} CASCADE`);
            dropped.push(table);
        } catch (e) {
            console.warn(`[drop-retired-features] could not drop ${table}:`, e.message);
        }
    }

    // 3) Drop the feature-owned config rows. Go through configStore so cached
    //    values and the cross-replica invalidation notice are handled too. The
    //    Lead Studio provider keys also exist as per-org `org_<id>_*` secrets,
    //    so sweep those by suffix rather than listing every org.
    const configStore = require('../stores/configStore');
    let configRows = 0;
    for (const key of DROP_CONFIG_KEYS) {
        try { if (await configStore.deleteConfig(key)) configRows++; } catch (_) { /* absent */ }
    }
    try {
        const orgScoped = await getAll(
            `SELECT key FROM config WHERE key LIKE 'org\\_%' AND (${
                DROP_CONFIG_KEYS.map((_, i) => `key LIKE $${i + 1}`).join(' OR ')
            })`,
            DROP_CONFIG_KEYS.map(k => `%_${k}`)
        );
        for (const row of orgScoped || []) {
            try { if (await configStore.deleteConfig(row.key)) configRows++; } catch (_) { /* absent */ }
        }
    } catch (e) {
        console.warn('[drop-retired-features] org-scoped config sweep skipped:', e.message);
    }

    // 4) Strip retired ids from each org's beta_features list. Stored as JSON
    //    text, so filter in JS rather than guessing at a JSON operator.
    let orgsTouched = 0;
    try {
        const rows = await getAll(`SELECT id, beta_features FROM organizations WHERE beta_features IS NOT NULL`);
        for (const row of rows || []) {
            let list;
            try { list = JSON.parse(row.beta_features); } catch (_) { continue; }
            if (!Array.isArray(list)) continue;
            const kept = list.filter(f => !RETIRED_CAPABILITY_IDS.includes(f));
            if (kept.length === list.length) continue;
            await run(`UPDATE organizations SET beta_features = $1 WHERE id = $2`, [JSON.stringify(kept), row.id]);
            orgsTouched++;
        }
    } catch (e) {
        console.warn('[drop-retired-features] beta_features cleanup skipped:', e.message);
    }

    if (matters || dropped.length || configRows || orgsTouched) {
        console.log(`[drop-retired-features] tables=${dropped.length} legal_matters=${matters} config=${configRows} orgs=${orgsTouched}`);
    }
    return { tables: dropped.length, matters, config: configRows, orgs: orgsTouched };
}

module.exports = { up };

if (require.main === module) {
    up().then(() => process.exit(0)).catch(err => {
        console.error(err);
        process.exit(1);
    });
}
