'use strict';

/**
 * "What depends on THIS webpage?" ("Wat hangt er aan DEZE webpagina?") — the read side of W5 (part B).
 *
 * The counterpart of `webpageUsageSync.js`, which looks the other way (which TABLES does this page touch). Here the page is the subject: which things would break, or lose something, if it disappeared.
 *
 * Four sub-questions, deliberately kept apart from each other:
 *
 *   solution    the Solution in which the page is stored (`webpages.project_id`)
 *   automation  the automations that name it by name (`automations.definition_json`)
 *   chat        the conversations that pull it in — NOT RECORDED
 *   agent       the agents that may open it as a tool — UNKNOWN TODAY
 *
 * ── AN EMPTY LIST IS A CLAIM, NOT AN EMPTY PLACE ──────────────────
 *
 * "Nothing uses this page" is the sentence someone reads when they press Delete. That sentence may only sound once all three sub-questions have REALLY been answered. That is why this file never delivers only rows, but a status per kind — the same split that `routes/studio/attention.js` makes for "Needs attention", and for exactly the same reason: there "all is well" was once shown over a graph of which half was never loaded.
 *
 *   status 'checked'      the scan ran; `found` is a number and 0 is news
 *   status 'unavailable'  it could not look; `found` is null and the kind is
 *                         listed in `partial` → the client reads that as "I don't
 *                         know", never as "there is nothing"
 *
 * `complete` is the licence to say "nothing uses this": only true when `partial`
 * is empty. Today that is NEVER true (see `agent` below), and that is the honest
 * state — the placeholder in `agent-hub/src/pages/webpages/WebpageUsedByTab.jsx`
 * says the same thing in words today. This module replaces that sentence with an
 * answer that can be checked per kind.
 *
 * ── THE ROWS ARE THE Used-by CONTRACT ─────────────────────────────
 * `{ kind, id, title, role, ownerId, lastAt }` — what `shared/UsedByTab.jsx`
 * renders and `shared/DangerZone.jsx` counts, so the tab, the delete confirmation
 * and the pills cannot drift apart. Exactly the shape of `core/kb/kbUsage.js` and
 * `core/meetingNotes/meetingUsage.js`.
 *
 * ── WHY `agent` IS PERMANENTLY UNKNOWN ────────────────────────────
 *
 * The webpage tools of an agent (`integrations/webpageAutomationTools.js`) take
 * `webpageId` as an ARGUMENT and only check `canReadWebpage` at the moment of the
 * call. So there is no row at all that says "agent X may open page Y"; the
 * permission arises at the moment itself. That is something other than "no agent
 * can reach it" — it is not answerable. Unknown narrows, so this kind reports as
 * `unavailable` and `complete` stays false, instead of reporting a zero that nobody
 * can vouch for.
 *
 * NOT to be confused with `bridge_grants.agent`: that is the OPPOSITE direction
 * (the page may call that agent). It belongs in the Used-by of the AGENT —
 * `stores/agent/agentUsage.js` already scans it there — and here it would invent a
 * user who is not there.
 *
 * ── WHY `chat` IS NOT THE BUILD CONVERSATION ─────────────────────
 *
 * A page is pulled into a conversation in two ways, and only one of them is a
 * DEPENDENCY:
 *
 *   1. the conversation that is ATTACHED to the page — `webpages.chat_messages`,
 *      the build conversation from the editor. That sits on the row ITSELF, belongs
 *      to the owner, and goes along when the page goes. It is therefore not a thing
 *      that breaks: it is part of the page. Listing it as a row would make almost
 *      every page "in use" (every page ever built via the editor chat has filled that
 *      column), with as row title the name of the page the reader is already looking
 *      at — a dependency that does not exist, and a 409 with the wrong sentence.
 *      What does go with it is CONTENT, which is a different question from "what
 *      breaks"; the dialog says that with "what lives on the page goes with it".
 *   2. the page in the side panel of an ordinary chat
 *      (`AgentHub/useSidePanelState.js`). That is PER TURN: the client sends
 *      `sidePanelWebpage` along in the request, `promptAssembly.js` injects the
 *      content into the prompt, and NOTHING is recorded — not on the conversation,
 *      not on the message. THAT is the question the `chat` kind asks, and it cannot
 *      be answered: there is no row that carries it.
 *
 * That is why `chat` reports as `unavailable` and not as a zero. A zero would claim
 * that a look was taken; there is nothing to look at. Should a later release record
 * that choice (a `webpage_id` on `direct_conversations`, or in
 * `conversation_messages.meta_json`), this becomes a real scan. Note: the content of
 * conversations is encrypted (`stores/agent/messageCrypto.js`), so searching for a
 * page name or id IN the messages is no alternative — the answer would stay silently
 * empty, which is exactly the error this module prevents.
 *
 * ── WHY `automation` IS THERE ─────────────────────────────────────
 *
 * An automation binds a page DURABLY. `automation/builderPrompt.js` tells the builder
 * literally: "Every webpage tool requires `webpageId` … bind it as a literal", and the
 * bundled template in `automation/templates.js` does so too. Those ids live in
 * `automations.definition_json` and can be queried with exactly the query this house
 * writes for every other kind — `kbUsage.js` does so, and
 * `stores/agent/agentUsage.js` simply has `automation` in KINDS. Without this scan an
 * invoice automation that writes into the page every morning disappeared from every
 * screen that asks the question, and from the next run it silently failed on
 * `resolveWebpageForAccess`.
 *
 * What the scan does NOT find is a binding via `{kind:'ref', path:…}`: then the
 * automation picks its page only during the run and the id appears nowhere. That is a
 * deliberately chosen dynamic mode, not a default, and the rows that are there remain
 * correct — so the kind reports as `checked`.
 */

