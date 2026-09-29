/**
 * Agents — who uses them.
 *
 *   GET /agents/:id/usage   the "Used by" tab, and what the delete guard in
 *                           crud.js refuses on.
 *
 * ── WHY THE EDIT RIGHT AND NOT THE READ RIGHT ───────────────────────
 * The knowledge-base version of this tab is deliberately open to anyone who
 * may READ the base: its population is the same one that already sees it in a
 * picker. An agent's Used-by tab is not that. It lives inside the editor, its
 * only other caller is the delete confirmation, and its rows name routines,
 * apps and pages — so it asks for the right the editor already needs. Anyone
 * who may not even read the agent gets the same 404 `GET /:id` gives them; an
 * agent they may chat with but not edit gets the editor's 403.
 *
 * ── AN ANSWER THAT IS NOT KNOWN SAYS SO ─────────────────────────────
 * `unchecked` names every kind that could not be answered — a consumer table
 * this install has not got, a scan that threw, a conversation count that
 * failed. The client renders "and I could not check apps" instead of showing
 * an incomplete list as a complete one, and the delete guard treats the same
 * list as "in use". Zero is a claim; this endpoint only makes it when it can.
 *
 * ── COUNTED, NOT NAMED ──────────────────────────────────────────────
 * Rows the asker does not own come back with `title: null, foreign: true`
 * (agentUsage.redactForeign). The count of what breaks stays honest without
 * the tab becoming a directory of everything colleagues have built.
 *
 * ── IT TAKES NO OPTIONS, AND SAYS SO ────────────────────────────────
 * Every kind is scanned on every call. A query string used to be ignored, so
 * `?kind=automation` answered with all of them under a 200 that read as a
 * narrowed list. It is refused. `:id` is any agent id (the column is TEXT);
 * the store answers an unknown one with the 404 below.
 *
 * Run: cd server && node --test routes/agents/usage.test.js
 */

const express = require('express');
const { z } = require('zod');
const { validate } = require('../../core/http/validate');
const agentStore = require('../../stores/agentStore');
// The pure half of the usage contract comes straight from the module rather
// than through the store facade. `KINDS` is what "I could not check anything"
// is spelled with and `redactForeign` is what keeps the tab from becoming a
// directory: neither may depend on a facade property being present, because
// the failure mode of an absent one is a safety fallback that throws — or
// worse, a redaction that silently does nothing.
const { KINDS: USAGE_KINDS, redactForeign } = require('../../stores/agent/agentUsage');
const { getEffectiveUserId } = require('../../utils/routeHelpers');
const { canReadAgent, canModifyAgent } = require('./crud');
const log = require('../../telemetry/log');

const router = express.Router();

/**
 * Who may chat with this agent, in the shape the tab's Chat row renders.
 * `groupIds` are ids, not names: naming them means reading the org's group
 * list, which the client already holds (`orgGroups`) and this route would
 * otherwise have to fetch on every call.
 *
 * `shared_groups` is an array off `getAgent`, but it is a JSON string in the
 * column and several writers hand the row around raw. A restriction this
 * function cannot READ must not come out as "the whole organisation" — that
 * is the reassuring answer, and it is the one an editor would act on. So an
 * unreadable value is reported as a restriction whose members are unknown.
 */
function _sharedGroups(agent) {
    const raw = agent.shared_groups;
    if (Array.isArray(raw)) return { groups: raw.filter(Boolean), readable: true };
    if (raw === null || raw === undefined || raw === '') return { groups: [], readable: true };
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            if (Array.isArray(parsed)) return { groups: parsed.filter(Boolean), readable: true };
        } catch (_) { /* falls through to unreadable */ }
    }
    return { groups: [], readable: false };
}

function audienceOf(agent) {
    const { groups, readable } = _sharedGroups(agent);
    const isPublished = agent.is_published === true;
    const restricted = !readable || groups.length > 0;
    return {
        isPublished,
        scope: !isPublished ? 'private' : (restricted ? 'groups' : 'organization'),
        groupIds: isPublished ? groups : [],
        organizationId: agent.organization_id || null,
    };
}

/**
 * Everything the Used-by tab and the delete guard both need, gathered once.
 *
 * Exported because `DELETE /agents/:id` must refuse on exactly what this
 * endpoint shows. Two gatherings would eventually disagree, and the
 * disagreement people meet is a tab saying "used by nothing" beside a delete
 * that will not go through.
 *
 * @param {object} agent   the concept row (getAgent)
 * @param {string} askerId whose conversations are "their own", and whose rows
 *                         keep their names
 */
