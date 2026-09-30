// @typecheck
'use strict';

/**
 * Which of an organisation's projects hold personal data — answered from
 * signals that are ALREADY persisted, never by opening content in a sweep.
 *
 *   files        project files whose ingest scan found personal data
 *                (documents.pii_status found|redacted, pii_categories)
 *   notebooks    project notebooks the Privacy Shield tokenised
 *                (notebooks.pii_token_map is set — presence only, never read)
 *   threads      chats shared into the project with a token map (same)
 *   events       Privacy Shield PII decisions of the last 90 days on the
 *                project's team chats and notebooks (guardrail_events:
 *                categories only)
 *   comments     the same on the project's comment threads (the AI's replies
 *                and the relevance gate that decides whether it joins)
 *   content      the background content scan of documents and notebooks
 *                (content_pii_signals, core/dlp/contentSignals.js), counted
 *                only when the scan was complete (a degraded row is unknown)
 *
 * ONLY PII DECISIONS COUNT. guardrail_events also records things that are not
 * about personal data at all — hidden-character smuggling ('3 hidden chars'),
 * the org's own regex rules, a detector that was down
 * ('privacy_protection_unavailable'), a scan that failed. Those must never
 * make a project a personal-data subject, so the event sources read
 * `violation_type = 'pii'` rows only, and every source keeps only categories
 * that normalise to a canonical PII id (core/privacy/piiCategories): an event
 * whose labels are none of those proves nothing.
 *
 * The answer per project is `{ categories: {Canonical: count}, kinds: [...],
 * sources: [...] }`. `kinds` come from the canonical categories
 * (core/privacy/personalColumns.kindOfCategory); a source that proves personal
 * data is present but not which kind (a token map, a flagged file without
 * categories) adds the kind 'personal'.
 *
 * ONE ROW PER PROJECT. Every source aggregates per project in SQL and orders
 * by project id, so its limit is a number of PROJECTS and the same projects
 * make it in every sweep. (Reading one row per file or event under a LIMIT
 * without an order let Postgres pick which 5000 rows came back, and projects
 * dropped in and out of the picture from one sweep to the next.) A source that
 * hits its limit is named in `truncated`: the projects it did return are real,
 * but the list is not the whole population, and a caller must not treat a
 * project missing from it as having no personal data.
 *
 * Each source is read on its own: a source this install does not have yet is
 * skipped (not provisioned), a source that FAILS is named in `unreadable`, so a
 * caller can say "could not read" rather than pass on a partial picture.
 *
 * Memoised per org for a short while, so a per-source check that asks for the
 * picture once to list its subjects and once per subject does not re-run the
 * same queries a hundred times in one sweep.
 */

const pd = require('./projectData');

const MEMO_TTL_MS = 60_000;
const EVENT_WINDOW_DAYS = 90;
// Kinds that make a finding about a project a FAILURE rather than a warning
// (special-category and national-identifier data, GDPR Art. 9 and 87).
const SPECIAL_KINDS = Object.freeze(['health', 'id_number']);
const GENERIC_KIND = 'personal';

function _defaults() {
    const piiCategories = () => require('../../core/privacy/piiCategories');
    return {
        query: pd.defaultQuery(),
        normalizeCategory: (c) => piiCategories().normalizeCategory(c),
        isCanonical: (c) => piiCategories().CANONICAL_IDS.includes(c),
        kindOfCategory: (c) => require('../../core/privacy/personalColumns').kindOfCategory(c),
        now: () => Date.now(),
    };
}

const ORG = pd.orgMatch('p.organization_id');
const WS = pd.isWorkspace('p');
// Projects one source may return. One more is asked for, to know the limit was hit.
const LIMIT = pd.ROW_LIMIT;
const PAGE = `ORDER BY project_id LIMIT ${LIMIT + 1}`;

/** Per project: `{label: count}` from `per_label(project_id, label, n)`. */
const LABELS_PER_PROJECT = `
    SELECT project_id, jsonb_object_agg(label, n) AS categories
    FROM per_label
    GROUP BY project_id
    ${PAGE}`;

/**
 * `(project_id, label, n)`: the window's Privacy Shield PII decisions on one
 * kind of project surface (`container` is the table whose id the events carry
 * as their conversation_id). Only `violation_type = 'pii'` — see the header.
 */