const { pool } = require('../../db');
const log = require('../../telemetry/log');

/** Every kind that this can find, in the order in which the tab shows them. */
const KINDS = Object.freeze(['solution', 'automation', 'chat', 'agent']);

/**
 * Why a kind could not be answered — machine tokens, not prose.
 *
 * Same choice as `REASONS` in webpageUsageSync.js and as `unfiltered` in
 * meetingUsage: an English sentence invented here would show up untranslated on
 * the screen in every language. The client chooses the words, the server supplies
 * the fact.
 */
const REASONS = Object.freeze({
    NO_PAGE: 'no-page',
    NO_PROJECTS_TABLE: 'no-projects-table',
    NO_AUTOMATIONS_TABLE: 'no-automations-table',
    PROBE_FAILED: 'probe-failed',
    NOT_RECORDED: 'not-recorded',
    SCAN_FAILED: 'scan-failed',
});

/**
 * Does this table exist on THIS installation?
 *
 * Our own copy, just as in `core/kb/kbUsage.js` and `core/meetingNotes/meetingUsage.js`:
 * every usage module is a leaf that only needs `db`, and a require straight through
 * another domain (webpages → kb) would cost a readability gain of six lines in coupling.
 *
 * THREE states, not two. `true` and `false` are answers; `null` is "I could not
 * look". Should a probe that fell over return `false`, the scan would report
 * `no-projects-table` — a machine token on which the client builds the sentence "this
 * installation has no Solutions", and that sentence is untrue about an installation
 * that does have them. Both states block the deletion (both `unavailable`), but they
 * tell the reader something different.
 */
async function tableExists(name, client) {
    try {
        const r = await (client || pool).query('SELECT to_regclass($1) AS t', [name]);
        return !!r.rows[0]?.t;
    } catch (_) {
        return null;
    }
}

