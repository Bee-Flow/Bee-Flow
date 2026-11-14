// @typecheck strict
/**
 * Tenant-isolation fixtures: the compliance records of an organisation that
 * the Compliance hub takes by id (incidents, the ISO process rows, custom
 * frameworks and their checks). What a fixture is and how the matrix drives
 * it is in testUtils/tenantFixtures.js, which puts these in its list.
 *
 * Every route here sits behind `admin_compliance`: a plain member of org A
 * gets that gate's 403, so each kind also runs as the organisation admin of
 * org A (`orgAdminCaller`), who holds admin_compliance in A and must still get
 * the 404 of a record of another organisation. The owner of the fixture is
 * made org B's admin so the first route answers 200 for them.
 */

'use strict';

const { makeOwnerOrgAdmin } = require('./organisation');

/** @param {string} p */
const store = (p) => require(`../../stores/${p}`);

/**
 * An agent of org B, the subject of a DPIA and an AI Act assessment; the owner
 * is made org B's admin.
 * @param {{ orgId: string, userId: string, index: number }} ctx
 */
async function createAgentSubject({ orgId, userId, index }) {
    await makeOwnerOrgAdmin(userId);
    const organizationId = /** @type {null} */ (/** @type {unknown} */ (orgId));
    const agent = await store('agentStore').createAgent(`Assessed agent ${index}`, 'matrix fixture', 'You are a test.', userId, null, [], true, true, false, {}, organizationId);
    return String(agent.id);
}

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        // The DPIA of an agent of org B (routes/compliance/dpia.js): an assessment is read and recorded only
        // for an agent of the caller's organisation, and the PDF prints a DPIA of the caller's organisation.
        kind: 'dpiaAgent',
        mount: '/api/compliance',
        router: () => require('../../routes/compliance/dpia'),
        create: createAgentSubject,
        routes: ['GET /api/compliance/dpia/:agentId', 'POST /api/compliance/dpia/:agentId', 'GET /api/compliance/dpia/:agentId/pdf'],
        bodies: { 'POST /api/compliance/dpia/:agentId': { mode: 'attestation', risk_level: 'low' } },
        orgAdminCaller: true,
    },
    {
        // The AI Act assessment of an agent of org B (routes/compliance/aiAct.js): the target is loaded in the
        // caller's organisation (compliance/aiAct/signals.js loadAgent) before anything is read or recorded.
        kind: 'aiActAgent',
        mount: '/api/compliance',
        router: () => require('../../routes/compliance/aiAct'),
        create: createAgentSubject,
        params: { kind: 'agent' },
        routes: [
            'GET /api/compliance/ai-act/assessments/:kind/:id', 'GET /api/compliance/ai-act/assessments/:kind/:id/signals',
            'PUT /api/compliance/ai-act/assessments/:kind/:id',
        ],
        bodies: { 'PUT /api/compliance/ai-act/assessments/:kind/:id': { answers: {} } },
        orgAdminCaller: true,
    },
    {
        // The processing record (ROPA) of a collaborative project of org B (routes/compliance/projectRegistrations.js):
        // recorded only for a project of the caller's organisation, removed only from the caller's own records.
        kind: 'ropaProject',
        mount: '/api/compliance',
        router: () => require('../../routes/compliance/projectRegistrations').makeProjectRegistrationRouter(),
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const project = await store('projectStore').createProject({
                name: `ROPA project ${index}`, description: 'matrix fixture', customInstructions: '', color: '', icon: '',
                ownerId: userId, organizationId: orgId, knowledgeBaseIds: [], extractMemories: false,
            });
            return String(project.id);
        },
        routes: ['PUT /api/compliance/ropa/projects/:projectId', 'DELETE /api/compliance/ropa/projects/:projectId'],
        bodies: { 'PUT /api/compliance/ropa/projects/:projectId': { lawful_basis: 'contract' } },
        orgAdminCaller: true,
    },
    {
        // A security incident (breach register) of org B (routes/compliance/incidents.js).
        kind: 'complianceIncident',
        mount: '/api/compliance',
        router: () => require('../../routes/compliance/incidents'),
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const incident = await store('incidentStore').createIncident({ organization_id: orgId, title: `Incident ${index}`, created_by: userId });
            return String(incident.id);
        },
        routes: [
            'PATCH /api/compliance/incidents/:id', 'POST /api/compliance/incidents/:id/cra-report',
            'POST /api/compliance/incidents/:id/customer-notified', 'POST /api/compliance/incidents/:id/notify-recipients',
        ],
        bodies: { 'POST /api/compliance/incidents/:id/cra-report': { stage: 'early_warning' } },
        orgAdminCaller: true,
    },
    {
        // An ISO 27001 risk of org B and its treatments (routes/compliance/isoProcess.js).
        kind: 'isoRisk',
        mount: '/api/compliance',
        router: () => require('../../routes/compliance/isoProcess'),
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const risk = await store('riskStore').createRisk(orgId, { title: `Risk ${index}` }, userId);
            return String(risk.id);
        },
        routes: ['PUT /api/compliance/iso/risks/:id', 'POST /api/compliance/iso/risks/:id/treatments'],
        bodies: { 'POST /api/compliance/iso/risks/:id/treatments': { option: 'mitigate', description: 'Treatment that must not land here.' } },
        orgAdminCaller: true,
    },
    {
        // An internal audit of org B and its findings.
        kind: 'isoAudit',
        mount: '/api/compliance',
        router: () => require('../../routes/compliance/isoProcess'),
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const audit = await store('isoAuditStore').createAudit(orgId, { title: `Audit ${index}` }, userId);
            return String(audit.id);
        },
        routes: ['PUT /api/compliance/iso/audits/:id', 'POST /api/compliance/iso/audits/:id/findings'],
        bodies: { 'POST /api/compliance/iso/audits/:id/findings': { description: 'A finding that must not land here.' } },
        orgAdminCaller: true,
    },
    {
        kind: 'isoNonconformity',
        mount: '/api/compliance',
        router: () => require('../../routes/compliance/isoProcess'),
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const nc = await store('isoAuditStore').createNonconformity(orgId, { title: `Nonconformity ${index}` }, userId);
            return String(nc.id);
        },
        routes: ['PUT /api/compliance/iso/ncs/:id'],
        orgAdminCaller: true,
    },
    {
        kind: 'isoObjective',
        mount: '/api/compliance',
        router: () => require('../../routes/compliance/isoProcess'),
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const objective = await store('isoAuditStore').createObjective(orgId, { title: `Objective ${index}` }, userId);
            return String(objective.id);
        },
        routes: ['PUT /api/compliance/iso/objectives/:id'],
        orgAdminCaller: true,
    },
    {
        kind: 'isoObligation',
        mount: '/api/compliance',
        router: () => require('../../routes/compliance/isoProcess'),
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const obligation = await store('isoObligationStore').createObligation(orgId, { title: `Obligation ${index}`, due_at: new Date(Date.now() + 86_400_000).toISOString() }, userId);
            return String(obligation.id);
        },
        routes: ['PUT /api/compliance/iso/obligations/:id', 'POST /api/compliance/iso/obligations/:id/complete'],
        orgAdminCaller: true,
    },
    {
        // A custom framework of org B (routes/compliance/customFrameworks.js).
        kind: 'customFramework',
        mount: '/api/compliance',
        router: () => require('../../routes/compliance/customFrameworks'),
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const fw = await store('customFrameworkStore').createFramework(orgId, { code: `MX${index}`, name: `Framework ${index}`, createdBy: userId });
            return String(fw.id);
        },
        routes: [
            'GET /api/compliance/custom/frameworks/:id', 'PUT /api/compliance/custom/frameworks/:id',
            'GET /api/compliance/custom/frameworks/:id/export.json', 'POST /api/compliance/custom/frameworks/:id/checks',
            'DELETE /api/compliance/custom/frameworks/:id',
        ],
        bodies: { 'POST /api/compliance/custom/frameworks/:id/checks': { checks: [{ ref: 'MX-1', title: 'A check that must not land here' }] } },
        orgAdminCaller: true,
    },
    {
        // A check of a custom framework of org B and its attestations.
        kind: 'customCheck',
        mount: '/api/compliance',
        router: () => require('../../routes/compliance/customFrameworks'),
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const frameworks = store('customFrameworkStore');
            const fw = await frameworks.createFramework(orgId, { code: `MC${index}`, name: `Framework ${index}`, createdBy: userId });
            const [check] = await frameworks.upsertChecks(orgId, fw.id, [{ ref: 'MC-1', title: `Check ${index}` }]);
            return String(check.id);
        },
        routes: ['GET /api/compliance/custom/checks/:id/attestations', 'POST /api/compliance/custom/checks/:id/attest', 'DELETE /api/compliance/custom/checks/:id'],
        bodies: { 'POST /api/compliance/custom/checks/:id/attest': { outcome: 'compliant', statement: 'An attestation that must not land here.' } },
        orgAdminCaller: true,
    },
    {
        // A data-subject request of org B (routes/dsr.js, mounted at /api/dsr).
        kind: 'dsrRequest',
        mount: '/api/dsr',
        router: () => require('../../routes/dsr'),
        create: async ({ orgId, userId, index }) => {
            await makeOwnerOrgAdmin(userId);
            const row = await store('dsrStore').createManual(orgId, { subject_email: `subject-${index}@matrix.test`, request_type: 'access', created_by: userId });
            return String(row.id);
        },
        routes: [
            'GET /api/dsr/requests/:id', 'GET /api/dsr/requests/:id/timeline', 'GET /api/dsr/requests/:id/discovery',
            'GET /api/dsr/requests/:id/export', 'POST /api/dsr/requests/:id/start', 'POST /api/dsr/requests/:id/extend',
            'POST /api/dsr/requests/:id/verify-identity', 'POST /api/dsr/requests/:id/fulfil',
        ],
        bodies: {
            'POST /api/dsr/requests/:id/extend': { reason: 'A reason that must not land here.' },
            'POST /api/dsr/requests/:id/fulfil': { status: 'rejected', notify_subject: false },
        },
        orgAdminCaller: true,
    },
];

module.exports = { FIXTURES };
