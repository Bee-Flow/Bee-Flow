/**
 * Data Act export registry — every kind of data the platform holds for an
 * organisation, and the export route (if any) that lets the organisation take
 * it along when switching (Data Act Art. 30, Art. 23; DORA Art. 28(8) exit).
 *
 * This table is DECLARATIVE and deliberately includes the kinds that have NO
 * export route today (`route: null`): agents, knowledge bases (bulk),
 * conversations, AI webpages as a portable archive, form submissions. The
 * coverage check fails on those on purpose — an honest red is the point; the
 * gaps are product work (PLAN.md §3, optional stream BE-7).
 *
 * Two things keep the table honest:
 *   - `exportRegistry.test.js` mounts the REAL router modules and asserts every
 *     declared route `isMounted` (routeProbe.js), and that the mount prefixes
 *     here match `app.use(...)` in server/index.js. A route that moves turns
 *     that test red, not the customer's export.
 *   - `heldCountSql` is org-scoped (`$1`) for every kind that belongs to an
 *     organisation; the only platform-scoped kind (CMS sites, an admin-only
 *     website builder) says so with `heldScope: 'platform'`.
 *
 * Nothing here performs an export. Counts are counts; no row content is read.
 */

'use strict';

const path = require('path');
const routeProbe = require('./routeProbe');
const log = require('../../telemetry/log');

const SERVER_ROOT = path.resolve(__dirname, '..', '..');

// Formats the Data Act treats as "structured, commonly used, machine-readable"
// for the purpose of migration. PDF and plain HTML render; they do not migrate.
const MACHINE_READABLE_FORMATS = Object.freeze(['json', 'ndjson', 'csv', 'xlsx', 'xml', 'zip', 'md', 'docx']);
const KNOWN_FORMATS = Object.freeze([...MACHINE_READABLE_FORMATS, 'txt', 'pdf', 'html']);

const orgCount = (table, col = 'organization_id') => `SELECT COUNT(*)::int AS c FROM ${table} WHERE ${col} = $1`;
// A project's organisation, '' read as the 'default' bucket (see
// compliance/projects/projectData.js).
const projectOrg = `COALESCE(NULLIF(p.organization_id, ''), 'default') = $1`;
const viaUsers = (table, alias) =>
    `SELECT COUNT(*)::int AS c FROM ${table} ${alias} JOIN users u ON u.id = ${alias}.user_id WHERE u."organizationId" = $1`;

/**
 * @typedef {object} ExportKind
 * @property {string} kind            stable id, also the `subject_id` of export stamps
 * @property {string} labelKey        i18n key (compliance.pf_kind_<kind>)
 * @property {{method:string,path:string}|null} route  the export route as served, or null when none exists
 * @property {Array<{method:string,path:string}>} [extraRoutes] further routes of the same kind (other formats)
 * @property {{method:string,path:string,formats:string[]}|null} [renderOnly]
 *           a route that renders (PDF) but is not a portable export — listed so the probe keeps it honest
 * @property {string[]} formats       formats the portable route(s) produce
 * @property {'per-item'|'bulk'} scope
 * @property {{prefix:string,module:string,via?:string}|null} mount
 *           where the leaf router lives (module relative to server/) and the prefix index.js mounts its parent at
 * @property {string} heldCountSql    `SELECT COUNT(*)::int AS c …` — org-scoped with $1 unless heldScope is 'platform'
 * @property {'org'|'platform'} heldScope
 * @property {string|null} gapKey     i18n key describing the product gap when route is null
 */

