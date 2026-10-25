// @typecheck
/**
 * webpageBindings — what the page ITSELF does.
 *
 * The column "Lets happen" of "Data & connections" answers a different question than the cards next to it. Those are about what the page READS; this is about
 * what it LETS HAPPEN. Until the `bf-*` vocabulary exists (W4) that surface is still empty — buttons, forms and the Agent block get their
 * elements there — and the column shows the existing bridge grants plus this one piece:
 *
 *   "DOES SOMETHING IN OWN CODE" — a static scan of ALL own text files
 *   of the page for `fetch(` and `XMLHttpRequest` to a host that does not belong to
 *   this installation. Such a call bypasses the automations: it is not in
 *   Runs, knows no approval and nobody sees it back. The card therefore
 *   offers "Make an automation of it", which scaffolds an `http_request`-automation with
 *   that same URL.
 *
 * ── THE SECOND READER: THE MARKINGS IN THE CODE TAB ─────────────────
 *
 * Since W4 this module reads the same files once more, with a different
 * question: on WHICH LINE stands a `bf-*` element? That is `scanBfElements`, and
 * the Code tab draws its Monaco markings with it.
 *
 * Why here and not in the frontend: a second regex in the client would be a second
 * reading of the same vocabulary — precisely the drift that
 * core/webpages/bfElements.js exists to prevent. The names and the pattern by which they are
 * recognized in markup therefore come from the registry; this file writes no tag name.
 *
 * The same three states apply: unreadable files give `scanned:false`, and
 * the Code tab MUST show that difference. A page without markings may not
 * look like a page without bindings.
 *
 * ── THE THIRD READER: THE USAGE INDEX ───────────────────────────────
 *
 * From those same markings comes `collectUses`: WHICH table, WHICH automation,
 * WHICH agent hangs on this page via an element? That is what the middle column
 * shows and what "Used by" will reverse.
 *
 * The families come from the registry (`binding.kind`), not from a list here —
 * this file writes no tag name and no family name. And the index counts only
 * what it CAN actually point to; everything around it comes back as
 * `unresolved`, with the reason:
 *
 *   built-at-runtime      the address stood there as an expression (`source={id}` in
 *                         JSX, `${…}` in a template). The page builds it
 *                         while it runs, so it cannot be read here;
 *   no-target             a required attribute is missing;
 *   page-binding-unknown  the element falls back to the binding of the PAGE, and that is
 *                         not there;
 *   page-binding-unreadable  idem, but the grants could not be READ. That is
 *                         a malfunction and not a choice of the author, so those two
 *                         may not come out for the same reason;
 *   unknown-fallback      the vocabulary knows a fallback for which this
 *                         module has no answer. Then something was added to the
 *                         registry without answering it here — and that may not silently drop an element from the index.
 *
 * An invented id is the ONLY answer that we may not give: `{id}` as a datatable id
 * looks exactly as real in a usage index as `tbl_1`, and afterwards belongs nowhere.
 *
 * ── "ALL FILES" IS NOT "THE THREE SLOTS" ───────────────────────────
 *
 * The three slots (`index.html` / `style.css` / `script.js`) are NOT the whole project, and for most
 * pages they are not even the main part. A react-mui project — and that is, since `integrations/webpageFramework.js`
 * (`DEFAULT_NEW_FRAMEWORK`), what EVERY NEW page becomes — writes its whole app as
 * EXTRA files under `src/` (`src/main.jsx`, `src/App.jsx`, …); the
 * html is generated at render time and the js slot stays empty. A vanilla project may
 * also put `modules/state.js` or `about.html` next to the slots.
 *
 * Whoever reads only `readAllSlots` here reads three empty strings and cheerfully reports "nothing
 * found" about code he has never seen. Therefore `readPageCode` also fetches the text extras, and they carry
 * their own path as `source` in the result, so that the author knows WHICH file to open.
 *
 * ── THIS IS A READING AID, NOT A SECURITY MEASURE ──────────────────
 *
 * Read that literally. The scan reads text; it executes nothing and does not understand
 * JavaScript. Everything below escapes it:
 *
 *   - `window[atob('ZmV0Y2g=')](url)`, `const f = fetch; f(url)`, a call from
 *     a `<script src>` elsewhere, `import()`, `<img src>`, `<form action>`,
 *     `navigator.sendBeacon`, a WebSocket;
 *   - a URL that comes from a variable (`fetch(endpoint)`);
 *   - a regex literal that the mini parser below reads as a string;
 *   - an extra file that the storage knows as BINARY (`isText` false): no text
 *     can be read from there, so what is in it stays out of view.
 *
 * That is why no consumer of this module may say "this page does nothing". The outcome has three
 * states and they MUST remain different:
 *
 *   scanned:false          the files were not readable — unknown;
 *   unresolved > 0         something was found that could not be traced;
 *   calls: [] + scanned    it was looked at and nothing was found — which still is
 *                          not the same as "nothing happens".
 *
 * What the parser loses comes back as `unresolved`, not as silence: the number of
 * `fetch(` / `new XMLHttpRequest` in the RAW text is compared with what is left in the
 * masked text, and the difference is reported as "not checkable". That counts a
 * commented-out `fetch(` as unknown — an annoying but safe direction: the other
 * direction is a real call that the scan silently makes disappear.
 *
 * ── WHAT "OURS" IS ─────────────────────────────────────────────────
 *
 * Only a relative URL and the explicitly configured own host count as
 * internal. Every other host is external, also if it could be from Bee Flow: a
 * false warning is annoying, a concealed outgoing call is a gap. There is deliberately no
 * `beeflow.nl` hard-coded in the list — on a self-hosted installation that is a
 * third party.
 */
