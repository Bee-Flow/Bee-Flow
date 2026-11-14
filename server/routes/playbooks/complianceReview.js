// @typecheck
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
const { firstOfKind, appBefore, localeOf } = require('../../usecases/playbooks/phaseList');
const log = require('../../telemetry/log');
const { readTable, readAutomations, readApp, readFrameworks, sampleTable, recheckedPhases } = require('./complianceReviewFacts');

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

        // What was built, which rules this organisation follows, and what is
        // actually in the table (./complianceReviewFacts.js).
        const tableArt = (firstOfKind(phases, 'table') || {}).artifacts || {};
        const table = await readTable(d, tableArt);
        const automations = await readAutomations(d, phases, pb);
        const appId = appBefore(phases, key) || ((firstOfKind(phases, 'access') || {}).artifacts || {}).appId || null;
        const { app, access } = await readApp(d, appId, pb);
        const { active, names } = await readFrameworks(d, pb, req);
        const { rows, privacy } = await sampleTable(d, tableArt, pb);
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
            ? recheckedPhases(phases, key, result, doneIso)
            : lifecycle.applyTransition(phases, key, 'awaiting', { artifacts: result.artifacts, summary: result.summary, error: null }, doneIso);
        const saved = await savePhaseOutcome(pb, key, phases, version);
        if (!saved.ok) return sendErr(res, 409, 'version_conflict', 'This playbook changed elsewhere.', { currentVersion: saved.currentVersion, playbook: saved.playbook });
        res.json({ playbook: saved.playbook });
    };

    return runComplianceReview;
}

module.exports = { makeRunComplianceReview };