async function gatherUsage(agent, askerId) {
    const unchecked = [];

    let rows = [];
    try {
        const scan = await agentStore.usageForAgent(agent.id);
        // A shape this route cannot read is the same answer as a pass that
        // threw. Trusting it instead would send an `undefined` into the count
        // loop and turn a clean 409 into a 500 — or, if the row list happened
        // to be readable and the partial list was not, quietly drop every
        // "I could not check this".
        rows = Array.isArray(scan && scan.rows) ? scan.rows : [];
        unchecked.push(...(Array.isArray(scan && scan.partial) ? scan.partial : USAGE_KINDS));
    } catch (e) {
        // usageForAgent already degrades per kind, so reaching here means the
        // whole pass failed. Nothing is known, and nothing is claimed.
        log.warn('[agents] usage scan unavailable:', e.message);
        unchecked.push(...USAGE_KINDS);
    }

    let chat = null;
    try {
        const stats = await agentStore.getAgentChatStats([agent.id], { excludeUserId: askerId || null });
        chat = (stats && typeof stats.get === 'function' ? stats.get(agent.id) : null) || null;
    } catch (e) {
        // Unknown, not zero: the delete guard reads `othersConversationCount`
        // to decide whether it is about to destroy colleagues' history.
        log.warn('[agents] chat stats unavailable:', e.message);
    }
    // One place decides what `chat: null` means, so a batch that came back
    // without this agent in it cannot slip through as a silent null the
    // client has no name for. An agent nobody ever chatted with is an object
    // of zeros, never null.
    if (!chat) unchecked.push('chat');

    // ── Testgesprekken (A4) ──────────────────────────────────────────
    // Een testchat schrijft GEEN conversatierij, dus hij zit per constructie
    // niet in `chat` hierboven, niet in de kaartvoet en niet in de historie.
    // Hij kost wel geld, dus hij staat onder zijn eigen bron in het
    // verbruikslogboek — en dáár is hij te tellen, zonder ooit op te tellen
    // bij het getal ernaast. Twee getallen die niets met elkaar te maken
    // hebben dragen hier dus ook twee namen.
    let testChats = null;
    try {
        const usageStore = require('../../stores/usageStore');
        const counted = await usageStore.getTestChatCounts([agent.id]);
        const n = counted && typeof counted.get === 'function' ? counted.get(agent.id) : undefined;
        testChats = Number.isFinite(n) ? n : null;
    } catch (e) {
        // Onbekend, niet nul. Nul is een bewering.
        log.warn('[agents] test-chat count unavailable:', e.message);
    }
    // BEWUST NIET in `unchecked`. Die lijst is wat de verwijdergarantie leest
    // als "in gebruik", en dat is daar terecht: een onleesbare scan kan
    // andermans routine of pagina verbergen. Een testgesprek kan dat per
    // definitie niet — het schreef nooit een rij, dus er gaat bij verwijderen
    // niets verloren. Een teller die het niet wist zou dan een agent
    // onverwijderbaar maken om een getal dat nergens over gaat. `testChats:
    // null` is het onbekend-signaal van dit veld zelf.

    const counts = {};
    for (const r of rows) counts[r.kind] = (counts[r.kind] || 0) + 1;

    return {
        rows,
        counts,
        chat,
        testChats,
        unchecked,
        audience: audienceOf(agent),
    };
}

const NoQuery = z.preprocess((v) => (v === undefined || v === null ? {} : v), z.object({}).strict());

router.get('/:id/usage', validate({ query: NoQuery }), async (req, res) => {
    try {
        const userId = getEffectiveUserId(req);
        const agent = await agentStore.getAgent(req.params.id);
        if (!agent) return res.status(404).json({ error: 'Agent not found' });
        // Same 404 as GET /:id for someone who may not see the agent at all —
        // "you may not" and "it is not there" must not be distinguishable.
        if (!(await canReadAgent(agent, userId, req))) {
            return res.status(404).json({ error: 'Agent not found' });
        }
        if (!(await canModifyAgent(agent, userId, req))) {
            return res.status(403).json({
                error: 'You do not have permission to edit this agent.',
                code: 'agent_not_editable',
            });
        }

        const { rows, counts, chat, testChats, unchecked, audience } = await gatherUsage(agent, userId);
        res.json({
            usage: redactForeign(rows, userId),
            counts,
            chat,
            testChats,
            audience,
            unchecked,
        });
    } catch (e) {
        log.error('[agents] usage read failed:', e.message);
        res.status(500).json({ error: 'Could not load who uses this agent' });
    }
});

module.exports = router;
module.exports.gatherUsage = gatherUsage;
module.exports.audienceOf = audienceOf;