'use strict';

const bfElements = require('./bfElements');
const bridgeGrants = require('../../stores/webpage/bridgeGrants');
const { maskCode, classifyUrl, inlineScripts, scanOutboundCalls } = require('./webpageCodeScan');
const { maskComments, scanBfElements } = require('./webpageBfScan');
const { readPageCode } = require('./webpagePageCode');

// ── mini-parser ───────────────────────────────────────────────────────

/** The three states of the scan in one form, so that the client does not have to guess. */
function codeSection(scan) {
    if (!scan) return { scanned: false, calls: [], externalCount: 0, unresolved: 0, internal: 0 };
    return { scanned: true, ...scan };
}

// ── de elementscan: WAAR staat een bf-element? ────────────────────────

/** Dezelfde drie standen als `codeSection`, om dezelfde reden. */
function elementsSection(scan) {
    if (!scan) {
        return {
            scanned: false,
            marks: [],
            counts: { total: 0, known: 0, unknown: 0 },
            unknownTags: [],
            truncated: 0,
        };
    }
    return { scanned: true, ...scan };
}


// ── de usage-index: welke tabel, welke automatisering, welke agent ───────────

/**
 * The families that the vocabulary knows, from the registry.
 *
 * Deliberately not `['datatable','automation','agent']` here: that would be a
 * second list, and a family added to it would then silently drop
 * out of the index instead of appearing in it as an empty list.
 */
function bindingKinds() {
    const kinds = [];
    for (const def of bfElements.BF_ELEMENTS) {
        if (def.binding && !kinds.includes(def.binding.kind)) kinds.push(def.binding.kind);
    }
    return kinds;
}

/** Every fallback that the vocabulary knows — for which the caller must have an answer. */
function declaredFallbacks() {
    const out = [];
    for (const def of bfElements.BF_ELEMENTS) {
        const fb = def.binding && def.binding.fallback;
        if (fb && !out.includes(fb)) out.push(fb);
    }
    return out;
}

/**
 * The answer to one fallback, by FOLLOWING THE PATH from the registry.
 *
 * A fallback is a path in the bridge grants (`bridge_grants.agent`), so the
 * answer really is there. Following this path instead of setting a little table
 * "which fallback means what" beside it: such a little table would give the answer of the first
 * to a SECOND fallback, and that is a wrong id — the one answer that we may not give.
 *
 * The grants carry their id as `<something>Id` (`agentId`, `datatableId`). If this
 * function finds none, the answer is `null` and the element remains
 * `unresolved`: not determinable, never guessed.
 */
