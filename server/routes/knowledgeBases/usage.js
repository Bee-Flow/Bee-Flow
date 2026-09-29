/**
 * Knowledge Bases — who uses them.
 *
 *   GET /:id/usage        the Used-by tab, and the delete confirmation
 *   GET /usage-summary    the overview's per-base pills
 *   GET /suggestions      "this base looks like it belongs to that agent"
 *
 * Mounted BEFORE `detail`, because `/usage-summary` and `/suggestions` are
 * literal paths that `GET /:id` would otherwise swallow — the same ordering
 * rule `/categories` and `/system` already live under.
 *
 * ── AUTHORISATION IS THE READ RIGHT, NOT THE MANAGE RIGHT ───────────
 * Seeing what depends on a knowledge base tells you the NAMES of agents,
 * routines and apps in the organisation. Anyone who can read the base can see
 * that; it is the same population that can already see it in a picker. What
 * it does NOT do is list things the asker cannot see for themselves — the
 * rows are filtered to the asker's own reach, or "used by 3 agents" becomes a
 * way to enumerate an organisation from one shared base.
 *
 * No request schema: none of the three reads a body or a query. Each answer
 * is scoped by the session and says which bases it covers (the ids are the
 * keys), so there is no parameter whose absence could pass for a narrower one.
 */

const express = require('express');
const log = require('../../telemetry/log');
const router = express.Router();
const kbStore = require('../../stores/knowledgeBases');
const { requireAuth } = require('../../auth');
const { canAccessKB, getUserId } = require('./shared');
const { usageForKb, usageSummary } = require('../../core/kb/kbUsage');

/**
 * Narrow usage rows to what this person may know about.
 *
 * An org member sees the org's things; anything owned by somebody else
 * outside their reach is COUNTED but not named — `UsedByTab` already renders
 * an anonymous "someone else's agent" row for exactly this, so the count
 * stays honest without turning the tab into a directory.
 */
function redactForeign(rows, userId) {
    return rows.map((r) => {
        const mine = r.ownerId && String(r.ownerId) === String(userId);
        if (mine) return r;
        // Not this person's, and this route cannot cheaply prove they may see
        // it. Keep the kind and the role — which is what "what would break"
        // needs — and drop the name.
        return { ...r, title: null, foreign: true };
    });
}

// ── GET /:id/usage ──────────────────────────────────────────────────

router.get('/:id/usage', requireAuth, async (req, res) => {
    const kb = await kbStore.getKB(req.params.id);
    if (!kb) return res.status(404).json({ error: 'KB not found' });
    if (!(await canAccessKB(req, kb))) return res.status(403).json({ error: 'Access denied' });

    const { rows, partial } = await usageForKb(kb.id);
    res.json({
        usage: redactForeign(rows, getUserId(req)),
        // The client shows "and I could not check apps" rather than
        // presenting an incomplete list as a complete one.
        unchecked: partial,
    });
});

// ── GET /usage-summary ──────────────────────────────────────────────

router.get('/usage-summary', requireAuth, async (req, res) => {
    const userId = getUserId(req);
    const { resolveUserOrgIds } = require('../../auth');
    const orgIds = await resolveUserOrgIds(req);
    // Only bases this person can already see. Asking for a summary must
    // not be a way to probe for ids.
    const kbs = await kbStore.listKBs(userId, orgIds, {});
    const ids = (kbs || []).map(k => k.id);
    res.json({ summary: await usageSummary(ids) });
});

// ── GET /suggestions ────────────────────────────────────────────────

/**
 * "Nextcloud handleidingen" looks like it belongs to the agent "Nextcloud
 * Buddy", which currently answers with no knowledge at all.
 *
 * DETERMINISTIC on purpose — no model call. A suggestion that changes between
 * two page loads reads as a system that is guessing, and this one appears on
 * the section's front page where it is seen more than it is acted on. Word
 * overlap between the names and descriptions, a floor under it, best first.
 */
router.get('/suggestions', requireAuth, async (req, res) => {
    const userId = getUserId(req);
    const { resolveUserOrgIds } = require('../../auth');
    const orgIds = await resolveUserOrgIds(req);

    const kbs = await kbStore.listKBs(userId, orgIds, {});
    if (!kbs || kbs.length === 0) return res.json({ suggestions: [] });

    const summary = await usageSummary(kbs.map(k => k.id));
    // Only bases NOTHING uses: suggesting one that three agents already
    // read is noise, and the pill beside it already says so.
    const unused = kbs.filter(k => Object.keys(summary[k.id]?.counts || {}).length === 0);
    if (unused.length === 0) return res.json({ suggestions: [] });

    const { pool } = require('../../db');
    let agents = [];
    try {
        const r = await pool.query(
            `SELECT id, name, description, config
                   FROM agents
                  WHERE organization_id = ANY($1::text[])
                    AND COALESCE(jsonb_array_length(config::jsonb -> 'knowledge_base_ids'), 0) = 0
                  LIMIT 200`,
            [[...(orgIds || [])]],
        );
        agents = r.rows || [];
    } catch (e) {
        // No agents table, or a shape this query cannot read: a suggestion
        // is a nicety and its absence is not an error the person needs.
        log.warn('[KB] Suggestions: agent scan unavailable:', e.message);
        return res.json({ suggestions: [] });
    }

    const suggestions = [];
    for (const kb of unused) {
        const kbWords = wordsOf(`${kb.name} ${kb.description || ''}`);
        let best = null;
        for (const agent of agents) {
            const score = overlap(kbWords, wordsOf(`${agent.name} ${agent.description || ''}`));
            if (score >= 1 && (!best || score > best.score)) best = { agent, score };
        }
        if (best) {
            suggestions.push({
                kbId: kb.id, kbName: kb.name,
                agentId: best.agent.id, agentName: best.agent.name,
                score: best.score,
            });
        }
    }
    suggestions.sort((a, b) => b.score - a.score);
    res.json({ suggestions: suggestions.slice(0, 3) });
});

/**
 * Words worth matching on. Short ones are dropped: "de", "the", "AI" and "en"
 * match everything and would pair every base with every agent.
 */
function wordsOf(text) {
    return new Set(
        String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 4),
    );
}

function overlap(a, b) {
    let n = 0;
    for (const w of a) if (b.has(w)) n += 1;
    return n;
}

module.exports = router;
module.exports.redactForeign = redactForeign;
module.exports.wordsOf = wordsOf;
module.exports.overlap = overlap;
