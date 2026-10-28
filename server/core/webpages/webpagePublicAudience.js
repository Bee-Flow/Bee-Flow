// @typecheck
/**
 * "Who sees the page" — the four rows, and what belongs to the fourth.
 *
 * Three of the four rows are the ordinary Studio audience that every object has:
 * Personal, Whole organisation, Groups (derived from `is_published` +
 * `shared_groups`, exactly as the frontend `audienceModeOf` does it). The
 * fourth is of another kind and must remain so.
 *
 * ── A PUBLIC SHARE IS NOT A LOGGED-IN PAGE WITH FEWER RIGHTS ──────
 *
 * At /w/<slug> stands a script-free, DOMPurify-cleaned SNAPSHOT (services/webpageSnapshot.js). No
 * `beeflowTables` runs there, and the anonymous bridge knows only /ai/chat and /ai/stream (publicShareBridge.js).
 * From that follows everything that this module enforces:
 *
 *   1. PUBLIC TABLE BINDINGS ARE READ-ONLY. `readwrite` exists for
 *      Personal, Organisation and Groups. Outward goes a rendered
 *      table, no channel back.
 *   2. `publicColumns` IS THE GATE, and it is ASKED for. Making public without
 *      a column choice may not silently mean "then everything" —
 *      and also not silently reuse the previous answer. A table
 *      that does not occur in the choice goes to ZERO columns.
 *   3. THE AGENT BLOCK IS INTERNAL-ONLY. `ai.ask` is deliberately kept out of the anonymous
 *      bridge, so a public visitor does not run it. The Public row
 *      says so in the block instead of silently letting it do nothing (that is the sentence
 *      that WebpageActionsPanel already announced).
 *   4. BUT /ai/chat AND /ai/stream ARE IN IT. If `bridge_grants.ai.publicEnabled` is on, then publicViewer.js
 *      injects a REAL beeflowAI bridge into the public document in the react branch, and an anonymous
 *      visitor chats on the author's LLM budget — with `publicGroundOnPage` even
 *      grounded on the knowledge of the page. That is the only property of this surface that COSTS MONEY and the only one that gives a visitor a
 *      live channel, so it must be stated here just as firmly as the two above.
 *      Points 1-3 are constants; this one is a SWITCH, and nowhere else is there a screen that shows it.
 *
 * ── THE ADDRESS SURVIVES THE SHARE ──────────────────────────────────
 *
 * `slug` stands on the PAGE, `public_share_id` points to the share that serves that address.
 * Therefore the underlying link can be replaced — other token, other password, other
 * recipient list — without the address changing. That is the gain of "one share is the address";
 * the N-share model beneath it simply continues to exist (separate /share/<token> links alongside the
 * canonical one).
 *
 * Everything below is pure. The I/O stands in routes/webpagesAudience.js, so that
 * these decisions can be bitten without a database.
 */

'use strict';

/** De drie interne standen, letterlijk gelijk aan VisibilityCapsule's namen. */
const PERSONAL = 'personal';
const ORG = 'org';
const GROUPS = 'groups';

/**
 * The same derivation as the frontend (`VisibilityCapsule.audienceModeOf`), with
 * the same three values: a published thing WITHOUT groups belongs to the whole
 * organisation, WITH groups to those groups, and unpublished is
 * personal. Repeated here because the server must also be able to give the answer on its own — one rule, two places, and the names literally equal so that a difference
 * is noticed at once.
 */
function audienceModeOf({ isPublished, sharedGroups }) {
    if (!isPublished) return PERSONAL;
    const groups = Array.isArray(sharedGroups) ? sharedGroups.filter(Boolean) : [];
    return groups.length > 0 ? GROUPS : ORG;
}

/**
 * The gate: which columns of which bound table may go outward?
 *
 * Per binding two lists that must remain different:
 *   columns        what the page may read INTERNALLY
 *   publicColumns  what ends up in the snapshot on /w/<slug>
 *
 * There is deliberately NO field "already decided about this". Zero public columns
 * is a valid, safe outcome — "the table hangs on it and nothing goes outward" — and is not
 * distinguishable from "not yet asked" without a third state that adds nothing: the screen ASKS for the
 * choice when making public, and `applyColumnChoice` resets every table that is missing from that answer to zero.
 * Unknown narrows there, not here.
 */