function fallbackIdFromGrants(path, grants) {
    const parts = String(path || '').split('.');
    if (parts.shift() !== 'bridge_grants' || !parts.length) return null;
    let node = grants;
    for (const part of parts) {
        if (!node || typeof node !== 'object') return null;
        node = node[part];
    }
    if (typeof node === 'string') return node || null;
    if (!node || typeof node !== 'object') return null;
    const key = Object.keys(node).find(k => /Id$/.test(k) && typeof node[k] === 'string' && node[k]);
    return key ? node[key] : null;
}

function emptyTargets() {
    const out = {};
    for (const kind of bindingKinds()) out[kind] = [];
    return out;
}

/**
 * What hangs via a `bf-*` ELEMENT on this page?
 *
 * Two things that must stay apart, and that is the whole reason this function exists alongside the markings:
 *
 *   targets     what we CAN point to — per family a list with, per id,
 *               the places where it is used;
 *   unresolved  an element that does bind something, but of which it is not
 *               determinable WHAT. That is not "nothing": a page with three buttons of which
 *               the automation id is built on the spot is not a page without automations.
 *
 * @param {object|null} scan          the result of `scanBfElements`
 * @param {object} args
 * @param {Object<string,string|null>} args.fallbackIds  answer per fallback from
 *   the registry (`bridge_grants.agent` → the agent of the page). A fallback
 *   that is missing here is `unknown-fallback` — never a silent omission.
 */
/**
 * "This field could not be read" — as value, not as absence.
 *
 * `null` means here "the page has none"; this means "we do not know". A Symbol,
 * so that no real id can collide with it.
 */
const FALLBACK_UNREADABLE = Symbol('fallback-unreadable');

function collectUses(scan, { fallbackIds = {} } = {}) {
    const targets = emptyTargets();
    const perKind = new Map();
    const unresolved = [];

    for (const mark of (scan && Array.isArray(scan.marks) ? scan.marks : [])) {
        // An unknown element is already in `unknownTags`; there is nothing to bind
        // from it because we do not know what it would bind.
        if (!mark.known || !mark.family) continue;
        const where = { tag: mark.tag, source: mark.source, line: mark.line };
        const miss = (reason) => unresolved.push({
            ...where,
            kind: mark.family,
            reason,
            missing: mark.missing,
            dynamic: !!mark.dynamic,
        });

        let id = mark.targetId;
        let fromPage = false;
        if (!id && mark.fallback) {
            if (!Object.prototype.hasOwnProperty.call(fallbackIds, mark.fallback)) {
                miss('unknown-fallback');
                continue;
            }
            id = fallbackIds[mark.fallback];
            if (id === FALLBACK_UNREADABLE) { miss('page-binding-unreadable'); continue; }
            fromPage = true;
        }
        if (!id) {
            miss(mark.dynamic ? 'built-at-runtime' : (mark.fallback ? 'page-binding-unknown' : 'no-target'));
            continue;
        }

        if (!perKind.has(mark.family)) perKind.set(mark.family, new Map());
        const byId = perKind.get(mark.family);
        const entry = byId.get(id) || { id, fromPage: false, elements: [] };
        // "Did this id (also) come from the page itself?" — that distinction the column
        // should show: an agent that is named nowhere hangs on the PAGE and disappears
        // as soon as that binding is detached.
        entry.fromPage = entry.fromPage || fromPage;
        entry.elements.push(where);
        byId.set(id, entry);
    }

    for (const [kind, byId] of perKind) {
        if (!targets[kind]) targets[kind] = [];
        for (const entry of byId.values()) targets[kind].push({ ...entry, count: entry.elements.length });
    }
    return { targets, unresolved };
}

/** Dezelfde drie standen als `codeSection`, om dezelfde reden. */
function usesSection(scan, opts) {
    if (!scan) return { scanned: false, targets: emptyTargets(), unresolved: [] };
    return { scanned: true, ...collectUses(scan, opts) };
}

