// @typecheck
'use strict';

/**
 * The processing record of collaborative projects (GDPR Art. 30) — what an
 * admin records for a project that signals show holds personal data.
 *
 *   GET    /ropa/projects             → { projects: [{ project_id, name, kinds, special, sources,
 *                                            registration|null }], complete }
 *   PUT    /ropa/projects/:projectId  { purpose?, lawful_basis, retention_days? } → { registration }
 *   DELETE /ropa/projects/:projectId  → { removed }
 *
 * Admin-only (admin_compliance). The list is the org's projects with a
 * personal-data signal plus every project that already has a record, so a
 * record never disappears from view because a signal did. A project of
 * another organisation is 404 — never "exists but not yours".
 *
 * Every write is a link in the evidence chain with ids and the basis only
 * (the purpose is free text and stays in the register), and re-judges the
 * project with GDPR-Art30-project-personal-data off the request path.
 *
 * Mounted inside routes/compliance/ropa.js. Dependencies are injectable.
 */

const express = require('express');
const { z, bodyOf, choice } = require('../../core/http/schemaParts');
const { validate } = require('../../core/http/validate');
const { HttpError } = require('../../core/http/errors');
const pd = require('../../compliance/projects/projectData');
const { hasSpecialKinds } = require('../../compliance/projects/personalDataSignals');

const LAWFUL_BASES = Object.freeze(['consent', 'contract', 'legal_obligation', 'vital_interests', 'public_task', 'legitimate_interests']);
const LIST_LIMIT = 500;

const RegistrationBody = bodyOf({
    purpose: z.string({ invalid_type_error: 'purpose must be text.' }).trim()
        .max(1000, 'purpose is at most 1000 characters.').nullable().optional(),
    lawful_basis: choice(LAWFUL_BASES, `lawful_basis must be one of ${LAWFUL_BASES.join(', ')}.`),
    retention_days: z.number({ invalid_type_error: 'retention_days must be a whole number of days.' })
        .int('retention_days must be a whole number of days.')
        .min(30, 'retention_days is at least 30.').max(3650, 'retention_days is at most 3650.')
        .nullable().optional(),
}, 'A project processing record');

const ProjectParams = z.object({
    projectId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'projectId must be a project id.'),
}).strict();

function _defaults() {
    const perms = require('../../auth/permissions');
    return {
        requireAuth: perms.requireAuth,
        requirePermission: perms.requirePermission,
        query: pd.defaultQuery(),
        complianceStore: () => require('../../stores/complianceStore'),
        signals: () => require('../../compliance/projects/personalDataSignals').sharedReader(),
        resolveOrgId: (req) => require('./shared').resolveOrgId(req),
        rerun: (orgId, projectId) => require('../../compliance/runner')
            .runOne(orgId, 'GDPR-Art30-project-personal-data', { runType: 'event', subjectId: `project:${projectId}` })
            .catch(() => { /* a framework switched off, or the project lost its signal: nothing to re-judge */ }),
    };
}

function makeProjectRegistrationRouter(overrides = {}) {
    const d = { ..._defaults(), ...overrides };
    const store = () => (typeof d.complianceStore === 'function' ? d.complianceStore() : d.complianceStore);
    const reader = () => (typeof d.signals === 'function' ? d.signals() : d.signals);
    const router = express.Router();
    const gate = [d.requireAuth, d.requirePermission('admin_compliance')];

    async function projectInOrg(orgId, projectId) {
        const rows = await d.query(`
            SELECT p.id FROM projects p
            WHERE p.id = $2 AND ${pd.orgMatch('p.organization_id')} AND ${pd.isWorkspace('p')}
        `, [orgId, projectId]);
        return !!rows?.[0];
    }

    router.get('/ropa/projects', ...gate, async (req, res) => {
        const orgId = await d.resolveOrgId(req);
        const [signals, registrations] = await Promise.all([
            reader().signalsFor(orgId),
            store().listSubjectRegistrations(orgId, 'project'),
        ]);
        const regById = new Map((registrations || []).map(r => [String(r.subject_id), r]));
        const all = [...new Set([...signals.byProject.keys(), ...regById.keys()])];
        const ids = all.slice(0, LIST_LIMIT);
        const nameRows = ids.length ? await d.query(`
            SELECT p.id, p.name FROM projects p
            WHERE ${pd.orgMatch('p.organization_id')} AND p.id = ANY($2::text[])
        `, [orgId, ids]) : [];
        const names = new Map((nameRows || []).map(r => [String(r.id), r.name]));
        const projects = ids.filter(id => names.has(id)).map((id) => {
            const sig = signals.byProject.get(id);
            return {
                project_id: id,
                name: names.get(id),
                kinds: sig?.kinds || [],
                special: hasSpecialKinds(sig?.kinds),
                sources: sig?.sources || [],
                registration: regById.get(id) || null,
            };
        }).sort((a, b) => (Number(b.special) - Number(a.special))
            || (Number(!!a.registration) - Number(!!b.registration))
            || String(a.name).localeCompare(String(b.name)));
        // Complete only when every signal source was read IN FULL and nothing
        // was cut here: a source past its limit, or a list past LIST_LIMIT,
        // leaves projects out, and the page must say so.
        const complete = signals.unreadable.length === 0 && !(signals.truncated || []).length && all.length <= LIST_LIMIT;
        res.json({ projects, complete });
    });

    router.put('/ropa/projects/:projectId', ...gate, validate({ params: ProjectParams, body: RegistrationBody }), async (req, res) => {
        const orgId = await d.resolveOrgId(req);
        const { projectId } = req.params;
        if (!(await projectInOrg(orgId, projectId))) throw new HttpError(404, 'not_found', 'There is no such project in your organisation.');
        const actorId = req.session?.user?.id || null;
        const body = req.body || {};
        const registration = await store().upsertSubjectRegistration(orgId, {
            subjectKind: 'project',
            subjectId: projectId,
            purpose: body.purpose || null,
            lawfulBasis: body.lawful_basis,
            retentionDays: body.retention_days ?? null,
            confirmedBy: actorId,
        });
        await store().addEvidence({
            organization_id: orgId,
            check_id: 'GDPR-Art30-project-personal-data',
            subject_type: 'processing-record',
            subject_id: `project:${projectId}`,
            payload: {
                action: 'project_processing_recorded', project_id: projectId,
                lawful_basis: body.lawful_basis, retention_days: body.retention_days ?? null,
                has_purpose: !!body.purpose, actor: actorId, at: new Date().toISOString(),
            },
        });
        d.rerun(orgId, projectId);
        res.json({ registration });
    });

    router.delete('/ropa/projects/:projectId', ...gate, validate({ params: ProjectParams }), async (req, res) => {
        const orgId = await d.resolveOrgId(req);
        const { projectId } = req.params;
        const removed = await store().deleteSubjectRegistration(orgId, 'project', projectId);
        if (!removed) throw new HttpError(404, 'not_found', 'This project has no processing record.');
        await store().addEvidence({
            organization_id: orgId,
            check_id: 'GDPR-Art30-project-personal-data',
            subject_type: 'processing-record',
            subject_id: `project:${projectId}`,
            payload: { action: 'project_processing_removed', project_id: projectId, actor: req.session?.user?.id || null, at: new Date().toISOString() },
        });
        d.rerun(orgId, projectId);
        res.json({ removed: true });
    });

    return router;
}

module.exports = { makeProjectRegistrationRouter, LAWFUL_BASES };
