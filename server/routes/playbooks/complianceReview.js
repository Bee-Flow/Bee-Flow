/**
 * THE COMPLIANCE PHASE'S REVIEW — the biggest of the server-run phases, and
 * the only one that reads everything the playbook built: the table and its
 * columns, a sample of its ROWS, every automation's definition, the app and
 * who it was just shared with, and the frameworks this organisation switched
 * on in the Compliance Center.
 *
 * It writes nothing but the phase's own artifacts. What a person then DOES
 * with the review — resolve, preview a retention period, register it — lives
 * in complianceRoutes.js.
 *
 * No request schema here: this file declares no route. `recheck` is read from
 * the body of POST /:id/phases/:key/run, which serverPhaseRoutes.js checks
 * against RunBody before it calls into this file.
 */

'use strict';

const lifecycle = require('../../playbooks/lifecycle');
const { sendErr } = require('./contract');
const { kindOf, firstOfKind, appBefore, localeOf } = require('./phaseList');
const log = require('../../telemetry/log');

/** Rows the compliance review samples to judge personal data by its VALUES. */
const SAMPLE_ROWS = 50;

function makeRunComplianceReview(ctx) {
    const { d, flow } = ctx;
    const { savePhaseOutcome, phaseTier } = flow;

    /**
     * The COMPLIANCE phase: read what the playbook built — the table and its
     * columns, every automation's steps, the app and who it was just shared
     * with — and review it against the frameworks THIS organisation has
     * switched on in the Compliance Center. It writes nothing anywhere but the
     * phase's own artifacts.
     */
    const runComplianceReview = async (req, res, pb, key) => {
        const cur = lifecycle.phaseByKey(pb.phases, key);
        // A RECHECK re-reads everything while the phase stays where it is:
        // `awaiting → running` is illegal and the lifecycle table is pinned, so
        // a review that could never be re-run was a review that could never be
        // shown to have worked. Same body, no transition (owner, 2026-09-16).
        const recheck = !!(req.body && req.body.recheck) && !!cur && cur.status === 'awaiting';
        if (!cur || (cur.status !== 'ready' && !recheck)) return sendErr(res, 409, 'phase_not_ready', `The compliance phase is ${cur ? cur.status : 'missing'}.`, { from: cur ? cur.status : null, to: 'running' });
        // The reviewer's tier, measured against the owner's list before the
        // phase moves or anything is read.
        const tier = await phaseTier(req, res, pb);
        if (!tier) return;
        const nowIso = new Date(d.now()).toISOString();
        let phases = recheck
            ? pb.phases
            : lifecycle.applyTransition(pb.phases, key, 'running', { error: null }, nowIso);
        let version = pb.version;
        if (!recheck) {
            const running = await d.playbookStore.savePhases(pb.id, pb.userId, { phases, currentPhase: key }, { expectedVersion: pb.version });
            if (!running.ok) return running.conflict ? sendErr(res, 409, 'version_conflict', 'This playbook changed elsewhere.', { currentVersion: running.currentVersion, playbook: running.playbook }) : sendErr(res, 404, 'not_found', 'Not found');
            version = running.version;
        }

        // ── what was built ──────────────────────────────────────────────
        const tableArt = (firstOfKind(phases, 'table') || {}).artifacts || {};
        let table = null;
        if (tableArt.datatableId) {
            table = { id: tableArt.datatableId, scope: tableArt.datatableScope || null, name: tableArt.datatableName, fields: tableArt.fields || [], rowCount: tableArt.rowCount, isMirror: !!tableArt.isMirror };
            try {
                const row = await d.datatableStore.getDatatable(tableArt.datatableId, tableArt.datatableScope);
                if (row && Number.isFinite(Number(row.rowCount))) table.rowCount = Number(row.rowCount);
            } catch { /* the columns are the material that matters */ }
        }
        const automations = [];
        for (const p of phases) {
            const id = p && p.artifacts && p.artifacts.automationId;
            if (!id || kindOf(p) !== 'automation') continue;
            try {
                const a = await d.automationStore.getAutomation(id);
                if (a && a.userId === pb.userId) {
                    automations.push({
                        // The id is what a finding points at and what a fix is
                        // written to — without it the review can describe an
                        // automation but never take you to it.
                        id,
                        phaseKey: p.key,
                        title: a.title,
                        description: a.description || null,
                        trigger: (a.definition && a.definition.trigger && a.definition.trigger.kind) || null,
                        // type AND tool. The projection used to drop `tool`,
                        // which quietly disarmed two of the review's own
                        // checks: an integration_action is only outbound
                        // depending on WHICH tool it runs (gmail_search reads,
                        // gmail_compose sends), and "does this automation read
                        // files" was matching tool-shaped patterns against step
                        // types, so it could never be true. Tool NAMES are not
                        // personal data — no argument values travel, only the
                        // two identifiers the classifier needs.
                        steps: (a.definition && Array.isArray(a.definition.steps))
                            ? a.definition.steps.map((st) => ({ type: st && st.type, tool: (st && st.tool) || null }))
                            : [],
                        // The whole definition, for compliance/aiAct/signals.js —
                        // it reads the graph, not a list of step types.
                        definition: a.definition || null,
                    });
                }
            } catch { /* an automation that cannot be read is simply not reviewed */ }
        }
        let app = null;
        let access = null;
        const appId = appBefore(phases, key) || ((firstOfKind(phases, 'access') || {}).artifacts || {}).appId || null;
        if (appId) {
            try {
                const row = await d.studioAppStore.getStudioApp(appId);
                if (row && row.userId === pb.userId) {
                    app = {
                        id: appId,
                        name: row.name,
                        published: !!row.isPublished,
                        sharedGroups: Array.isArray(row.sharedGroups) ? row.sharedGroups : [],
                        screenCount: (row.definition && Array.isArray(row.definition.screens)) ? row.definition.screens.length : null,
                        publicPages: Array.isArray(row.publicPages) ? row.publicPages.length : 0,
                    };
                    const meta = await d.studioAppDataStore.getDataModel(appId, row.userId).catch(() => null);
                    const members = await d.studioAppDataStore.listMembers(appId, row.userId).catch(() => []);
                    access = {
                        roles: (meta && meta.model && Array.isArray(meta.model.roles)) ? meta.model.roles : [],
                        defaultRole: (meta && meta.model && meta.model.roleMapping && meta.model.roleMapping.default) || null,
                        memberCount: Array.isArray(members) ? members.length : 0,
                    };
                    // Roles that carry a row rule: with one of those, "everyone
                    // can open it" no longer means "everyone sees everything".
                    const modelTables = (meta && meta.model && Array.isArray(meta.model.tables)) ? meta.model.tables : [];
                    app.scopedRoles = [...new Set(modelTables.flatMap((mt) => Object.keys((mt && mt.access && mt.access.rowFilters) || {})))];
                }
            } catch { /* reviewed without it */ }
        }

        // ── which rules this organisation actually follows ──────────────
        let active = [];
        try {
            const set = await d.frameworkPolicy.activeRegulations(pb.organizationId || 'default', { req });
            active = [...set];
        } catch (e) {
            log.warn('[Playbooks] could not read the active frameworks:', e.message);
        }
        // Frameworks carry `name_key`, never `name` — reading `fw.name` meant
        // the reviewer has only ever seen bare codes.
        const names = active.map((code) => {
            const fw = d.complianceFrameworks.byRegulation ? d.complianceFrameworks.byRegulation(code) : null;
            const human = fw && fw.name_key ? (d.guiDefaults || {})[fw.name_key] : null;
            return human && human !== code ? `${code} (${human})` : code;
        });

        // ── what is ACTUALLY true (playbooks/phases/complianceFacts.js) ──
        let rows = [];
        let privacy = null;
        if (tableArt.datatableId) {
            try {
                const row = await d.datatableStore.getDatatable(tableArt.datatableId, tableArt.datatableScope);
                if (row) privacy = { lawfulBasis: row.lawfulBasis, retentionDays: row.retentionDays, retentionField: row.retentionField, subjectColumn: row.subjectColumn, rowScope: row.rowScope };
                const principal = await d.datatableAccessPlan.resolveDatatablePrincipalForUser(pb.userId);
                const resolved = await d.datatableRuntime.resolveForPrincipal(tableArt.datatableId, principal, { needed: 'viewer' });
                const page = await d.datatableRuntime.readRows(resolved, {
                    allowColumns: (tableArt.fields || []).map((f) => f.key).filter(Boolean),
                    limit: SAMPLE_ROWS,
                });
                rows = Array.isArray(page && page.rows) ? page.rows : [];
            } catch { /* the review still runs on what it has */ }
        }
        let enrichment = null;
        try {
            enrichment = await d.enrichComplianceFacts({
                table, rows, automations, privacy, orgId: pb.organizationId || 'default',
            });
        } catch (e) {
            log.warn('[Playbooks] compliance facts unavailable:', e.message);
        }
        const facts = d.gatherFacts({ table, automations, app, access, frameworks: active, enrichment });
        const result = await d.runCompliancePhase({
            tier,
            facts,
            locale: localeOf(pb) || 'en',
            frameworkNames: names,
            userId: pb.userId,
            userOrgId: pb.organizationId,
        });
        const doneIso = new Date(d.now()).toISOString();
        phases = recheck
            ? phases.map((p) => (p.key === key
                ? {
                    ...p,
                    summary: result.summary,
                    error: null,
                    finishedAt: doneIso,
                    artifacts: {
                        ...(p.artifacts || {}),
                        ...result.artifacts,
                        // What it looked like before, so the card can say
                        // "two fewer than a moment ago" — the point of a fix.
                        rechecks: [
                            ...(((p.artifacts && p.artifacts.rechecks) || [])),
                            { at: doneIso, was: ((p.artifacts && p.artifacts.findings) || []).length, now: result.artifacts.findings.length },
                        ].slice(-5),
                    },
                }
                : p))
            : lifecycle.applyTransition(phases, key, 'awaiting', { artifacts: result.artifacts, summary: result.summary, error: null }, doneIso);
        const saved = await savePhaseOutcome(pb, key, phases, version);
        if (!saved.ok) return sendErr(res, 409, 'version_conflict', 'This playbook changed elsewhere.', { currentVersion: saved.currentVersion, playbook: saved.playbook });
        res.json({ playbook: saved.playbook });
    };

    return runComplianceReview;
}

module.exports = { makeRunComplianceReview };
