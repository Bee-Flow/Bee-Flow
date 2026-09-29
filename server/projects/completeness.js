/**
 * "Te controleren" — everything about this Solution that needs a person, in
 * ONE list, plus the single verdict the publish button reads.
 *
 * ── Why an aggregator rather than a fifth validator ─────────────────────────
 *
 * Four things already know what is wrong with a Solution and none of them
 * talked to each other:
 *
 *   appStudio/validate.js      a button wired to nothing (`component.control_inert`)
 *   automation/validate.js     a half-built routine, on the draft/activate ladder
 *   projects/graph.js          a broken, external or cross-owner reference
 *   stores/knowledgeBases      a base with no documents that something reads
 *
 * This module runs all four over the members of one project and emits the ONE
 * shape core/findings/finding.js defines, so the screen never has to know which
 * validator it is reading. Nothing is rephrased here: `message` and `hint` are
 * the producers' own words. What is ADDED is the two things a validator cannot
 * know — WHICH object the record belongs to (it only ever saw a definition) and
 * WHERE to send someone to fix it (`deepLink`).
 *
 * ── The ladder is kept, not flattened ───────────────────────────────────────
 *
 * A routine that is a DRAFT is validated at `stage: 'draft'`: its completeness
 * codes come back as warnings tagged `blockedAt: 'activate'` — advice, because a
 * half-built flow is the normal state of a flow being built. The same routine
 * once it is ACTIVE is validated at `stage: 'activate'` and those same codes
 * block. Flattening that into one severity is what BFSF-323 was about, so the
 * verdict travels on `blockedAt` and the ladder stays where it lives.
 *
 * ── UNKNOWN BLOCKS. This is the point of the module ─────────────────────────
 *
 * "v1.3 publiceren" is disabled while there are blocking findings, so the whole
 * gate hangs on this list being TRUE. A store that could not be read must
 * therefore never come back as "no findings": that reads as a clean Solution
 * and publishes a broken one. Every gap is named in `unavailable`, `complete`
 * goes false, and `blocked` goes TRUE — deliberately coarser than "did the gap
 * hide a blocker?", because a rule that reasons about which gaps are safe is a
 * rule that will eventually reason wrong. The caller must treat a 500, a
 * network failure and "not loaded yet" the same way: blocked.
 *
 * ── No I/O in the aggregation itself ────────────────────────────────────────
 *
 * `buildCompleteness` is pure: members in, findings out, so every rule below is
 * testable as a plain object. `collectCompleteness` is the thin async wrapper
 * that reads the one thing a definition cannot answer — how many documents a
 * knowledge base holds — and its stores are required LAZILY, inside the call,
 * for the same reason routes/projects.js does it: a store required at module
 * load reaches a real database in every test that only mocks the route's own.
 */

'use strict';

const { makeFinding, fromLegacy, bySeverity } = require('../core/findings/finding');
const log = require('../telemetry/log');

/**
 * Graph and store kinds → Finding kinds.
 *
 * The lists genuinely differ and quietly: kindColors (and therefore
 * FINDING_KINDS) spells a knowledge base `kb`, while the graph, the membership
 * registry and every store spell it `knowledge_base`. `makeFinding` THROWS on an
 * unknown kind, so without this map the single most common graph problem on an
 * agent-backed Solution would take the whole list down with it.
 */
const FINDING_KIND = Object.freeze({
    knowledge_base: 'kb',
    kb: 'kb',
    notebook: 'solution',      // a notebook has no tile of its own yet
    approval: 'solution',      // approvals are synthetic nodes, not objects
});

function toFindingKind(kind) {
    return FINDING_KIND[kind] || kind;
}

/**
 * Where "Show me" goes, per kind — the BUILDER's screen, not the consumer's.
 *
 * A finding is something to fix, so an app opens in App Studio
 * (`/app/studio/apps/:id`) rather than in its run view (`/app/apps/:id`); the
 * two are different pages and the second one cannot repair anything.
 *
 * Deliberately NOT carrying `?screen=`/`?node=`/`?step=` yet. App Studio does
 * not read the query string at all, and `?step=` already means "this step of
 * the open RUN" (parseStudioQuery → ExecutionsPanel), not "select this node in
 * the editor". A link that claims to land on the broken button and lands on the
 * app's first screen is a worse promise than a link to the app. The segments
 * mirror studioApps.jsx's `urlSegment`; when the editors learn to read a
 * selection out of the URL, this map is the one place that gains it.
 */