function describeColumnGate(tables) {
    const list = Array.isArray(tables) ? tables : [];
    const rows = list.map(t => {
        const columns = Array.isArray(t?.columns) ? t.columns : [];
        const publicColumns = Array.isArray(t?.publicColumns) ? t.publicColumns : [];
        return {
            datatableId: t?.datatableId || '',
            columns,
            publicColumns,
            // Internally a binding may write; publicly it never can.
            mode: t?.mode === 'readwrite' ? 'readwrite' : 'read',
            publicMode: 'read',
            share: publicColumns.length > 0,
        };
    }).filter(r => r.datatableId);
    return {
        tables: rows,
        anyBound: rows.length > 0,
        // How many tables actually send something outward. Zero bound
        // tables and zero sharing tables look the same on the screen
        // and are not: the first is "nothing hangs on it", the second is
        // "something hangs on it and it stays inside".
        sharingCount: rows.filter(r => r.share).length,
    };
}

/**
 * Apply the column choice to the bindings — the write side of that same gate.
 *
 * `choice` is `{ [datatableId]: string[] }`, as the screen delivers it at "Making public".
 * The rules, all in the narrowing direction:
 *
 *   - a table that is NOT in `choice` gets an EMPTY publicColumns.
 *     Omitting is no consent, and reusing the previous answer would mean
 *     that a column approved last year slips out again today without
 *     anyone looking at it;
 *   - a chosen column that is not in `columns` falls away (normalizeTableGrant
 *     also does that again on saving — two locks on the same door is
 *     the intention here);
 *   - `choice` may not ADD tables. What is not bound is not bound here.
 */
function applyColumnChoice(tables, choice) {
    const list = Array.isArray(tables) ? tables : [];
    const picked = (choice && typeof choice === 'object' && !Array.isArray(choice)) ? choice : {};
    return list.map(t => {
        const columns = Array.isArray(t?.columns) ? t.columns : [];
        const raw = picked[t?.datatableId];
        const wanted = Array.isArray(raw) ? raw : [];
        /** @type {string[]} */
        const publicColumns = [];
        for (const c of wanted) {
            if (typeof c !== 'string') continue;
            const key = c.trim();
            if (!key || !columns.includes(key) || publicColumns.includes(key)) continue;
            publicColumns.push(key);
        }
        return { ...t, publicColumns };
    });
}

/**
 * Does the access setting of the existing canonical share differ from what is now
 * asked?
 *
 * Determines whether "Public" on saving can KEEP the existing link or must REPLACE it. Replacing means a new token — existing links no
 * longer work — so that may only happen if the owner really asked for something different.
 *
 * A SUBMITTED password always counts as a change: we cannot compare it with the argon2 hash
 * without verifying, and "possibly the same" may not be a reason to let a password change silently fall away.
 */
function accessOptionsChanged(share, requested) {
    if (!share) return true;
    const want = requested || {};
    const mode = want.accessMode || 'unlisted';
    if (share.accessMode !== mode) return true;
    if (typeof want.password === 'string' && want.password.length > 0) return true;
    if (mode === 'email') {
        const now = normalizeEmails(share.allowedEmails);
        const next = normalizeEmails(want.allowedEmails);
        if (now.length !== next.length) return true;
        return now.some((e, i) => e !== next[i]);
    }
    return false;
}

/** Kleine letters, ontdubbeld, gesorteerd — zodat vergelijken betekenisvol is. */
function normalizeEmails(raw) {
    if (!Array.isArray(raw)) return [];
    const out = new Set();
    for (const e of raw) {
        if (typeof e !== 'string') continue;
        const v = e.trim().toLowerCase();
        if (v) out.add(v);
    }
    return [...out].sort();
}

/**
 * The model that the screen draws. Pure: all rows come in as argument.
 *
 * `canonicalShare` is the LIVE share that `public_share_id` points to, or
 * null. A pointer to a revoked share should arrive here as null — "public" is then off, not
 * "public with a broken link".
 */