/** @type {ReadonlyArray<ExportKind>} */
const EXPORT_KINDS = Object.freeze([
    {
        kind: 'automations', labelKey: 'compliance.pf_kind_automations',
        route: { method: 'GET', path: '/api/automation/:id/export' },
        formats: ['json'], scope: 'per-item',
        mount: { prefix: '/api/automation', module: 'routes/automation/crud', via: 'routes/automation' },
        heldCountSql: orgCount('automations'), heldScope: 'org', gapKey: null,
    },
    {
        kind: 'datatables', labelKey: 'compliance.pf_kind_datatables',
        route: { method: 'GET', path: '/api/datatables/:id/rows.csv' },
        formats: ['csv'], scope: 'per-item',
        mount: { prefix: '/api/datatables', module: 'routes/datatables' },
        heldCountSql: orgCount('datatables'), heldScope: 'org', gapKey: null,
    },
    {
        kind: 'studio_apps', labelKey: 'compliance.pf_kind_studio_apps',
        route: { method: 'GET', path: '/api/studio-apps/:id/data/export' },
        formats: ['json'], scope: 'per-item',
        mount: { prefix: '/api/studio-apps', module: 'routes/studioAppData' },
        heldCountSql: orgCount('studio_apps'), heldScope: 'org', gapKey: null,
    },
    {
        // The app's DESIGN, as opposed to `studio_apps` above, which is the rows
        // an app holds. Two kinds because they are two exports with two
        // audiences: a customer taking their data out, and a builder handing a
        // colleague the app itself.
        kind: 'app_templates', labelKey: 'compliance.pf_kind_app_templates',
        route: { method: 'GET', path: '/api/studio-apps/templates/:templateId/export' },
        formats: ['json'], scope: 'per-item',
        mount: { prefix: '/api/studio-apps', module: 'routes/studioApps' },
        heldCountSql: orgCount('studio_app_templates'), heldScope: 'org', gapKey: null,
    },
    {
        kind: 'cms_sites', labelKey: 'compliance.pf_kind_cms_sites',
        route: { method: 'GET', path: '/api/cms/sites/:siteId/export' },
        formats: ['zip', 'json'], scope: 'per-item',
        mount: { prefix: '/api/cms', module: 'routes/cms' },
        // The CMS is the platform's own website builder (admin-only, no org
        // column): the site index is one config row holding a JSON array.
        heldCountSql: `SELECT COALESCE((SELECT jsonb_array_length(value::jsonb) FROM config WHERE key = 'cms_projects_index'), 0)::int AS c`,
        heldScope: 'platform', gapKey: null,
    },
    {
        kind: 'solutions', labelKey: 'compliance.pf_kind_solutions',
        route: { method: 'POST', path: '/api/projects/:id/package/export' },
        formats: ['json'], scope: 'per-item',
        mount: { prefix: '/api/projects', module: 'routes/projects/packaging', via: 'routes/projects' },
        // Studio Solutions, plus legacy projects nobody has classified yet (the
        // export route serves both). A collaborative project (kind
        // 'workspace') is not a Solution and has no Blueprint export.
        heldCountSql: `${orgCount('projects')} AND (kind IS NULL OR kind = 'solution')`,
        heldScope: 'org', gapKey: null,
    },
    {
        kind: 'meeting_notes', labelKey: 'compliance.pf_kind_meeting_notes',
        route: { method: 'GET', path: '/api/transcriptions/:id/export' },
        formats: ['md', 'txt'], scope: 'per-item',
        mount: { prefix: '/api/transcriptions', module: 'routes/transcriptions/noteActions', via: 'routes/transcriptions' },
        heldCountSql: orgCount('transcriptions'), heldScope: 'org', gapKey: null,
    },
    {
        kind: 'notebooks', labelKey: 'compliance.pf_kind_notebooks',
        route: { method: 'POST', path: '/api/notebooks/:id/export/docx' },
        extraRoutes: [{ method: 'POST', path: '/api/notebooks/:id/export/pdf' }],
        formats: ['docx', 'pdf'], scope: 'per-item',
        mount: { prefix: '/api/notebooks', module: 'routes/notebookExport' },
        heldCountSql: viaUsers('notebooks', 'n'), heldScope: 'org', gapKey: null,
    },
    {
        kind: 'dsr_requests', labelKey: 'compliance.pf_kind_dsr_requests',
        route: { method: 'GET', path: '/api/dsr/requests/:id/export' },
        formats: ['json'], scope: 'per-item',
        mount: { prefix: '/api/dsr', module: 'routes/dsr' },
        heldCountSql: orgCount('dsr_requests'), heldScope: 'org', gapKey: null,
    },
    {
        kind: 'access_audit', labelKey: 'compliance.pf_kind_access_audit',
        route: { method: 'GET', path: '/api/compliance/access-audit/export' },
        formats: ['json'], scope: 'bulk',
        mount: { prefix: '/api/compliance', module: 'routes/compliance/accessAudit', via: 'routes/compliance' },
        heldCountSql: orgCount('access_audit_log'), heldScope: 'org', gapKey: null,
    },
    {
        kind: 'compliance_evidence', labelKey: 'compliance.pf_kind_compliance_evidence',
        route: { method: 'GET', path: '/api/compliance/iso/evidence-bundle.zip' },
        formats: ['zip'], scope: 'bulk',
        mount: { prefix: '/api/compliance', module: 'routes/compliance/isoAuditPack', via: 'routes/compliance' },
        heldCountSql: orgCount('compliance_evidence'), heldScope: 'org', gapKey: null,
    },
    {
        kind: 'memories', labelKey: 'compliance.pf_kind_memories',
        route: { method: 'GET', path: '/agents/memory/export/all' },
        formats: ['json'], scope: 'bulk',
        mount: { prefix: '/agents/memory', module: 'routes/memory' },
        heldCountSql: viaUsers('user_memories', 'm'), heldScope: 'org', gapKey: null,
    },

    // ── Kinds held WITHOUT a portable export route (product gaps) ──────────
    {
        kind: 'agents', labelKey: 'compliance.pf_kind_agents',
        route: null, formats: [], scope: 'per-item', mount: null,
        heldCountSql: orgCount('agents'), heldScope: 'org', gapKey: 'compliance.pf_gap_agents',
    },
    {
        kind: 'knowledge_bases', labelKey: 'compliance.pf_kind_knowledge_bases',
        route: null, formats: [], scope: 'bulk', mount: null,
        heldCountSql: orgCount('knowledge_bases'), heldScope: 'org', gapKey: 'compliance.pf_gap_knowledge_bases',
    },
    {
        // Private AI chats (agent and direct). The team chats of collaborative
        // projects are their own kind below, so neither is counted twice.
        kind: 'conversations', labelKey: 'compliance.pf_kind_conversations',
        route: null, formats: [], scope: 'bulk', mount: null,
        heldCountSql: `SELECT ((SELECT COUNT(*) FROM agent_conversations c JOIN users u ON u.id = c.user_id WHERE u."organizationId" = $1)
                             + (SELECT COUNT(*) FROM direct_conversations d JOIN users u2 ON u2.id = d.user_id WHERE u2."organizationId" = $1))::int AS c`,
        heldScope: 'org', gapKey: 'compliance.pf_gap_conversations',
    },

    // ── Collaborative projects (the workspace side, not Solutions) ─────────
    //
    // Counted with the org match every project check uses: an org-less
    // project ('' organisation) belongs to the 'default' bucket.
    {
        // Team chats inside projects (stores/projectChatStore.js). Sealed with
        // the project key; no export yet.
        kind: 'team_chats', labelKey: 'compliance.pf_kind_team_chats',
        route: null, formats: [], scope: 'bulk', mount: null,
        heldCountSql: `SELECT COUNT(*)::int AS c FROM project_chats pc JOIN projects p ON p.id = pc.project_id WHERE ${projectOrg}`,
        heldScope: 'org', gapKey: 'compliance.pf_gap_team_chats',
    },
    {
        // Files uploaded into a project, held in its files knowledge base.
        kind: 'project_files', labelKey: 'compliance.pf_kind_project_files',
        route: null, formats: [], scope: 'bulk', mount: null,
        heldCountSql: `SELECT COUNT(*)::int AS c FROM projects p
                       JOIN knowledge_bases kb ON kb.id::text = p.files_kb_id
                       JOIN documents d ON d.knowledge_base_id = kb.id
                       WHERE ${projectOrg} AND kb.source_kind = 'project_files'`,
        heldScope: 'org', gapKey: 'compliance.pf_gap_project_files',
    },
    {
        // Studio documents: a PDF render per document exists, which is not a
        // portable export — declared so the probe keeps it honest.
        kind: 'studio_documents', labelKey: 'compliance.pf_kind_studio_documents',
        route: null, formats: [], scope: 'per-item',
        renderOnly: { method: 'GET', path: '/api/studio-documents/:id/pdf', formats: ['pdf'] },
        mount: { prefix: '/api/studio-documents', module: 'routes/studioDocuments' },
        heldCountSql: viaUsers('studio_documents', 'sd'), heldScope: 'org', gapKey: 'compliance.pf_gap_studio_documents',
    },
    {
        // The workspace itself: members, instructions, activity. No export of
        // a whole project exists — an honest gap, not an oversight.
        kind: 'project_workspaces', labelKey: 'compliance.pf_kind_project_workspaces',
        route: null, formats: [], scope: 'per-item', mount: null,
        heldCountSql: `SELECT COUNT(*)::int AS c FROM projects p WHERE ${projectOrg} AND (p.kind IS NULL OR p.kind = 'workspace')`,
        heldScope: 'org', gapKey: 'compliance.pf_gap_project_workspaces',
    },
    {
        // Comments on project notebooks and documents
        // (stores/projectCommentStore.js). Sealed with the project key; no
        // export yet.
        kind: 'project_comments', labelKey: 'compliance.pf_kind_project_comments',
        route: null, formats: [], scope: 'bulk', mount: null,
        heldCountSql: `SELECT COUNT(*)::int AS c FROM project_comments pc JOIN projects p ON p.id = pc.project_id
                       WHERE ${projectOrg} AND pc.deleted_at IS NULL`,
        heldScope: 'org', gapKey: 'compliance.pf_gap_project_comments',
    },
    {
        // The version history of notebooks: the notebook export above takes
        // the CURRENT content only, so the earlier versions are a gap.
        kind: 'notebook_versions', labelKey: 'compliance.pf_kind_notebook_versions',
        route: null, formats: [], scope: 'per-item', mount: null,
        heldCountSql: `SELECT COUNT(*)::int AS c FROM notebook_versions v JOIN notebooks n ON n.id = v.notebook_id
                       JOIN users u ON u.id = n.user_id WHERE u."organizationId" = $1`,
        heldScope: 'org', gapKey: 'compliance.pf_gap_notebook_versions',
    },
    {
        kind: 'ai_webpages', labelKey: 'compliance.pf_kind_ai_webpages',
        route: null, formats: [], scope: 'per-item',
        // A PDF render exists; it is not an export (no HTML/CSS/JS slots, no
        // extra files). Declared so the probe keeps it honest and the
        // formats check can say "pdf-only" instead of "nothing".
        renderOnly: { method: 'POST', path: '/api/webpages/:id/export/pdf', formats: ['pdf'] },
        mount: { prefix: '/api/webpages', module: 'routes/webpageExport' },
        heldCountSql: viaUsers('webpages', 'w'), heldScope: 'org', gapKey: 'compliance.pf_gap_ai_webpages',
    },
    {
        kind: 'form_submissions', labelKey: 'compliance.pf_kind_form_submissions',
        route: null, formats: [], scope: 'bulk', mount: null,
        heldCountSql: `SELECT COALESCE(SUM(p.submissions), 0)::int AS c FROM automation_form_pages p JOIN automations a ON a.id = p.automation_id WHERE a.organization_id = $1`,
        heldScope: 'org', gapKey: 'compliance.pf_gap_form_submissions',
    },
]);

