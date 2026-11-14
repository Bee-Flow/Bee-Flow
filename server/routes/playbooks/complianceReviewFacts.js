// @typecheck strict
/**
 * What the compliance phase's review reads (./complianceReview.js runs these
 * in order): the table the playbook built, its automations, the app and who
 * may open it, the frameworks this organisation follows, a sample of the
 * table's rows, and the phase list of a recheck. Nothing here writes.
 *
 * `d` holds the collaborators of the playbook routes (stores, policy, the
 * datatable runtime), handed in by the route.
 */

'use strict';

const { kindOf } = require('../../usecases/playbooks/phaseList');
const log = require('../../telemetry/log');
const { isMissingTable } = require('../../utils/isMissingTable');
const { fallback } = require('../../utils/bestEffort');

/** Rows the compliance review samples to judge personal data by its VALUES. */
const SAMPLE_ROWS = 50;

/**
 * @typedef {{ [field: string]: any }} Row  a stored row, as its store hands it over
 * @typedef {{ key: string, kind?: string, status?: string, artifacts?: Row, [field: string]: unknown }} Phase
 * @typedef {{ id: string, userId: string, organizationId?: string, [field: string]: unknown }} Playbook
 * @typedef {{ datatableId?: string, datatableScope?: string, datatableName?: string, fields?: Array<{ key?: string }>, rowCount?: number, isMirror?: unknown }} TableArtifacts
 * @typedef {{
 *   datatableStore: { getDatatable: (id: string, scope?: string) => Promise<Row | null> },
 *   automationStore: { getAutomation: (id: string) => Promise<Row | null> },
 *   studioAppStore: { getStudioApp: (id: string) => Promise<Row | null>, listPublicPages: (id: string) => Promise<unknown> },
 *   studioAppDataStore: { getDataModel: (appId: string, userId: string) => Promise<Row | null>, listMembers: (appId: string, userId: string) => Promise<unknown> },
 *   frameworkPolicy: { activeRegulations: (orgId: string, opts: { req: unknown }) => Promise<Iterable<string>> },
 *   complianceFrameworks: { byRegulation?: (code: string) => { name_key?: string } | null },
 *   guiDefaults?: Record<string, string>,
 *   datatableAccessPlan: { resolveDatatablePrincipalForUser: (userId: string) => Promise<unknown> },
 *   datatableRuntime: { resolveForPrincipal: (id: string, principal: unknown, opts: { needed: string }) => Promise<unknown>,
 *     readRows: (resolved: unknown, opts: { allowColumns: string[], limit: number }) => Promise<{ rows?: unknown } | null> },
 * }} ReviewReads
 */

/**
 * The table the playbook built, with its live row count; null when it built
 * none. A table that was dropped is reviewed on its columns (they are the
 * material that matters); any other failure to read it ends the review.
 * @param {ReviewReads} d
 * @param {TableArtifacts} tableArt
 */
async function readTable(d, tableArt) {
    if (!tableArt.datatableId) return null;
    const table = { id: tableArt.datatableId, scope: tableArt.datatableScope || null, name: tableArt.datatableName, fields: tableArt.fields || [], rowCount: tableArt.rowCount, isMirror: !!tableArt.isMirror };
    try {
        const row = await d.datatableStore.getDatatable(tableArt.datatableId, tableArt.datatableScope);
        if (row && Number.isFinite(Number(row.rowCount))) table.rowCount = Number(row.rowCount);
    } catch (err) { if (!isMissingTable(err)) throw err; log.debug('the columns are the material that matters', err); }
    return table;
}

/**
 * One automation as the review reads it. The id is what a finding points at
 * and what a fix is written to. Each step keeps its type AND its tool: an
 * integration_action is only outbound depending on WHICH tool it runs
 * (gmail_search reads, gmail_compose sends). Tool NAMES are not personal
 * data: no argument values travel. The whole definition goes along for
 * compliance/aiAct/signals.js, which reads the graph.
 * @param {string} id
 * @param {Phase} phase
 * @param {Row} a
 */
function reviewedAutomation(id, phase, a) {
    const definition = a.definition || null;
    return {
        id,
        phaseKey: phase.key,
        title: a.title,
        description: a.description || null,
        trigger: (definition && definition.trigger && definition.trigger.kind) || null,
        steps: (definition && Array.isArray(definition.steps))
            ? definition.steps.map((/** @type {Row | null} */ st) => ({ type: st && st.type, tool: (st && st.tool) || null }))
            : [],
        definition,
    };
}

/**
 * The owner's automations of the playbook's automation phases. One that
 * cannot be read is simply not reviewed.
 * @param {ReviewReads} d
 * @param {Phase[]} phases
 * @param {Playbook} pb
 */
async function readAutomations(d, phases, pb) {
    const automations = [];
    for (const p of phases) {
        const id = p && p.artifacts && p.artifacts.automationId;
        if (!id || kindOf(p) !== 'automation') continue;
        try {
            const a = await d.automationStore.getAutomation(id);
            if (a && a.userId === pb.userId) automations.push(reviewedAutomation(id, p, a));
        } catch (err) { fallback('routes/playbooks/complianceReview:runComplianceReview', err); /* an automation that cannot be read is simply not reviewed */ }
    }
    return automations;
}

/**
 * Who may open the app, from its data model and its members. Roles that
 * carry a row rule are named: with one of those, "everyone can open it" no
 * longer means "everyone sees everything".
 * @param {ReviewReads} d
 * @param {string} appId
 * @param {Row} row  the app's own row
 */