function buildAudienceModel({
    webpage,
    canonicalShare = null,
    canonicalShareKnown = true,
    shareCount = 0,
    tables = [],
    ai = null,
    solution = null,
    baseUrl = '',
}) {
    const wp = webpage || {};
    const slug = wp.slug || null;
    const gate = describeColumnGate(tables);
    const isPublic = !!canonicalShare;
    // The ai part of `bridge_grants`, or nothing. If it is missing, that is an
    // UNREAD state and not "off": see `aiKnown` below.
    const aiGrant = (ai && typeof ai === 'object' && !Array.isArray(ai)) ? ai : null;
    return {
        internal: {
            mode: audienceModeOf({ isPublished: wp.isPublished, sharedGroups: wp.sharedGroups }),
            isPublished: !!wp.isPublished,
            sharedGroups: Array.isArray(wp.sharedGroups) ? wp.sharedGroups : [],
            organizationId: wp.organizationId || null,
        },
        public: {
            on: isPublic,
            // THREE states, not two. If the share could not be looked up (the
            // database stalled), then `on: false` is an ASSERTION about exposure that
            // we cannot make good — and lying in that direction is the
            // dangerous one: the owner reads "not public" about a page that
            // perhaps is. `known: false` says "not checkable", and the screen then
            // should neither switch anything on nor off.
            known: canonicalShareKnown !== false,
            shareId: canonicalShare?.id || null,
            accessMode: canonicalShare?.accessMode || 'unlisted',
            hasPassword: !!canonicalShare?.hasPassword,
            allowedEmails: normalizeEmails(canonicalShare?.allowedEmails),
            expiresAt: canonicalShare?.expiresAt || null,
            viewCount: canonicalShare?.viewCount || 0,
            lastViewedAt: canonicalShare?.lastViewedAt || null,
            // Two properties of the public surface that the screen must state, not
            // imply. They are not configurable: they follow from
            // what a snapshot is.
            tablesReadOnly: true,
            agentRuns: false,
            // And the THIRD, which is configurable. `bridge_grants.ai.publicEnabled` puts
            // a real beeflowAI bridge into the public document (publicViewer.js
            // → routes/publicShareBridge.js): anonymous visitors then chat on
            // the author's budget. If the model stays silent about this, the owner reads the
            // two lines above as "no AI runs publicly" — the dangerous direction.
            //
            // Three-valued, like `known` above and for the same reason: if the ai part
            // did not come along, then `aiRuns:false` is an assertion about exposure that
            // nobody can make good. Unknown narrows: the screen then says that it was not readable and asserts nothing.
            aiKnown: !!aiGrant,
            aiRuns: aiGrant?.publicEnabled === true,
            // Does that public AI also ground itself on the knowledge of the page? Then
            // not only budget but also content goes outward, past the column gate
            // that this screen counts so carefully.
            aiGroundsOnPage: aiGrant?.publicGroundOnPage === true,
        },
        address: slug
            ? { slug, path: `/w/${slug}`, url: baseUrl ? `${String(baseUrl).replace(/\/+$/, '')}/w/${slug}` : null }
            : null,
        columnGate: gate,
        // The N-share model remains: this counts ALL live shares, canonical or
        // not, so that "three loose links are still open" is visible.
        //
        // That number is not decorative. "Public off" withdraws exclusively the
        // CANONICAL share — a loose /share/<token> of the same page
        // continues to be served afterwards — so this is the only field by which the
        // screen can see that "Off" is not the same as "nobody can get at it
        // any more".
        shareCount: Number(shareCount) || 0,
        // And therefore three-valued, like `public.known`: if the list was unreadable (`null`),
        // then 0 is not a fact but a failed reading, and "nothing else is open"
        // may not follow from that.
        shareCountKnown: shareCount !== null && shareCount !== undefined,
        solution: solution ? { id: solution.id, name: solution.name || '' } : null,
    };
}

module.exports = {
    PERSONAL,
    ORG,
    GROUPS,
    audienceModeOf,
    describeColumnGate,
    applyColumnChoice,
    accessOptionsChanged,
    normalizeEmails,
    buildAudienceModel,
};