/**
 * The Solution in which this page is stored.
 *
 * `webpages.project_id` is a SOFT reference (no FK, see
 * stores/webpage/schema.js): a deleted Solution leaves the page and the pointer behind.
 * Three outcomes, and all three are different:
 *
 *   no project_id        the page stands alone → checked, zero rows. The table is
 *                        deliberately NOT looked at first: the page row answers the
 *                        question completely, and a probe would make every loose page
 *                        in an installation WITHOUT Solutions report "not checked".
 *   table absent         this installation has no Solutions → `unavailable` with
 *                        `no-projects-table`
 *   probe fell over      unknown → `unavailable` with `probe-failed`, because that is
 *                        something other than "there are no Solutions here"
 *   pointer without row  the Solution is already gone → checked, zero rows.
 *                        Nothing breaks on something that no longer exists, and a row
 *                        without a name would yield a link that returns 404.
 */
async function scanSolution(webpage, db) {
    const projectId = webpage.projectId || null;
    if (!projectId) return { rows: [] };
    const present = await tableExists('projects', db);
    if (present !== true) {
        return { rows: [], unchecked: present === null ? REASONS.PROBE_FAILED : REASONS.NO_PROJECTS_TABLE };
    }
    const r = await db.query(
        `SELECT id, name, owner_id, updated_at FROM projects WHERE id = $1`,
        [projectId],
    );
    const row = (r.rows || [])[0];
    if (!row) return { rows: [] };
    return {
        rows: [{
            kind: 'solution',
            id: row.id,
            title: row.name || null,
            // De Oplossing BEVAT de pagina — dezelfde rol die kbUsage voor
            // `projects` gebruikt, zodat één werkwoord één ding betekent.
            role: 'contains',
            ownerId: row.owner_id || null,
            lastAt: row.updated_at || null,
        }],
    };
}

/**
 * Automations that name this page.
 *
 * The ids sit at an unknown depth in `definition_json` (a step argument, a quick-mode
 * field, a template), so the containment operator cannot be used —
 * `jsonb_path_exists` with a recursive wildcard is the one form that finds them
 * wherever an editor has put them. Exactly the query that
 * `core/kb/kbUsage.js` writes for the same question.
 *
 * Two forms, because the builder writes the bound variant and older definitions the
 * bare one: `{webpageId: {kind:'literal', value:'wp_1'}}` and `{webpageId: 'wp_1'}`.
 *
 * The id goes in via the VARS parameter of jsonpath, never concatenated into the path.
 * A webpage id is a route parameter, and a value with a quote character would otherwise
 * close the string literal INSIDE the jsonpath and be read as path syntax — placeholder
 * or not, the injection then sits in the path and not in the SQL.
 */
async function scanAutomation(webpage, db) {
    const present = await tableExists('automations', db);
    if (present !== true) {
        return { rows: [], unchecked: present === null ? REASONS.PROBE_FAILED : REASONS.NO_AUTOMATIONS_TABLE };
    }
    const r = await db.query(
        `SELECT id, title, user_id AS owner_id, updated_at AS last_at
           FROM automations
          WHERE jsonb_path_exists(definition_json, '$.**.webpageId.value ? (@ == $id)', jsonb_build_object('id', $1::text))
             OR jsonb_path_exists(definition_json, '$.**.webpageId ? (@ == $id)', jsonb_build_object('id', $1::text))`,
        [webpage.id],
    );
    return {
        rows: (r.rows || []).map(row => ({
            kind: 'automation',
            id: row.id,
            title: row.title || null,
            // Een automatisering LEEST de pagina en schrijft in haar database
            // (`webpage_db_exec`, `webpage_file_write`) — dezelfde rol die de
            // index voor een schrijvende binding gebruikt.
            role: 'readwrite',
            ownerId: row.owner_id || null,
            lastAt: row.last_at || null,
        })),
    };
}

/**
 * Conversations that pull this page in — see the heading: not recorded.
 *
 * Deliberately NO scan over `webpages.chat_messages`. That is the build conversation of
 * the page itself: it sits on the same row, goes along when the page goes, and so by
 * definition cannot break from the deletion. Listing it as a dependency made almost
 * every page "in use", with as row title the name of the page the reader was already
 * looking at.
 *
 * The question that belongs here — which ordinary conversations have this page in their
 * side panel — has no row that carries it: `sidePanelWebpage` travels along per turn in
 * the request and is stored nowhere. Unknown narrows, so no zero.
 */