const DEEP_LINK = Object.freeze({
    app: (id) => `/app/studio/apps/${id}`,
    automation: (id) => `/app/studio/automations/${id}`,
    webpage: (id) => `/app/studio/webpages/${id}`,
    datatable: (id) => `/app/studio/datatables/${id}`,
    agent: (id) => `/app/studio/agents/${id}`,
    kb: (id) => `/app/studio/knowledge/${id}`,
    skill: (id) => `/app/studio/skills/${id}`,
    meeting: (id) => `/app/studio/meeting-notes/${id}`,
});

/**
 * Ids are opaque tokens today, and the day one is not, an unescaped `?` or `..`
 * in a path the client hands to `location.assign` is a navigation somewhere
 * nobody asked for. Encoded once, here, rather than trusted per builder.
 */
function safeSegment(id) { return encodeURIComponent(String(id)); }

/**
 * The deep link for a finding, or null.
 *
 * Null when the producer had no id — a validator that only saw a definition, or
 * a synthetic node (an approval, a form, "every meeting tagged X") that is not a
 * row anywhere. A "Show me" button that leads to `/app/studio/apps/null` is
 * worse than no button, so the caller gets `null` and renders nothing.
 */
function deepLinkFor(finding) {
    const ref = finding?.targetRef;
    const build = ref && DEEP_LINK[ref.kind];
    if (!build || !ref.id) return null;
    return build(safeSegment(ref.id));
}

/** Attach `deepLink` to a Finding. Kept separate so the shape stays validated. */
function withDeepLink(finding) {
    return { ...finding, deepLink: deepLinkFor(finding) };
}

/**
 * Edge kinds that WRITE into a knowledge base rather than read from it.
 *
 * A base fed by "every meeting tagged sales" and holding nothing yet is a base
 * waiting for its first meeting, not a broken one. A base something READS is a
 * different story: the agent grounded on it answers from nothing and says so to
 * nobody.
 */
const KB_WRITE_EDGES = new Set(['feeds']);

/**
 * The empty-knowledge-base rule.
 *
 * Not `blockedAt: 'publish'`, deliberately: a Blueprint carries the SHELL of a
 * knowledge base and never its documents (packaging/scrub.js
 * KNOWLEDGE_BASE_CONTENT), so an empty base is exactly what the recipient is
 * supposed to get. It is a problem for the LIVE Solution, which is what makes
 * it advice here rather than a gate.
 */
function emptyKnowledgeBaseFinding(kb) {
    return makeFinding({
        code: 'knowledge_base.empty_in_use',
        severity: 'warning',
        kind: 'kb',
        targetRef: { kind: 'kb', id: kb.id, title: kb.name || null },
        message: `"${kb.name || 'A knowledge base'}" is used for answers but holds no documents, so anything grounded on it finds nothing.`,
        remediation: 'Add a document or a source to the knowledge base, or disconnect it from what reads it.',
    });
}

/** Which stage a routine is validated at: what is live must be finishable. */
function stageFor(automation) {
    return (automation?.isActive && !automation?.isDraft) ? 'activate' : 'draft';
}

/**
 * Screen index path → the screen id that is actually IN THE DATABASE.
 *
 * The app validator's `path` is index-based (`screens[0].sections[1].children[2]`)
 * because that is the only address a definition-only validator has. The id is
 * what a link would need, so it is resolved here, where the row IS available.
 *
 * Both definitions are consulted and must AGREE. Validation runs on the
 * canonical copy, and canonicalize re-keys an id that does not match its format
 * — so reading the canonical id alone would hand out an id that exists nowhere
 * but in this response. Every stored definition was written through canonicalize
 * and the two therefore agree in practice; when they do not, the honest answer
 * is no id at all.
 */