/**
 * The model behind the column "Lets happen".
 *
 * @param {object} args
 * @param {string} args.webpageId
 * @param {string} args.userId  the OWNER (the route is owner-only, just like
 *                              the grants beside it: this shows code content)
 */
async function describePageActions({ webpageId, userId }) {
    const code = await readPageCode(userId, webpageId);
    const scan = code.readable ? scanOutboundCalls(code) : null;
    const elements = code.readable ? scanBfElements(code) : null;

    let grants = null;
    let agentId = null;
    let agentKnown = true;
    try {
        grants = await bridgeGrants.getBridgeGrants(webpageId);
        agentId = grants && grants.agent && grants.agent.agentId ? grants.agent.agentId : null;
    } catch {
        // Unreadable grants are not "no agent": that difference is carried by `known`,
        // so that the card can stay silent instead of asserting.
        agentKnown = false;
    }

    // The answer to EVERY fallback that the vocabulary knows — today one: a
    // `<bf-agent>` without its own id runs the agent of the PAGE. The list comes
    // from the registry and the answer from the grants themselves, so a second
    // fallback gets its own answer automatically instead of that of the
    // first. Unreadable grants give `null`, and that is something other than "there is
    // none": the element then remains `unresolved` instead of disappearing.
    const fallbackIds = {};
    for (const path of declaredFallbacks()) {
        // FALLBACK_UNREADABLE, not `null`: both of them yielded `null`, and then
        // "this page has no agent bound" got the same reason as "the
        // grants could not be read". The comment above promised that
        // distinction; within `uses` it did not exist.
        fallbackIds[path] = agentKnown ? fallbackIdFromGrants(path, grants) : FALLBACK_UNREADABLE;
    }

    return {
        code: codeSection(scan),
        // Where the `bf-*` elements stand, per file and per line. The Code tab
        // draws its markings with this; `scanned:false` means there that the
        // legend must say that the marking could not be computed.
        elements: elementsSection(elements),
        // WELKE tabel, WELKE automatisering, WELKE agent — per familie, met de plekken
        // erbij. Dit is wat de middenkolom toont en wat de usage-index omdraait.
        uses: usesSection(elements, { fallbackIds }),
        // The elements THEMSELVES stand in `elements.marks`, each with its `tag`; these
        // two fields only say what the column may claim about that kind. They used to exist as
        // "we do not know this yet" placeholders; since `<bf-form>` and `<bf-agent>` really exist that is no longer true,
        // and `scanned` now carries the difference between "none" and "not looked at".
        forms: { supported: true, scanned: elements !== null },
        // The Agent block is INTERNAL-ONLY: `ai.ask` is deliberately kept out of the anonymous
        // bridge (services/publicShareBridge.js knows only /ai/chat and /ai/stream), so
        // a public share never runs it. The card says so
        // instead of letting the block silently do nothing.
        agent: {
            known: agentKnown,
            agentId: agentKnown ? agentId : null,
            supported: true,
            internalOnly: true,
            scanned: elements !== null,
        },
    };
}

module.exports = {
    describePageActions,
    scanOutboundCalls,
    scanBfElements,
    collectUses,
    readPageCode,
    // Voor de tests én voor W4, dat op dezelfde maskeerder verder bouwt.
    maskCode,
    maskComments,
    FALLBACK_UNREADABLE,
    classifyUrl,
    inlineScripts,
};

/**
 * @typedef {{ kind: string, method: string | null, url: string, urlPrefix: string, dynamic: boolean,
 *   host?: string, source: string, line: number }} OutboundCall
 */

/**
 * @typedef {{ source: string, slot: string | null, line: number, tag: string, known: boolean,
 *   family: string | null, targetId: string | null, dynamic: boolean, fallback: string | null,
 *   missing: string[] | null, reason: string | null }} BfMark
 */

/**
 * @typedef {{ id: string, fromPage: boolean, elements: Array<{ tag: string, source: string, line: number }>,
 *   count: number }} UseTarget
 */