function getKind(kind) {
    return EXPORT_KINDS.find(k => k.kind === kind) || null;
}

/** Kinds with a portable export route — the ones whose stamps count as "an export was performed". */
function portableKinds() {
    return EXPORT_KINDS.filter(k => k.route).map(k => k.kind);
}

/**
 * Every route the table declares, flattened: primary, extra and render-only.
 * @returns {Array<{kind:string,method:string,path:string,mount:object,role:'primary'|'extra'|'render_only'}>}
 */
function declaredRoutes() {
    const out = [];
    for (const k of EXPORT_KINDS) {
        if (k.route) out.push({ kind: k.kind, ...k.route, mount: k.mount, role: 'primary' });
        for (const r of k.extraRoutes || []) out.push({ kind: k.kind, ...r, mount: k.mount, role: 'extra' });
        if (k.renderOnly) out.push({ kind: k.kind, method: k.renderOnly.method, path: k.renderOnly.path, mount: k.mount, role: 'render_only' });
    }
    return out;
}

// ── Mounted? ────────────────────────────────────────────────────────────────
//
// The check has no handle on the live `app`, so the leaf router is required
// (already in require.cache in the running server) and mounted on a throwaway
// express app at the prefix index.js uses — the probe then sees the same
// prefix normalisation the real app applies. Memoised per module: route
// tables do not change at runtime.