function screenIdFromPath(stored, canonical, path) {
    const m = /^screens\[(\d+)\]/.exec(String(path || ''));
    if (!m) return null;
    const i = Number(m[1]);
    const a = Array.isArray(stored?.screens) ? stored.screens[i] : null;
    const b = Array.isArray(canonical?.screens) ? canonical.screens[i] : null;
    if (!a || !b || typeof a.id !== 'string' || !a.id || a.id !== b.id) return null;
    return a.id;
}

/**
 * Run one producer's records through the Finding shape.
 *
 * A record the shape refuses (a missing message, a kind nothing paints) is NOT
 * dropped quietly: it is counted as a gap, because a validator finding that
 * never reaches the screen is exactly the silence this module exists to remove.
 */
function convert(records, kind, target, miss, gapLabel) {
    const out = [];
    for (const rec of (records || [])) {
        try {
            // BOTH kind slots are normalised: `fromLegacy` reads
            // `legacy.targetRef.kind` in preference to the fallback, so a graph
            // problem carrying `knowledge_base` there would still throw.
            const normalised = { ...rec, kind: toFindingKind(rec.kind || kind) };
            if (rec.targetRef && typeof rec.targetRef === 'object') {
                normalised.targetRef = { ...rec.targetRef, kind: toFindingKind(rec.targetRef.kind || rec.kind || kind) };
            }
            out.push(fromLegacy(toFindingKind(kind), normalised, target));
        } catch {
            miss(gapLabel);
        }
    }
    return out;
}

/**
 * Every reference this Solution cannot carry, TYPED.
 *
 * The manifest's own `requires` is a `{ kind, count }` list and stays exactly
 * that — install.js prints `${requirement.count} ${requirement.kind}(s)` and
 * packaging is frozen. This is the richer preview the export dialog shows
 * BEFORE anything is written: the same facts with the step, the layer and the
 * author's own table key attached, so "you will have to pick a table again"
 * becomes "step 'Log the invoice' wants the table you call `invoices`".
 *
 * Two sources, and both are READ rather than changed:
 *   - `scrubAutomationDefinition` on a CLONE. It is a pure function from frozen
 *     territory that mutates only what it is handed, and it already records
 *     exactly these facts — capture.js just throws its report away.
 *   - the graph's externals, which is what the manifest counts too, so the two
 *     cannot disagree about what leaves the bundle.
 *
 * A WEBPAGE SLUG is deliberately absent, though the brief asks for one: webpages
 * have no slug column (stores/webpage/schema.js), and the only slug-shaped
 * public identifier in this area is `automation_form_pages.id` — which is the
 * form's URL *and* its only credential, and must never appear in a graph, a
 * Blueprint or a preview of one.
 *
 * AND IT SAYS WHAT IT COULD NOT READ. `unreadable` names the sections this walk
 * had to skip, and the caller folds it into the same `unavailable` list every
 * other gap goes into. Both skips below used to be silent, and silence here is
 * the worst possible lie: the export dialog renders an empty "whoever installs
 * this has to supply …" list, and an empty list of things to supply is exactly
 * what a self-contained Solution looks like. "Nobody looked" and "nothing
 * needed" must not print the same screen.
 *
 * @returns {{items: object[], counts: object, unreadable: string[]}}
 */
