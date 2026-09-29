#!/usr/bin/env node
/**
 * Migration: make the knowledge bases that org agents already read READABLE.
 *
 * ── WHY THIS RUNS AT ALL ────────────────────────────────────────────
 * K5 starts enforcing knowledge-base visibility at RETRIEVAL. Until now the
 * runtime never asked, so a base could be attached to an agent the whole
 * organisation talks to while being, on paper, an unpublished personal draft.
 * Those agents worked. The moment the filter turns on they stop working — and
 * from the outside that reads as "the agent forgot everything it knew", with
 * nothing in the reply to say why.
 *
 * So before the filter bites, the DATA is brought into line with what the
 * organisation has evidently already decided: a base an org agent reads is a
 * base that org may read. This is the one place that widens access on purpose,
 * which is why every row it touches gets a version snapshot.
 *
 * ── TWO BRANCHES, AND THE SECOND ONE IS THE SHARP ONE ───────────────
 * (a) The base is IN the agent's organisation and simply unpublished.
 *     → `setPublished(id, true, <union of the agents' shared_groups>)`.
 *     Reason `visibility_backfill`. The groups are a UNION across every org
 *     agent that reads it: the audience the base already had, not a widening
 *     to the whole organisation. An agent published to everyone contributes an
 *     empty group list, which correctly means "no restriction".
 *
 * (b) The base has `organization_id IS NULL` — the owner's personal base,
 *     attached to an org agent. This is legal today (routes/agents/crud.js
 *     accepts a KB owned by the agent owner) and it is NOT publishable:
 *     `detail.js` refuses to publish a base with no organisation, and
 *     `canUserAccessKB` rejects non-owners before `is_published` is ever read.
 *     Calling `setPublished` on it would flip the flag and change NOTHING,
 *     which is the worst outcome: a migration that reports success and leaves
 *     every colleague's answer empty.
 *     → `UPDATE knowledge_bases SET organization_id = <the agent's org>` and
 *     THEN publish. Reason `visibility_backfill_adopt`.
 *
 *     Branch (b) has a consequence worth stating in the pull request rather
 *     than in a log line: the base stops being personal. Org admins gain read
 *     access to it, and `manage_knowledge` holders gain the ability to edit
 *     and delete it. That is a real transfer, and it is the only way for the
 *     agent to keep working — the alternative is that the agent silently
 *     stops answering from it. `--dry-run` reports the two branches
 *     separately, per agent, so the counts can be read off a production copy
 *     and put in the PR before anything is written.
 *
 * ── WHAT IT NEVER TOUCHES ───────────────────────────────────────────
 *   • A base already published — nothing to do.
 *   • A base in a DIFFERENT organisation from the agent — that is the
 *     cross-org leak the link-time check refuses; publishing it would make the
 *     leak permanent.
 *   • A system base — public reference text, no owner, no organisation.
 *   • An agent with no organisation — a personal agent reading its owner's
 *     personal base is exactly right and needs no change.
 *
 * Idempotent: a second run finds nothing left unpublished and writes nothing.
 *
 *   node server/migrations/publish-kbs-linked-to-org-agents.js --dry-run
 *   node server/migrations/publish-kbs-linked-to-org-agents.js
 */

const { pool } = require('../db');

/** Agents that belong to an organisation and name at least one knowledge base. */
async function orgAgentsWithKbs(db) {
    const r = await db.query(
        `SELECT id, name, owner_id, organization_id, shared_groups, config
           FROM agents
          WHERE organization_id IS NOT NULL AND organization_id <> ''
            AND COALESCE(jsonb_array_length(config::jsonb -> 'knowledge_base_ids'), 0) > 0`,
    );
    return r.rows || [];
}

function jsonArray(value) {
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(value || '[]');
        return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
        return [];
    }
}

function kbIdsOf(agent) {
    let config = agent.config;
    if (typeof config === 'string') {
        try { config = JSON.parse(config); } catch (_) { return []; }
    }
    return jsonArray(config?.knowledge_base_ids).filter(v => typeof v === 'string' && v);
}

/**
 * Work out what each knowledge base needs, without writing anything.
 *
 * @returns {Promise<{publish: Array, adopt: Array, skipped: Array}>}
 *   `publish` = branch (a), `adopt` = branch (b). Each entry names the base,
 *   the organisation, the group union and which agents pointed at it, so the
 *   dry run is readable per agent as well as per base.
 */