const _apps = new Map();
function _appFor(mount) {
    const key = `${mount.prefix} ${mount.module}`;
    if (_apps.has(key)) return _apps.get(key);
    let app = null;
    try {
        const router = require(path.join(SERVER_ROOT, mount.module));
        const express = require('express');
        app = express();
        app.use(mount.prefix, router);
    } catch (e) {
        app = null;
        log.warn(`[ExportRegistry] could not load ${mount.module}: ${e.message}`);
    }
    _apps.set(key, app);
    return app;
}

/**
 * @param {ExportKind} entry
 * @param {{method:string,path:string}} [route=entry.route]
 * @returns {boolean}
 */
function resolveMounted(entry, route = entry.route) {
    if (!route || !entry?.mount) return false;
    const app = _appFor(entry.mount);
    if (!app) return false;
    return routeProbe.isMounted(app, route.method, route.path);
}

function clearCache() { _apps.clear(); }

// ── Held counts ─────────────────────────────────────────────────────────────

function _paramsFor(sql, orgId) {
    return /\$1\b/.test(sql) ? [orgId] : [];
}

/**
 * One round trip for all kinds (scalar subqueries); per-kind fallback when a
 * table is missing on this install (42P01) or lacks a column (42703), so one
 * unprovisioned table cannot blank the whole matrix. A kind that cannot be
 * counted comes back `null` — unknown, never 0.
 * @returns {Promise<{counts:Record<string,number|null>, errors:Record<string,string>}>}
 */