function collectRequires({ automations = [], graph = null } = {}) {
    const { scrubAutomationDefinition, RULES } = require('./packaging/scrub');
    const items = [];
    const unreadable = [];
    const cannotRead = (label) => { if (!unreadable.includes(label)) unreadable.push(label); };

    // A missing `graph` is NOT reported here. Whether the graph could be built
    // is `buildGraphForProject`'s own answer, and it reaches the verdict
    // through `unavailable` — reporting it a second time from this walk would
    // make the pure function block on its own documented default, which is
    // what a caller asking only about routines passes.

    for (const a of automations.filter(Boolean)) {
        if (!a.definition || typeof a.definition !== 'object') {
            // A routine handed over without its definition. The contract says
            // callers pass definitions; one that does not gets a named gap
            // rather than a clean bill for a routine nobody opened.
            cannotRead('automations');
            continue;
        }
        let report;
        try {
            report = scrubAutomationDefinition(structuredClone(a.definition));
        } catch {
            cannotRead('automations');
            continue;
        }
        for (const rec of report) {
            const base = {
                automationId: a.id, automationTitle: a.title || null,
                stepId: rec.stepId || null, layerKey: rec.layerKey || null,
            };
            if (rec.rule === RULES.AUTOMATION_DATATABLE_REFERENCE) {
                items.push({ ...base, kind: 'datatable', datatableKey: rec.datatableKey || null, field: rec.field || null });
            } else if (rec.rule === RULES.AUTOMATION_CONNECTION_REFERENCE) {
                items.push({ ...base, kind: 'connection' });
            } else if (rec.rule === RULES.AUTOMATION_APPROVER_IDENTITY) {
                items.push({ ...base, kind: 'approver', field: rec.field || null });
            } else if (rec.rule === RULES.AUTOMATION_KNOWLEDGE_BASE_REFERENCE) {
                items.push({ ...base, kind: 'knowledge_base', field: rec.field || null });
            }
        }
    }

    // What leaves the bundle by reference. The id is the only handle the
    // installer has; it is the same id GET /:id/graph already returns to the
    // same viewer+ audience, and it never travels into a manifest.
    for (const ext of (graph?.externals || [])) {
        items.push({
            kind: ext.kind, externalId: ext.id,
            referencedBy: Array.isArray(ext.referencedBy) ? ext.referencedBy.length : 0,
        });
    }

    const counts = {};
    for (const it of items) counts[it.kind] = (counts[it.kind] || 0) + 1;
    return { items, counts, unreadable };
}

/**
 * The aggregation itself. Pure.
 *
 * @param {object}   input
 * @param {object}   input.graph            the result of buildGraphForProject (nodes/edges/problems)
 * @param {Array}    input.apps             apps WITH their definitions
 * @param {Array}    input.automations      routines WITH definition/isActive/isDraft
 * @param {Array}    input.knowledgeBases   the bases filed into this project
 * @param {Map|object} input.kbDocumentCounts  kb id → document count, or `null` per id when unread
 * @param {string[]} input.unavailable      sections the loader could not read
 * @returns {{findings: object[], blocked: boolean, complete: boolean, unavailable: string[], requires: object}}
 */