async function plan({ db = pool } = {}) {
    const agents = await orgAgentsWithKbs(db);
    const byKb = new Map();

    for (const agent of agents) {
        for (const kbId of kbIdsOf(agent)) {
            if (!byKb.has(kbId)) byKb.set(kbId, []);
            byKb.get(kbId).push(agent);
        }
    }

    const publish = [];
    const adopt = [];
    const skipped = [];

    for (const [kbId, agentsUsing] of byKb) {
        const r = await db.query('SELECT * FROM knowledge_bases WHERE id = $1', [kbId]);
        const kb = r.rows[0];
        if (!kb) { skipped.push({ kbId, reason: 'not_found' }); continue; }
        if (kb.source_kind === 'system_managed') { skipped.push({ kbId, reason: 'system' }); continue; }
        if (kb.is_published && kb.organization_id) { skipped.push({ kbId, reason: 'already_published' }); continue; }

        // The agents whose organisation this base could belong to. An agent in
        // a different org from an already-org-owned base is the cross-org case
        // and is left alone.
        const candidates = kb.organization_id
            ? agentsUsing.filter(a => a.organization_id === kb.organization_id)
            : agentsUsing.filter(a => a.owner_id === kb.tenant_id);

        if (candidates.length === 0) {
            skipped.push({ kbId, reason: kb.organization_id ? 'other_org' : 'not_owner_agent' });
            continue;
        }

        // The audience the base already had: the union across the agents that
        // read it. One agent published to the whole organisation (no groups)
        // means no restriction, so an empty list anywhere collapses the union.
        const groupLists = candidates.map(a => jsonArray(a.shared_groups));
        const sharedGroups = groupLists.some(g => g.length === 0)
            ? []
            : [...new Set(groupLists.flat())];

        const entry = {
            kbId,
            kbName: kb.name || null,
            organizationId: kb.organization_id || candidates[0].organization_id,
            sharedGroups,
            agents: candidates.map(a => ({ id: a.id, name: a.name, organizationId: a.organization_id })),
        };
        if (kb.organization_id) publish.push(entry);
        else adopt.push(entry);
    }

    return { publish, adopt, skipped };
}

/**
 * Apply the plan.
 *
 * Per row, never in one transaction: this touches a base at a time and a
 * failure on one must not roll back the rest — a half-migrated install where
 * the migration can simply be re-run is better than an all-or-nothing that
 * leaves every agent broken because one base had a problem.
 */
async function up({ db = pool, dryRun = false, log = console.log } = {}) {
    const { publish, adopt, skipped } = await plan({ db });

    if (dryRun) {
        log(`\n(a) publish in place — ${publish.length} knowledge base(s)`);
        for (const e of publish) {
            log(`    ${e.kbId}  ${e.kbName || '(unnamed)'}  groups=${JSON.stringify(e.sharedGroups)}`);
            for (const a of e.agents) log(`        ← agent ${a.id} ${a.name || ''}`);
        }
        log(`\n(b) adopt into the organisation, THEN publish — ${adopt.length} knowledge base(s)`);
        log('    These stop being personal: org admins gain read access and');
        log('    manage_knowledge holders gain edit/delete.');
        for (const e of adopt) {
            log(`    ${e.kbId}  ${e.kbName || '(unnamed)'}  → org ${e.organizationId}  groups=${JSON.stringify(e.sharedGroups)}`);
            for (const a of e.agents) log(`        ← agent ${a.id} ${a.name || ''}`);
        }
        log(`\n    skipped: ${skipped.length} (${summarise(skipped)})\n`);
        return { published: 0, adopted: 0, failed: 0, plan: { publish, adopt, skipped } };
    }

    const kbStore = require('../stores/knowledgeBases');
    let published = 0;
    let adopted = 0;
    let failed = 0;

    for (const e of publish) {
        try {
            // The snapshot goes FIRST: it records the state being left behind,
            // which is what makes this reversible by hand.
            await kbStore.snapshotKBVersion(e.kbId, null, 'visibility_backfill');
            await kbStore.setPublished(e.kbId, true, e.sharedGroups);
            published += 1;
        } catch (err) {
            console.warn(`[Migration] ${e.kbId} could not be published: ${err.message}`);
            failed += 1;
        }
    }

    for (const e of adopt) {
        try {
            await kbStore.snapshotKBVersion(e.kbId, null, 'visibility_backfill_adopt');
            // setPublished alone would flip the flag and change nothing: a base
            // with no organisation is refused by canUserAccessKB before
            // is_published is ever read. The organisation has to land first.
            await db.query(
                `UPDATE knowledge_bases SET organization_id = $2, updated_at = now()
                  WHERE id = $1 AND organization_id IS NULL`,
                [e.kbId, e.organizationId],
            );
            await kbStore.setPublished(e.kbId, true, e.sharedGroups);
            adopted += 1;
        } catch (err) {
            console.warn(`[Migration] ${e.kbId} could not be adopted: ${err.message}`);
            failed += 1;
        }
    }

    return { published, adopted, failed, skipped: skipped.length };
}

function summarise(skipped) {
    const counts = {};
    for (const s of skipped) counts[s.reason] = (counts[s.reason] || 0) + 1;
    return Object.entries(counts).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none';
}

module.exports = { up, plan };

if (require.main === module) {
    const dryRun = process.argv.includes('--dry-run');
    up({ dryRun })
        .then((r) => {
            if (!dryRun) console.log(`[Migration] published ${r.published}, adopted ${r.adopted}, failed ${r.failed}, skipped ${r.skipped}.`);
            process.exit(0);
        })
        .catch((e) => { console.error('[Migration] failed:', e.message); process.exit(1); });
}