function eventLabels(sources, container) {
    const list = sources.map(s => `'${s}'`).join(', ');
    return `
        SELECT c.project_id, btrim(l.label) AS label, COUNT(*)::int AS n
        FROM guardrail_events g
        JOIN ${container} c ON c.id = g.conversation_id
        JOIN projects p ON p.id = c.project_id
        CROSS JOIN LATERAL unnest(string_to_array(g.violation_categories, ',')) AS l(label)
        WHERE ${pd.orgMatch('g.organization_id')}
          AND g.timestamp >= NOW() - INTERVAL '${EVENT_WINDOW_DAYS} days'
          AND COALESCE(g.is_dry_run, false) = false
          AND g.violation_type = 'pii'
          AND g.action_taken IS DISTINCT FROM 'scan_failed'
          AND g.violation_categories IS NOT NULL
          AND g.source IN (${list})
          AND ${ORG} AND ${WS} AND btrim(l.label) <> ''
        GROUP BY c.project_id, btrim(l.label)`;
}

/** The SQL of each source. Every one is org-scoped and bounded by a number of projects. */
const SOURCES = Object.freeze({
    // `uncategorised`: flagged files that carry no category at all.
    files: `
        WITH flagged AS (
            SELECT p.id AS project_id, d.pii_categories AS cats
            FROM projects p
            JOIN knowledge_bases kb ON kb.id::text = p.files_kb_id
            JOIN documents d ON d.knowledge_base_id = kb.id
            WHERE ${ORG} AND ${WS}
              AND kb.source_kind = 'project_files'
              AND d.pii_status IN ('found', 'redacted')
        ),
        per_label AS (
            SELECT f.project_id, l.label, COUNT(*)::int AS n
            FROM flagged f
            LEFT JOIN LATERAL (
                SELECT jsonb_array_elements_text(f.cats) AS label WHERE jsonb_typeof(f.cats) = 'array'
                UNION ALL
                SELECT jsonb_object_keys(f.cats) WHERE jsonb_typeof(f.cats) = 'object'
            ) l ON true
            GROUP BY f.project_id, l.label
        )
        SELECT project_id,
               COALESCE(jsonb_object_agg(label, n) FILTER (WHERE label IS NOT NULL), '{}'::jsonb) AS categories,
               COALESCE(SUM(n) FILTER (WHERE label IS NULL), 0)::int AS uncategorised
        FROM per_label
        GROUP BY project_id
        ${PAGE}`,
    notebooks: `
        SELECT n.project_id, COUNT(*)::int AS n
        FROM notebooks n JOIN projects p ON p.id = n.project_id
        WHERE ${ORG} AND ${WS} AND n.pii_token_map IS NOT NULL
        GROUP BY n.project_id
        ${PAGE}`,
    threads: `
        SELECT c.project_id, COUNT(*)::int AS n FROM (
            SELECT project_id FROM direct_conversations
             WHERE project_id IS NOT NULL AND shared_scope = 'project' AND pii_token_map IS NOT NULL
            UNION ALL
            SELECT project_id FROM agent_conversations
             WHERE project_id IS NOT NULL AND shared_scope = 'project' AND pii_token_map IS NOT NULL
        ) c JOIN projects p ON p.id = c.project_id
        WHERE ${ORG} AND ${WS}
        GROUP BY c.project_id
        ${PAGE}`,
    // A team chat and a notebook are two joins; their counts are summed.
    events: `
        WITH per_label AS (
            SELECT project_id, label, SUM(n)::int AS n FROM (
                ${eventLabels(['project_chat', 'project_chat_gate'], 'project_chats')}
                UNION ALL
                ${eventLabels(['notebook', 'notebook_chat'], 'notebooks')}
            ) surfaces
            GROUP BY project_id, label
        )
        ${LABELS_PER_PROJECT}`,
    // A separate source: comment threads are newer than the rest, and an
    // install that has not created their table yet must still read the others.
    comments: `
        WITH per_label AS (${eventLabels(['project_comment', 'project_comment_gate'], 'project_comment_threads')})
        ${LABELS_PER_PROJECT}`,
    // Only while the item is still filed in that project: a document that was
    // deleted or moved out takes its signal with it.
    content: `
        WITH items AS (
            SELECT s.project_id, s.categories, s.kinds
            FROM content_pii_signals s JOIN projects p ON p.id = s.project_id
            WHERE ${ORG} AND ${WS} AND s.degraded = false AND s.mention_count > 0
              AND (
                (s.subject_kind = 'studio_document' AND EXISTS (
                    SELECT 1 FROM studio_documents d WHERE d.id = s.subject_id AND d.project_id = s.project_id))
                OR (s.subject_kind = 'notebook_document' AND EXISTS (
                    SELECT 1 FROM notebooks n WHERE n.id = s.subject_id AND n.project_id = s.project_id))
                OR (s.subject_kind = 'project_chat' AND EXISTS (
                    SELECT 1 FROM project_chats c WHERE c.id = s.subject_id AND c.project_id = s.project_id))
              )
        ),
        per_label AS (
            SELECT i.project_id, e.key AS label,
                   SUM(CASE WHEN e.value ~ '^[0-9]+$' THEN e.value::bigint ELSE 0 END)::int AS n
            FROM items i
            CROSS JOIN LATERAL jsonb_each_text(CASE WHEN jsonb_typeof(i.categories) = 'object' THEN i.categories ELSE '{}'::jsonb END) AS e
            GROUP BY i.project_id, e.key
        ),
        per_kind AS (
            SELECT i.project_id, array_agg(DISTINCT k.kind ORDER BY k.kind) AS kinds
            FROM items i CROSS JOIN LATERAL unnest(i.kinds) AS k(kind)
            GROUP BY i.project_id
        ),
        hit AS (SELECT DISTINCT project_id FROM items)
        SELECT hit.project_id,
               COALESCE((SELECT jsonb_object_agg(l.label, l.n) FROM per_label l WHERE l.project_id = hit.project_id), '{}'::jsonb) AS categories,
               COALESCE(per_kind.kinds, ARRAY[]::text[]) AS kinds
        FROM hit LEFT JOIN per_kind ON per_kind.project_id = hit.project_id
        ORDER BY hit.project_id
        LIMIT ${LIMIT + 1}`,
});

