/**
 * Order the app catalogue by relevance to what the user asked for.
 *
 * WHAT THIS REPLACED, AND WHY. The small-model profile used to run the
 * catalogue through a substring filter that kept the first 8 matching apps.
 * On a Nextcloud install every app id contains "nextcloud", and stop words
 * ("the", "use") match something in almost every action description, so the
 * filter matched ALL 17 apps and the `.slice(0, 8)` then kept whichever eight
 * came first in registry order. Measured on the demo org, that was
 * memory / automation-evolution / kb-ingest / nextcloud / calendar / contacts /
 * deck / talk — and `nextcloud-notifications` was dropped even when the brief
 * said "send a notification in Nextcloud". The prompt presents that list as
 * "the ONLY tools you may propose", so the model dutifully built invoice
 * automations out of Calendar. It was obeying us, not hallucinating.
 *
 * THE RULE THIS MODULE EXISTS TO ENFORCE: ranking ORDERS, it never GATES.
 * Everything the user is permitted to run stays in the catalogue; relevance
 * only decides what the model reads first. A bad rank then costs a little
 * attention instead of making a permitted app invisible. Do not "optimise"
 * this back into a filter — that is precisely the bug it removes. The cap
 * below exists only so a pathological catalogue cannot blow the context, and
 * is set far above any real one.
 *
 * Ranking uses the local cross-encoder (bge-reranker-v2-m3 via llama.cpp),
 * which is already running for knowledge search. It is multilingual and
 * fail-open: `rerankLlamaCpp` returns [] on any error, and an empty result
 * simply leaves the registry order alone.
 */

// Far above any real catalogue (the demo org has 17). This is a blow-up guard,
// not a relevance decision — see the rule above.
const log = require('../../telemetry/log');
const APP_CAP = 40;

// How many action names go into an app's ranking document. Enough to
// characterise the app; more just dilutes the match.
const ACTIONS_PER_DOC = 12;

/**
 * A one-line description of what an app can do, for the cross-encoder.
 * Action names carry the meaning ("nextcloud_notifications_send" ->
 * "nextcloud notifications send"), so underscores become spaces.
 */
function appDocument(app) {
    const actions = (app.actions || [])
        .slice(0, ACTIONS_PER_DOC)
        .map(a => String(a.name || '').replace(/_/g, ' '))
        .filter(Boolean)
        .join(', ');
    return `${app.label || app.id}. ${actions}`;
}

/** Apps the draft already commits to. They must never drift down the list. */
function pinnedAppIds(draft) {
    const ids = new Set();
    const walk = (steps) => {
        for (const s of (steps || [])) {
            if (s && typeof s.tool === 'string') {
                // Tool names are `<app>_<verb>`; the registry id may be
                // hyphenated where the tool name is not, so match on prefix
                // rather than trying to reconstruct the id.
                ids.add(s.tool);
            }
            if (s && Array.isArray(s.body)) walk(s.body);
        }
    };
    walk(draft?.steps);
    for (const g of Object.values(draft?.layers || {})) {
        if (g && typeof g === 'object') walk(g.steps);
    }
    return ids;
}

function isPinned(app, toolNames, triggerProvider) {
    if (triggerProvider && String(app.id).toLowerCase() === String(triggerProvider).toLowerCase()) return true;
    for (const t of toolNames) {
        if ((app.actions || []).some(a => a.name === t)) return true;
    }
    return false;
}

/**
 * Rank the apps a user may run, most relevant first.
 *
 * @param {object} catalog      from buildCatalogForUser
 * @param {string} userMessage  this turn's message
 * @param {object} draft        the automation being built (its apps get pinned)
 * @returns {Promise<object>}   the catalogue with `apps` reordered (never filtered
 *                              by relevance), unavailable apps removed
 */
async function rankAppsForMessage(catalog, userMessage, draft) {
    if (!catalog || !Array.isArray(catalog.apps)) return catalog;

    // Permission is the ONE thing that may remove an app. The renderers drop
    // unavailable apps too; doing it here means the cap is spent on real
    // candidates rather than on apps nobody can run.
    const usable = catalog.apps.filter(a => a && a.available && (a.actions || []).length);
    if (usable.length <= 1) return { ...catalog, apps: usable };

    const toolNames = pinnedAppIds(draft);
    const triggerProvider = draft?.trigger?.appEvent?.provider || null;
    const pinned = usable.filter(a => isPinned(a, toolNames, triggerProvider));
    const rest = usable.filter(a => !pinned.includes(a));

    let ordered = rest;
    const message = String(userMessage || '').trim();
    if (message && rest.length > 1) {
        try {
            const { rerankLlamaCpp } = require('../../core/rerank/llamaCppRerank');
            const docs = rest.map(appDocument);
            const ranked = await rerankLlamaCpp(message, docs, docs.length);
            if (ranked.length) {
                // The reranker may return fewer rows than it was given; anything
                // it omitted keeps its registry position at the back rather than
                // disappearing.
                const seen = new Set();
                const head = [];
                for (const r of ranked) {
                    if (rest[r.index] && !seen.has(r.index)) { head.push(rest[r.index]); seen.add(r.index); }
                }
                const tail = rest.filter((_, i) => !seen.has(i));
                ordered = [...head, ...tail];
            }
        } catch (err) {
            // Ordering is a nicety; never fail a build over it.
            log.warn(`[BuilderCatalog] app ranking unavailable (${err.message}); using registry order`);
        }
    }

    const apps = [...pinned, ...ordered].slice(0, APP_CAP);
    return { ...catalog, apps };
}

/**
 * The catalogue order as a list of app ids — what the builder session stores
 * so later turns can replay it (see applyCatalogOrder).
 */
function catalogOrderOf(catalog) {
    return (catalog?.apps || []).filter(Boolean).map(a => a.id);
}

/**
 * Re-apply a STORED order to the current catalogue — no reranker call, no
 * draft pinning, nothing derived from this turn's message.
 *
 * Why this exists next to rankAppsForMessage: the ordered catalogue is rendered
 * into the system prompt, and the system prompt is the front of the prompt
 * cache. rankAppsForMessage orders by a cross-encoder score against THIS
 * turn's message and pins whatever the draft uses, so its output changed on
 * every reply and as every step was added — a different system prompt each
 * turn, the whole ~25k-token prefix re-read on the local box. The order is
 * therefore computed ONCE, on the session's first turn, persisted on the
 * builder session, and replayed here verbatim for the rest of the session.
 *
 * Same rule as above: this ORDERS, it never GATES. Every usable app survives:
 *   - apps named in `order` come first, in that order;
 *   - apps the user has since gained (not in `order`) follow in registry order;
 *   - ids in `order` that no longer exist are simply skipped;
 *   - `available:false` is the only thing that removes an app, as everywhere.
 */
function applyCatalogOrder(catalog, order) {
    if (!catalog || !Array.isArray(catalog.apps)) return catalog;
    const usable = catalog.apps.filter(a => a && a.available && (a.actions || []).length);
    const wanted = Array.isArray(order) ? order : [];
    const seen = new Set();
    const head = [];
    for (const id of wanted) {
        const app = usable.find(a => a.id === id);
        if (app && !seen.has(id)) { head.push(app); seen.add(id); }
    }
    const tail = usable.filter(a => !seen.has(a.id));
    return { ...catalog, apps: [...head, ...tail].slice(0, APP_CAP) };
}

module.exports = { rankAppsForMessage, applyCatalogOrder, catalogOrderOf, APP_CAP, _internals: { appDocument, isPinned, pinnedAppIds } };
