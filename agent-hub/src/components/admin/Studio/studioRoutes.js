import { STUDIO_APPS } from './studioApps';
import { STUDIO_START } from './studioStart';
import { getRuntimeStudioApps } from '../../../moduleRuntime/registry';

// URL segment ↔ Studio section maps, derived from the app registry so a new
// Studio app only has to declare its slug once. Consumed by App.jsx (URL
// parsing + the navigateToPage 'studio/...' handler) and kept free of any
// other imports so it can't drag components into the main chunk.
//
// Runtime (remotely-installed) modules add their own segments too. The static
// SEG_TO_SECTION / SECTION_TO_SEG below stay built-in-only (stable constants);
// sectionFromRaw/segmentForSection consult the LIVE runtime list after the
// static map so a deep link into a remote module's tab resolves once its
// descriptor loads — built-ins always win a segment collision.

// Accepted raw segments: the canonical urlSegment, the section id itself
// (navigation code historically passed e.g. 'studio/meetingNotes'), and any
// declared legacy slugs (e.g. 'ai-tasks' for routines).
// Start is not in STUDIO_APPS (see studioStart.js) but IS a built-in segment,
// so it joins the static maps here rather than being special-cased in every
// lookup below.
export const SEG_TO_SECTION = Object.fromEntries(
    [...STUDIO_APPS, STUDIO_START].flatMap((app) => [
        [app.urlSegment, app.id],
        [app.id, app.id],
        ...(app.legacySegments || []).map((seg) => [seg, app.id]),
    ])
);

export const SECTION_TO_SEG = Object.fromEntries(
    [...STUDIO_APPS, STUDIO_START].map((app) => [app.id, app.urlSegment])
);

// TWO different absences, and they resolve differently on purpose (Track H1):
//
//   NO segment at all (/app/studio) → Start. The rail's landing row; asking
//   for "Studio" with nothing after it is asking for its front door, not for
//   whichever section happened to be listed first.
//
//   An UNKNOWN segment (/app/studio/nope, /app/studio/support) → Agents, the
//   legacy switch behaviour. An old bookmark into a retired section lands on
//   a working screen instead of a front door that silently swallowed what it
//   asked for.
//
// Built-in segments resolve first; then the live runtime module list.
export function sectionFromRaw(raw) {
    if (!raw) return STUDIO_START.id;
    if (SEG_TO_SECTION[raw]) return SEG_TO_SECTION[raw];
    for (const app of getRuntimeStudioApps()) {
        if (raw === app.urlSegment || raw === app.id || (app.legacySegments || []).includes(raw)) {
            return app.id;
        }
    }
    return 'agents';
}

export function segmentForSection(section) {
    if (SECTION_TO_SEG[section]) return SECTION_TO_SEG[section];
    const app = getRuntimeStudioApps().find((a) => a.id === section);
    return app ? app.urlSegment : section;
}