function makeSignalReader(overrides = {}) {
    const d = { ..._defaults(), ...overrides };
    const memo = new Map(); // orgId -> { at, promise }

    /** A label as its canonical PII id, or null when it is not one. */
    function _canonical(raw) {
        const c = d.normalizeCategory(raw);
        return c && d.isCanonical(c) ? c : null;
    }

    /** `{label: n}` (a jsonb object, or its JSON text) → `{Canonical: n}`, PII ids only. */
    function _canonicalCounts(v) {
        let obj = v;
        if (typeof obj === 'string') { try { obj = JSON.parse(obj); } catch { obj = null; } }
        /** @type {Record<string, number>} */
        const out = {};
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
        for (const [label, n] of Object.entries(obj)) {
            const c = _canonical(label);
            if (c) out[c] = (out[c] || 0) + (Number(n) || 0);
        }
        return out;
    }

    /**
     * What one row of one source says about its project, or null when it
     * proves nothing.
     * @returns {{ categories?: Record<string, number>, kinds?: string[], generic?: boolean } | null}
     */
    function _signalOf(name, r) {
        if (name === 'notebooks' || name === 'threads') return { generic: true };
        const categories = _canonicalCounts(r.categories);
        const found = Object.keys(categories).length > 0;
        // A flagged file proves personal data even when it names no category.
        if (name === 'files') return { categories, generic: !found || Number(r.uncategorised) > 0 };
        if (name === 'content') {
            const kinds = Array.isArray(r.kinds) ? r.kinds.map(String) : [];
            return { categories, kinds, generic: !found && !kinds.length };
        }
        // events, comments: a decision whose labels are no PII id proves nothing.
        return found ? { categories } : null;
    }

    function _add(byProject, projectId, source, { categories = {}, kinds = [], generic = false }) {
        let e = byProject.get(projectId);
        if (!e) { e = { categories: {}, kinds: new Set(), sources: new Set() }; byProject.set(projectId, e); }
        e.sources.add(source);
        for (const [cat, n] of Object.entries(categories)) {
            e.categories[cat] = (e.categories[cat] || 0) + n;
            const kind = d.kindOfCategory(cat);
            if (kind) e.kinds.add(kind);
        }
        for (const k of kinds) e.kinds.add(k);
        if (generic) e.kinds.add(GENERIC_KIND);
    }

    async function _read(orgId) {
        const byProject = new Map();
        const unreadable = [];
        const truncated = [];
        for (const [name, sql] of Object.entries(SOURCES)) {
            let rows;
            try {
                rows = (await d.query(sql, [orgId])) || [];
            } catch (e) {
                if (pd.isNotProvisioned(e)) continue;
                unreadable.push(name);
                continue;
            }
            if (rows.length > LIMIT) {
                truncated.push(name);
                rows = rows.slice(0, LIMIT);
            }
            for (const r of rows) {
                if (!r || !r.project_id) continue;
                const signal = _signalOf(name, r);
                if (signal) _add(byProject, String(r.project_id), name, signal);
            }
        }
        const out = new Map();
        for (const [id, e] of byProject) {
            out.set(id, { categories: e.categories, kinds: [...e.kinds].sort(), sources: [...e.sources].sort() });
        }
        return { byProject: out, unreadable, truncated };
    }

    /**
     * @returns {Promise<{ byProject: Map<string, {categories: Record<string, number>, kinds: string[], sources: string[]}>, unreadable: string[], truncated: string[] }>}
     */
    function signalsFor(orgId) {
        const hit = memo.get(orgId);
        if (hit && d.now() - hit.at < MEMO_TTL_MS) return hit.promise;
        const promise = _read(orgId);
        memo.set(orgId, { at: d.now(), promise });
        promise.catch(() => memo.delete(orgId));
        return promise;
    }

    return { signalsFor, _forget: () => memo.clear() };
}