function buildCompleteness({
    graph = null, apps = [], automations = [], knowledgeBases = [],
    kbDocumentCounts = null, unavailable = [],
} = {}) {
    const gaps = [...(unavailable || [])];
    const miss = (label) => { if (!gaps.includes(label)) gaps.push(label); };
    const findings = [];

    // ── 1. Apps ─────────────────────────────────────────────────────────
    //
    // The definition is canonicalized first because the validator says it
    // assumes canonical input and an app stored before the v1→v2 migration
    // would otherwise report `shape.schema_version` — an ERROR, and therefore a
    // publish block, invented by this module rather than found by it.
    const { validateAppDefinition } = require('../appStudio/validate');
    const { canonicalizeAppDefinition } = require('../appStudio/canonicalize');
    for (const app of apps.filter(Boolean)) {
        let result;
        let canonical;
        try {
            canonical = canonicalizeAppDefinition(structuredClone(app.definition)).def;
            result = validateAppDefinition(canonical);
        } catch {
            // An app that cannot even be validated is not an app with no
            // problems. Say so, and block.
            miss('apps');
            continue;
        }
        const target = { id: app.id, title: app.name || null };
        for (const f of convert([...result.errors, ...result.warnings], 'app', target, miss, 'apps')) {
            const screenId = screenIdFromPath(app.definition, canonical, f.targetRef.path);
            findings.push(screenId ? { ...f, targetRef: { ...f.targetRef, screenId } } : f);
        }
    }

    // ── 2. Routines, on their own stage ─────────────────────────────────
    const { validateDefinition } = require('../automation/validate');
    for (const a of automations.filter(Boolean)) {
        // Same rule as the catch below it, which was already right: a routine
        // that could not be validated is not a routine without problems.
        // Arriving without a definition is the earlier version of that.
        if (!a.definition || typeof a.definition !== 'object') { miss('automations'); continue; }
        let result;
        try {
            result = validateDefinition(a.definition, { stage: stageFor(a) });
        } catch {
            miss('automations');
            continue;
        }
        const target = { id: a.id, title: a.title || null };
        findings.push(...convert([...result.errors, ...result.warnings], 'automation', target, miss, 'automations'));
    }

    // ── 3. A knowledge base something reads, holding nothing ────────────
    const readEdges = new Map();
    for (const e of (graph?.edges || [])) {
        if (!e?.to || KB_WRITE_EDGES.has(e.kind)) continue;
        readEdges.set(e.to, (readEdges.get(e.to) || 0) + 1);
    }
    const counts = kbDocumentCounts instanceof Map
        ? kbDocumentCounts
        : new Map(Object.entries(kbDocumentCounts || {}));
    for (const kb of knowledgeBases.filter(Boolean)) {
        if (!readEdges.get(`knowledge_base:${kb.id}`)) continue;
        const count = counts.has(kb.id) ? counts.get(kb.id) : undefined;
        // Unknown is NOT zero. A base whose document count could not be read
        // must not be accused of being empty — the gap is named instead.
        if (count === null || count === undefined) { miss('knowledgeBaseDocuments'); continue; }
        if (count === 0) findings.push(emptyKnowledgeBaseFinding(kb));
    }

    // ── 4. The dependency graph's own problems ──────────────────────────
    //
    // These already carry `kind` + `targetRef` (graph.js addProblem), so
    // `fromLegacy` only has to normalise the kind vocabulary. 'solution' is the
    // fallback for a problem raised by a synthetic node that belongs to no
    // object of its own.
    findings.push(...convert(graph?.problems, 'solution', null, miss, 'graphProblems'));

    // BEFORE the verdict, not after: what this walk could not read is part of
    // whether the picture is whole, and computing it afterwards meant its gaps
    // arrived too late to reach `complete`.
    const requires = collectRequires({ automations, graph });
    for (const label of requires.unreadable) miss(label);

    const complete = gaps.length === 0;
    const withLinks = findings.map(withDeepLink).sort(bySeverity);
    // The publish gate. `complete === false` is half the rule and the half that
    // is easy to leave out — see the module header.
    const blocked = !complete
        || withLinks.some(f => f.severity === 'error' || f.blockedAt === 'publish');

    return {
        findings: withLinks,
        blocked,
        complete,
        unavailable: gaps,
        requires,
    };
}

/**
 * The async wrapper: read what a definition cannot answer, then aggregate.
 *
 * Stores are required INSIDE the call on purpose — see the module header.
 */
async function collectCompleteness({
    graph = null, apps = [], automations = [], knowledgeBases = [], unavailable = [],
} = {}) {
    const kbStore = require('../stores/knowledgeBases');
    const kbDocumentCounts = new Map();
    for (const kb of (knowledgeBases || []).filter(Boolean)) {
        try {
            const counts = await kbStore.countDocumentsByStatus(kb.id);
            const n = Number(counts?.documentCount);
            // `null` is the honest answer to a store that replied with nothing
            // usable — buildCompleteness turns it into a named gap, never a 0.
            kbDocumentCounts.set(kb.id, Number.isFinite(n) ? n : null);
        } catch (err) {
            log.warn('[Projects] completeness: could not count documents:', err.message);
            kbDocumentCounts.set(kb.id, null);
        }
    }
    return buildCompleteness({ graph, apps, automations, knowledgeBases, kbDocumentCounts, unavailable });
}

module.exports = {
    buildCompleteness,
    collectCompleteness,
    collectRequires,
    deepLinkFor,
    // Exported for routes/studio/attention.js, which asks the same question of
    // every knowledge base an ORGANISATION can see rather than of one Solution's
    // members. Only the "is it read by anything" half differs there (a graph
    // edge here, core/kb/kbUsage there); the RULE — the code, the severity, the
    // sentence and why it is advice rather than a publish block — must stay one
    // rule, or Studio Home and a Solution start saying different things about
    // the same empty base.
    emptyKnowledgeBaseFinding,
    toFindingKind,
    stageFor,
};
