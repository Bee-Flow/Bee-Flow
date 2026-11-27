// @typecheck strict
'use strict';
/**
 * Two pieces of the builder's findings that are core: where "Show me" goes for a finding
 * (deepLinkFor), and the empty-knowledge-base rule (emptyKnowledgeBaseFinding). Studio Home asks
 * both of everything an organisation can see (routes/studio/attention.js, attentionChecks.js),
 * with or without the projects module; a Solution's completeness (projects/completeness.js)
 * asks the same two of its members, so both say the same thing about the same object.
 *
 * Cut from projects/completeness.js unchanged (JSDoc types added), which requires them from here.
 */

const { makeFinding } = require('./finding');

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
    app: (/** @type {string} */ id) => `/app/studio/apps/${id}`,
    automation: (/** @type {string} */ id) => `/app/studio/automations/${id}`,
    webpage: (/** @type {string} */ id) => `/app/studio/webpages/${id}`,
    datatable: (/** @type {string} */ id) => `/app/studio/datatables/${id}`,
    agent: (/** @type {string} */ id) => `/app/studio/agents/${id}`,
    kb: (/** @type {string} */ id) => `/app/studio/knowledge/${id}`,
    skill: (/** @type {string} */ id) => `/app/studio/skills/${id}`,
    meeting: (/** @type {string} */ id) => `/app/studio/meeting-notes/${id}`,
});

/**
 * Ids are opaque tokens today, and the day one is not, an unescaped `?` or `..`
 * in a path the client hands to `location.assign` is a navigation somewhere
 * nobody asked for. Encoded once, here, rather than trusted per builder.
 * @param {string | number} id
 */
function safeSegment(id) { return encodeURIComponent(String(id)); }

/**
 * The deep link for a finding, or null.
 *
 * Null when the producer had no id — a validator that only saw a definition, or
 * a synthetic node (an approval, a form, "every meeting tagged X") that is not a
 * row anywhere. A "Show me" button that leads to `/app/studio/apps/null` is
 * worse than no button, so the caller gets `null` and renders nothing.
 * @param {{ targetRef?: { kind?: string | null, id?: string | number | null } | null } | null | undefined} finding
 * @returns {string | null}
 */
function deepLinkFor(finding) {
    const ref = finding?.targetRef;
    if (!ref || !ref.id) return null;
    const build = ref.kind ? DEEP_LINK[/** @type {keyof typeof DEEP_LINK} */ (ref.kind)] : undefined;
    if (!build) return null;
    return build(safeSegment(ref.id));
}

/**
 * The empty-knowledge-base rule.
 *
 * Not `blockedAt: 'publish'`, deliberately: a Blueprint carries the SHELL of a
 * knowledge base and never its documents (packaging/scrub.js
 * KNOWLEDGE_BASE_CONTENT), so an empty base is exactly what the recipient is
 * supposed to get. It is a problem for the LIVE Solution, which is what makes
 * it advice here rather than a gate.
 * @param {{ id: string, name?: string | null }} kb
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

module.exports = { DEEP_LINK, deepLinkFor, emptyKnowledgeBaseFinding };