/** Does this set of kinds include special-category or national-id data? */
function hasSpecialKinds(kinds) {
    return (kinds || []).some(k => SPECIAL_KINDS.includes(k));
}

/**
 * The projects the signals say hold personal data, as per-source check
 * subjects — the population of GDPR-Art30-project-personal-data and
 * GDPR-Art5-1-e-project-retention.
 *
 * A source that FAILED throws: it could hide a project that is in fact a
 * subject, and the runner must keep the previous verdicts standing rather
 * than retire them. A source past its limit makes the list a window, not the
 * population (`complete: false`): the projects in it are judged, and none
 * outside it is retired.
 *
 * @param {{ signalsFor: (orgId: string) => Promise<{ byProject: Map<string, any>, unreadable: string[], truncated?: string[] }> }} reader
 * @param {string} orgId
 */
async function listPersonalDataProjects(reader, orgId) {
    const s = await reader.signalsFor(orgId);
    if (s.unreadable.length) throw new Error(`personal-data signals unreadable: ${s.unreadable.join(', ')}`);
    return {
        subjects: [...s.byProject.keys()].sort().map(id => pd.projectSubject(id)),
        complete: !(s.truncated || []).length,
    };
}

/**
 * The subject population the personal-data project checks share, spread into
 * each check: the list above, and the runner's permission to retire a project
 * that leaves it (it lost its last signal, or it was deleted) — worded as
 * such, because a project without signals may very well still exist.
 *
 * @param {() => { signals: { signalsFor: (orgId: string) => Promise<any> } }} defaultDeps
 */
function personalDataPopulation(defaultDeps) {
    return {
        retiresVanished: true,
        retiredDetails: 'No personal-data signal for this project any more, or the project was deleted.',
        /** @param {string} orgId */
        async listSubjects(orgId, deps = defaultDeps()) {
            return listPersonalDataProjects(deps.signals, orgId);
        },
    };
}

let _shared = null;
/** The process-wide reader the shipped checks use. */
function sharedReader() {
    if (!_shared) _shared = makeSignalReader();
    return _shared;
}

/**
 * The real dependencies of a personal-data project check that also reads the
 * org's own compliance records (GDPR-Art30-project-personal-data,
 * GDPR-Art5-1-e-project-retention): rows, the shared signal reader, the
 * compliance store (settings, processing records) and the clock.
 */
function recordCheckDeps() {
    return {
        query: pd.defaultQuery(),
        signals: sharedReader(),
        complianceStore: require('../../stores/complianceStore'),
        now: () => Date.now(),
    };
}

module.exports = {
    makeSignalReader, sharedReader, recordCheckDeps, hasSpecialKinds, listPersonalDataProjects, personalDataPopulation,
    SOURCES, SPECIAL_KINDS, GENERIC_KIND, EVENT_WINDOW_DAYS,
};