async function scanChat() {
    return { rows: [], unchecked: REASONS.NOT_RECORDED };
}

/**
 * Agents that may open this page as a tool — see the heading: not determinable. No query,
 * no rows, and deliberately no zero either.
 */
async function scanAgent() {
    return { rows: [], unchecked: REASONS.NOT_RECORDED };
}

const SCANS = Object.freeze({
    solution: scanSolution,
    automation: scanAutomation,
    chat: scanChat,
    agent: scanAgent,
});

/**
 * Everything that hangs on this webpage.
 *
 * @param {object} webpage  the PAGE ROW as the store returns it, not only its id:
 *                          `projectId` is what `scanSolution` reads, and without that
 *                          property it reports "checked, zero rows" for a page that IS
 *                          in a Solution — a real dependency that drops out of the list
 *                          as a CONFIRMED zero instead of as a gap. `id` carries the rest.
 * @param {object} [opts]
 * @param {object} [opts.db]  injection point for the tests
 * @returns {Promise<{rows: Array, partial: string[], sources: object, complete: boolean}>}
 *          `partial` names the kinds that could NOT be answered. Not empty means "I don't
 *          know" — never "there is nothing".
 */
async function usageForWebpage(webpage, { db = pool } = {}) {
    const rows = [];
    const partial = [];
    const sources = {};

    // Without a page nothing has been asked and nothing has been claimed. Zero rows with three
    // unanswered kinds, because a caller that accidentally receives `null` here must not
    // read a clean deletion from it.
    if (!webpage || webpage.id == null || webpage.id === '') {
        for (const kind of KINDS) {
            sources[kind] = { status: 'unavailable', found: null, reason: REASONS.NO_PAGE };
            partial.push(kind);
        }
        return { rows, partial, sources, complete: false };
    }

    for (const kind of KINDS) {
        try {
            const out = await SCANS[kind](webpage, db);
            const found = Array.isArray(out?.rows) ? out.rows : [];
            // Found rows remain in place, even when the kind is unanswered:
            // they are real, and throwing them away would hide an existing
            // dependency. What then no longer holds is the COUNT — hence
            // `found: null`, the same rule as in attention.js.
            rows.push(...found);
            if (out?.unchecked) {
                sources[kind] = { status: 'unavailable', found: null, reason: out.unchecked };
                partial.push(kind);
            } else {
                sources[kind] = { status: 'checked', found: found.length };
            }
        } catch (e) {
            log.warn(`[WebpageUsage] ${kind} scan failed for ${webpage.id}:`, e.message);
            sources[kind] = { status: 'unavailable', found: null, reason: REASONS.SCAN_FAILED };
            partial.push(kind);
        }
    }

    return { rows, partial, sources, complete: partial.length === 0 };
}

/**
 * Narrow the rows to what this person may be told.
 *
 * The same rule as for knowledge bases and meeting notes: a row belonging to someone
 * else keeps its KIND and its ROLE — that is what "what breaks" needs — and loses its
 * NAME. The route below is already owner-scoped, so in practice this touches one row: a
 * Solution of a colleague in which the owner has stored his page. Without an owner
 * (org-wide) the row belongs to nobody privately and stays whole.
 */
function redactForeign(rows, userId) {
    return (Array.isArray(rows) ? rows : []).map((r) => {
        if (!r?.ownerId) return r;
        if (String(r.ownerId) === String(userId)) return r;
        return { ...r, title: null, siteLabel: undefined, foreign: true };
    });
}

module.exports = {
    usageForWebpage,
    redactForeign,
    tableExists,
    scanSolution,
    scanAutomation,
    scanChat,
    scanAgent,
    KINDS,
    REASONS,
};