async function heldCounts(orgId, { db } = {}) {
    const { getOne } = db || require('../../db');
    const counts = {};
    const errors = {};
    const combined = `SELECT ${EXPORT_KINDS.map(k => `(${k.heldCountSql}) AS "${k.kind}"`).join(',\n       ')}`;
    try {
        const row = await getOne(combined, _paramsFor(combined, orgId));
        for (const k of EXPORT_KINDS) counts[k.kind] = _num(row?.[k.kind]);
        return { counts, errors };
    } catch { /* fall through to per-kind */ }
    for (const k of EXPORT_KINDS) {
        try {
            const row = await getOne(k.heldCountSql, _paramsFor(k.heldCountSql, orgId));
            counts[k.kind] = _num(row?.c);
        } catch (e) {
            counts[k.kind] = null;
            errors[k.kind] = e?.code || 'error';
        }
    }
    return { counts, errors };
}

function _num(v) {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

/**
 * The Data Act export matrix for one organisation.
 * @param {string} orgId
 * @param {{db?:object, probe?:(entry:ExportKind, route:object)=>boolean}} [opts] test seams
 * @returns {Promise<Array<{kind:string,label_key:string,held:number|null,held_scope:string,route:object|null,extra_routes:object[],render_only:object|null,formats:string[],scope:string,mounted:boolean,gap_key:string|null}>>}
 */
async function coverageMatrix(orgId, { db, probe } = {}) {
    const { counts } = await heldCounts(orgId, { db });
    const mounted = probe || resolveMounted;
    return EXPORT_KINDS.map(k => ({
        kind: k.kind,
        label_key: k.labelKey,
        held: counts[k.kind] ?? null,
        held_scope: k.heldScope,
        route: k.route ? { ...k.route } : null,
        extra_routes: (k.extraRoutes || []).map(r => ({ ...r })),
        render_only: k.renderOnly ? { ...k.renderOnly } : null,
        formats: [...k.formats],
        scope: k.scope,
        mounted: k.route ? !!mounted(k, k.route) : false,
        gap_key: k.gapKey || null,
    }));
}

module.exports = {
    EXPORT_KINDS,
    MACHINE_READABLE_FORMATS,
    KNOWN_FORMATS,
    getKind,
    portableKinds,
    declaredRoutes,
    resolveMounted,
    clearCache,
    heldCounts,
    coverageMatrix,
};
