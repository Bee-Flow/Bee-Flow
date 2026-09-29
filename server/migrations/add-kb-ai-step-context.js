#!/usr/bin/env node
/**
 * Migration: `ai_step` joins the knowledge-base usage contexts.
 *
 * `usage_contexts` decides which pickers a knowledge base appears in. It shipped
 * with three values — 'agent', 'direct_chat', 'webpage' — and a routine's AI
 * step was silently covered by 'agent', because nothing ever asked.
 *
 * K5 makes the link-time check real: an ai_step may only name a base whose
 * contexts include 'ai_step'. Introducing the value WITHOUT this backfill would
 * make every existing routine fail its next activation, on a base its author
 * never changed — a migration that breaks running work is worse than the hole
 * it closes.
 *
 * So every base that may already be attached to an agent gains 'ai_step' too.
 * That is not a widening: an ai_step and an agent perform the SAME read, under
 * the same person, and the retrieval filter (core/kb/kbVisibility) is what
 * decides who may see the content either way. The contexts choose surfaces, not
 * audiences.
 *
 * Deliberately NOT backfilled: bases carrying only 'webpage'. Those are the
 * auto-created per-webpage/notebook bases (`source_kind` webpage_auto /
 * notebook_auto), scoped to one page by design.
 *
 * Idempotent: the UPDATE is guarded on the value being absent, so a re-run
 * touches nothing. Auto-runs from `stores/knowledgeBases.js initDB()`.
 *
 *   node server/migrations/add-kb-ai-step-context.js
 */

const { exec } = require('../db');

async function up() {
    // `usage_contexts` is jsonb holding an array of strings; `?` asks whether
    // the array contains one.
    await exec(`
        UPDATE knowledge_bases
           SET usage_contexts = usage_contexts || '["ai_step"]'::jsonb,
               updated_at = now()
         WHERE usage_contexts ? 'agent'
           AND NOT (usage_contexts ? 'ai_step')
    `);

    // A row whose usage_contexts is NULL predates the column default. It was
    // usable everywhere, so it stays usable everywhere.
    await exec(`
        UPDATE knowledge_bases
           SET usage_contexts = '["agent","direct_chat","ai_step"]'::jsonb,
               updated_at = now()
         WHERE usage_contexts IS NULL
    `);
}

module.exports = { up };

if (require.main === module) {
    up()
        .then(() => { console.log('[Migration] ai_step usage-context backfill complete.'); process.exit(0); })
        .catch((e) => { console.error('[Migration] failed:', e.message); process.exit(1); });
}