async function readAccess(d, appId, row) {
    const meta = await d.studioAppDataStore.getDataModel(appId, row.userId).catch((e) => fallback('routes/playbooks/complianceReview:runComplianceReview#2', e, null));
    const members = await d.studioAppDataStore.listMembers(appId, row.userId).catch((e) => fallback('routes/playbooks/complianceReview:runComplianceReview#3', e, []));
    const model = (meta && meta.model) || null;
    const access = {
        roles: (model && Array.isArray(model.roles)) ? model.roles : [],
        defaultRole: (model && model.roleMapping && model.roleMapping.default) || null,
        memberCount: Array.isArray(members) ? members.length : 0,
    };
    const modelTables = (model && Array.isArray(model.tables)) ? model.tables : [];
    const scopedRoles = [...new Set(modelTables.flatMap((/** @type {Row | null} */ mt) => Object.keys((mt && mt.access && mt.access.rowFilters) || {})))];
    return { access, scopedRoles };
}

/**
 * The owner's app and who it is shared with; both null when there is no
 * app, it is someone else's, or it cannot be read (the review runs without
 * it). Public links live in studio_app_public_pages, not on the app row.
 * @param {ReviewReads} d
 * @param {string | null} appId
 * @param {Playbook} pb
 */
async function readApp(d, appId, pb) {
    /** @type {Row | null} */
    let app = null;
    let access = null;
    if (!appId) return { app, access };
    try {
        const row = await d.studioAppStore.getStudioApp(appId);
        if (row && row.userId === pb.userId) {
            app = {
                id: appId,
                name: row.name,
                published: !!row.isPublished,
                sharedGroups: Array.isArray(row.sharedGroups) ? row.sharedGroups : [],
                screenCount: (row.definition && Array.isArray(row.definition.screens)) ? row.definition.screens.length : null,
                publicPages: await d.studioAppStore.listPublicPages(appId)
                    .then((list) => (Array.isArray(list) ? list.length : 0))
                    .catch(() => 0),
            };
            const opened = await readAccess(d, appId, row);
            access = opened.access;
            app.scopedRoles = opened.scopedRoles;
        }
    } catch (err) { fallback('routes/playbooks/complianceReview:runComplianceReview#4', err); /* reviewed without it */ }
    return { app, access };
}

/**
 * The frameworks this organisation switched on, and how each is named to
 * the reviewer: "CODE (name)" where the framework has a name of its own
 * (frameworks carry `name_key`, never `name`). None when they cannot be read.
 * @param {ReviewReads} d
 * @param {Playbook} pb
 * @param {unknown} req
 */
async function readFrameworks(d, pb, req) {
    /** @type {string[]} */
    let active = [];
    try {
        const set = await d.frameworkPolicy.activeRegulations(pb.organizationId || 'default', { req });
        active = [...set];
    } catch (e) {
        log.warn('[Playbooks] could not read the active frameworks:', /** @type {Error} */ (e).message);
    }
    const names = active.map((code) => {
        const fw = d.complianceFrameworks.byRegulation ? d.complianceFrameworks.byRegulation(code) : null;
        const human = fw && fw.name_key ? (d.guiDefaults || {})[fw.name_key] : null;
        return human && human !== code ? `${code} (${human})` : code;
    });
    return { active, names };
}

/**
 * What is ACTUALLY in the table (playbooks/phases/complianceFacts.js judges
 * personal data by its values): its privacy settings and a sample of its
 * rows, read as the owner. The review still runs on what it has when any of
 * it cannot be read.
 * @param {ReviewReads} d
 * @param {TableArtifacts} tableArt
 * @param {Playbook} pb
 */
async function sampleTable(d, tableArt, pb) {
    /** @type {unknown[]} */
    let rows = [];
    let privacy = null;
    if (!tableArt.datatableId) return { rows, privacy };
    try {
        const row = await d.datatableStore.getDatatable(tableArt.datatableId, tableArt.datatableScope);
        if (row) privacy = { lawfulBasis: row.lawfulBasis, retentionDays: row.retentionDays, retentionField: row.retentionField, subjectColumn: row.subjectColumn, rowScope: row.rowScope };
        const principal = await d.datatableAccessPlan.resolveDatatablePrincipalForUser(pb.userId);
        const resolved = await d.datatableRuntime.resolveForPrincipal(tableArt.datatableId, principal, { needed: 'viewer' });
        const page = await d.datatableRuntime.readRows(resolved, {
            allowColumns: (tableArt.fields || []).map((f) => f.key).filter(/** @returns {k is string} */ (k) => !!k),
            limit: SAMPLE_ROWS,
        });
        rows = Array.isArray(page && page.rows) ? /** @type {unknown[]} */ (/** @type {{ rows: unknown }} */ (page).rows) : [];
    } catch (err) { fallback('routes/playbooks/complianceReview:runComplianceReview#5', err); /* the review still runs on what it has */ }
    return { rows, privacy };
}

/**
 * The phase list after a recheck: the phase stays where it is and takes the
 * new review. Its `rechecks` (the last five) keep what it looked like
 * before, so the card can say "two fewer than a moment ago".
 * @param {Phase[]} phases
 * @param {string} key
 * @param {{ summary: unknown, artifacts: { findings: unknown[], [field: string]: unknown } }} result
 * @param {string} doneIso
 */
function recheckedPhases(phases, key, result, doneIso) {
    return phases.map((p) => (p.key === key
        ? {
            ...p,
            summary: result.summary,
            error: null,
            finishedAt: doneIso,
            artifacts: {
                ...(p.artifacts || {}),
                ...result.artifacts,
                rechecks: [
                    ...(((p.artifacts && p.artifacts.rechecks) || [])),
                    { at: doneIso, was: ((p.artifacts && p.artifacts.findings) || []).length, now: result.artifacts.findings.length },
                ].slice(-5),
            },
        }
        : p));
}

module.exports = { readTable, readAutomations, readApp, readFrameworks, sampleTable, recheckedPhases };