// Parse /app/studio/{section}/{id?}/{sub?}/{subId?} → { section, id?, sub?, subId?, automationKind? }
// 'routines' is the canonical URL slug; 'ai-tasks' is accepted for backward compat.
//
// The FOURTH segment (`subId`) exists for a screen nested inside a tab:
// Knowledge uses `/studio/knowledge/<kb>/sources/<sourceId>`, so "these two
// files were skipped" is a link somebody can send. Automations already consumed
// the same slot for a reusable step's flowlet, which is why the reserved
// "steps" branch below shifts everything one segment along.
export function parseStudioUrl(pathname) {
    // Legacy /app/webpages[/<id>] paths route into Studio's Webpages section.
    const wp = pathname.match(/^\/app\/webpages(?:\/([^/]+))?/);
    if (wp) return { section: 'webpages', id: wp[1] || null, sub: null, subId: null, automationKind: null };
    // Legacy /app/notebooks[/<id>] paths: a notebook is a document type, so they
    // land in Documents, on that notebook (`notebook/<id>`, see notebookRef).
    const nb = pathname.match(/^\/app\/notebooks(?:\/([^/]+))?/);
    if (nb) return { section: 'documents', id: nb[1] ? 'notebook' : null, sub: nb[1] || null, subId: null, automationKind: null };
    // Legacy /app/meeting-notes[/<id>] paths route into Studio's Meeting Notes section.
    const mn = pathname.match(/^\/app\/meeting-notes(?:\/([^/]+))?/);
    if (mn) return { section: 'meetingNotes', id: mn[1] || null, sub: null, subId: null, automationKind: null };
    // Legacy top-level /app/automations, /app/routines and /app/ai-tasks
    // [/<id>]: the old standalone page. Automations live in Studio, so these
    // open that section, on the automation the path names.
    const au = pathname.match(/^\/app\/(?:automations|routines|ai-tasks)(?:\/([^/]+))?/);
    if (au) return { section: 'aiTasks', id: au[1] || null, sub: null, subId: null, automationKind: null };
    const m = pathname.match(/^\/app\/studio(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?(?:\/([^/]+))?/);
    // No segment → Start (sectionFromRaw draws the same line for the same
    // reason); an unknown one still falls back to Agents inside it.
    const seg = m?.[1] || STUDIO_START.urlSegment;
    let id = m?.[2] || null;
    // Third path segment — Automations uses it for a flowlet (layer) key,
    // Knowledge for the open tab.
    let sub = m?.[3] || null;
    // Fourth — a thing inside that tab (Knowledge: the open source).
    let subId = m?.[4] || null;
    // Reusable Steps live under /studio/automations/steps/<id>[/<flowletKey>].
    // The literal "steps" id segment is reserved (no automation can use it).
    // 'routines' / 'ai-tasks' are the slugs this tab used before it was named
    // after the one thing it holds; both still parse.
    let automationKind = null;
    if ((seg === 'automations' || seg === 'routines' || seg === 'ai-tasks') && id === 'steps') {
        automationKind = 'step';
        id = m?.[3] || null;
        sub = m?.[4] || null;
        subId = m?.[5] || null;
    }
    const section = sectionFromRaw(seg);
    return { section, id, sub, subId, automationKind };
}

// ── Query-string state: ?view=<view>&run=<runId>&step=<stepId> ─────────────
// The builder's open VIEW, open RUN and selected run STEP live in the query
// string, so a run — and the step inside it — can be bookmarked, refreshed,
// pasted to a colleague, and re-opened by Back/Forward. parseStudioUrl's
// return shape stays untouched: path = which automation, query = what of it is
// open.
//
// URL word is `runs` (user-facing); the builder tab id stays `history`
// (BFSF-343 — it is a persisted initialTab value threaded through half a
// dozen call sites). Map at the edges, never rename the id.

/** Parse a location.search string → { view, runId, stepId, from } (nulls when absent). */
export function parseStudioQuery(search) {
    const q = new URLSearchParams(String(search || '').replace(/^\?/, ''));
    return {
        view: q.get('view') || null,
        runId: q.get('run') || null,
        stepId: q.get('step') || null,
        from: q.get('from') || null,
    };
}

/**
 * Build the query-string suffix for a builder state. Omits nulls, omits
 * `view` when it is the default Editor ('build'), and returns '' when
 * nothing needs saying — so plain automation URLs stay exactly as they were.
 */
export function buildStudioSearch({ view = null, runId = null, stepId = null, from = null } = {}) {
    const q = new URLSearchParams();
    if (view && view !== 'build') q.set('view', view);
    if (runId) q.set('run', runId);
    if (stepId) q.set('step', stepId);
    if (from) q.set('from', from);
    const s = q.toString();
    return s ? `?${s}` : '';
}

// ── ?from= — where the builder was OPENED from ─────────────────────────────
//
// `?from=app:<appId>:<screenId>:<nodeId>` says "you got here from this button,
// in this screen, of this app". The builder turns it into a breadcrumb strip;
// nothing else reads it, and nothing is allowed to: it is a LABEL, never an
// authorisation. What the viewer may be told about those three ids is decided
// server-side, per viewer (server/appStudio/appRefLookup.js).
//
// It has to survive every in-builder navigation, not just the first paint:
// switching to Runs or opening a run rebuilds the query from scratch, and a
// breadcrumb that vanishes on the first click is a one-way trip dressed up as
// a round one.
//
// Parsing is strict on purpose. This value arrives from the address bar, so it
// is attacker-controlled text: an id that does not look like an id is dropped
// whole rather than passed on to be rendered or put in a URL.

const APP_REF_PREFIX = 'app:';
// A studio app id is a crypto.randomUUID(); screen and node ids are App
// Studio's own `(scr|sec|cmp|act)_<4-12>` (state/definitionOps.js ID_RE).
// Mirrored, not imported — studioRoutes.js is in the MAIN chunk and must not
// drag App Studio's modules into it (see the import-discipline note above).
const APP_REF_APP_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const APP_REF_NODE_ID_RE = /^(scr|sec|cmp|act)_[a-z0-9]{4,12}$/;

/**
 * Parse a `from` token → { appId, screenId, nodeId }, or null.
 *
 * Null for anything that is not exactly one well-formed app reference: an
 * unknown prefix (later kinds of `from` are someone else's to add), the wrong
 * number of parts, or an id that does not match its format. Half a reference
 * is not a reference.
 */
export function parseAppRefParam(from) {
    const raw = String(from || '');
    if (!raw.startsWith(APP_REF_PREFIX)) return null;
    const parts = raw.slice(APP_REF_PREFIX.length).split(':');
    if (parts.length !== 3) return null;
    const [appId, screenId, nodeId] = parts;
    if (!APP_REF_APP_ID_RE.test(appId)) return null;
    if (!APP_REF_NODE_ID_RE.test(screenId)) return null;
    if (!APP_REF_NODE_ID_RE.test(nodeId)) return null;
    return { appId, screenId, nodeId };
}

/**
 * Which automation a `from` token still belongs to, as the open automation changes.
 *
 * `?from=` is about ONE automation — the one that was open when the link was
 * followed — and both halves of that have bitten before:
 *
 *   it must STICK. The builder rebuilds its whole query string from a state
 *   object on every view switch and every run opened, so a token that is not
 *   carried disappears on the first click. A way back that only works before
 *   you touch anything is not a way back.
 *
 *   it must NOT FOLLOW YOU. Opening a different automation keeps the same
 *   component mounted; re-attaching the trail there would claim that automation
 *   was made from a button it has never heard of.
 *
 * A builder opened with no automation in the path (a brand-new one, made from the
 * app) ADOPTS the first id that appears — that is the automation the link was
 * about, it just did not have an id yet.
 *
 * @param {{automationId: string|null, token: string|null}} prev
 * @param {string|null} automationId  the automation open right now
 * @returns the same object when nothing changed, so callers can `!==`-check.
 */
export function stickyFrom(prev, automationId) {
    if (!prev || !prev.token) return prev;
    if (prev.automationId == null && automationId) return { automationId, token: prev.token };
    if (automationId && automationId !== prev.automationId) return { automationId, token: null };
    return prev;
}

/**
 * Build the `from` token for an app reference, or null when the reference is
 * not complete enough to be one. Round-trips with parseAppRefParam.
 */
export function appRefParam(ref) {
    if (!ref) return null;
    const token = `${APP_REF_PREFIX}${ref.appId}:${ref.screenId}:${ref.nodeId}`;
    return parseAppRefParam(token) ? token : null;
}
