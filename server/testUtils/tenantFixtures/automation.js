// @typecheck strict
/**
 * Tenant-isolation fixtures: an automation of org B and what hangs off it (its
 * runs, an approval, the builder's session, its hosted form), and what an
 * organisation keeps beside its automations (folders, templates). What a
 * fixture is and how the matrix drives it is in testUtils/tenantFixtures.js,
 * which puts these in its list.
 */

'use strict';

const { oneFile, present, asNullTyped } = require('./helpers');

const automationStore = () => require('../../stores/automationStore');

/**
 * An automation of org B, owned by user B.
 * @param {{ orgId: string, userId: string, index: number }} ctx
 */
async function createAutomation({ orgId, userId, index }) {
    return present(await automationStore().createAutomation({
        userId, organizationId: orgId, title: `Automation ${index}`,
        definition: { steps: [], edges: [] }, triggerType: 'manual',
    }), 'createAutomation');
}

/**
 * A run of a new automation of org B, started by user B.
 * @param {{ orgId: string, userId: string, index: number }} ctx
 */
async function createRun(ctx) {
    const a = await createAutomation(ctx);
    const run = present(await automationStore().createRun({ automationId: a.id, version: 1, userId: ctx.userId, triggerKind: 'manual' }), 'createRun');
    return { automation: a, run };
}

/** @type {import('../tenantFixtures').TenantFixture[]} */
const FIXTURES = [
    {
        kind: 'automation',
        mount: '/api/automation',
        router: () => require('../../routes/automation'),
        create: async (ctx) => (await createAutomation(ctx)).id,
        routes: [
            'GET /api/automation/:id', 'PUT /api/automation/:id', 'DELETE /api/automation/:id', 'GET /api/automation/:id/runs',
            // The builder's form test and the form's test link: `edit` is checked before the body is read.
            'POST /api/automation/:id/form-test', 'POST /api/automation/:id/form-test/upload',
            'GET /api/automation/forms/:automationId/test-link', 'POST /api/automation/forms/:automationId/test-link',
            'DELETE /api/automation/forms/:automationId/test-link', 'PUT /api/automation/forms/:automationId/test-link/audience',
            // "Describe the look" (a model call): `edit` is checked before the body is read.
            'POST /api/automation/:id/forms/style-assist',
            // The other routes under the automation's id. The owner gets past the gate on each (a 200, the 400 of
            // an empty body, or the 404 of a version, case or webhook that does not exist); a member of org A does not.
            'POST /api/automation/:id/activate', 'GET /api/automation/:id/agent-bindings', 'POST /api/automation/:id/agent-invoke',
            'GET /api/automation/:id/ai-act', 'PUT /api/automation/:id/ai-act', 'PUT /api/automation/:id/ai-act/answers',
            'GET /api/automation/:id/ai-act/check', 'GET /api/automation/:id/ai-act/suggestion', 'GET /api/automation/:id/caller-notice',
            'GET /api/automation/:id/counts', 'POST /api/automation/:id/deactivate', 'POST /api/automation/:id/diagnose-trigger',
            'POST /api/automation/:id/dry-run', 'POST /api/automation/:id/duplicate', 'GET /api/automation/:id/export',
            'POST /api/automation/:id/form', 'GET /api/automation/:id/form-scenarios',
            'DELETE /api/automation/:id/form-scenarios/:scenarioId', 'GET /api/automation/:id/form-scenarios/:scenarioId',
            'POST /api/automation/:id/form-scenarios/:scenarioId/dry-run', 'DELETE /api/automation/:id/form/:token',
            'POST /api/automation/:id/form/:token/rotate', 'GET /api/automation/:id/forms', 'GET /api/automation/:id/goldens',
            'POST /api/automation/:id/goldens/replay', 'GET /api/automation/:id/notifications', 'GET /api/automation/:id/principals',
            'POST /api/automation/:id/publish', 'GET /api/automation/:id/readiness', 'POST /api/automation/:id/run',
            'POST /api/automation/:id/runs/:runId/retry', 'POST /api/automation/:id/save-as-template', 'GET /api/automation/:id/shares',
            'POST /api/automation/:id/steps/:stepId/run', 'POST /api/automation/:id/suggest-description',
            'GET /api/automation/:id/test-cases', 'DELETE /api/automation/:id/test-cases/:caseId',
            'GET /api/automation/:id/test-cases/:caseId', 'PUT /api/automation/:id/test-cases/:caseId', 'GET /api/automation/:id/usage',
            'GET /api/automation/:id/versions', 'GET /api/automation/:id/versions/:versionId',
            'GET /api/automation/:id/versions/:versionId/diff/:otherVersionId',
            'GET /api/automation/:id/versions/:versionId/fielddiff/:other', 'PUT /api/automation/:id/versions/:versionId/name',
            'POST /api/automation/:id/versions/:versionId/restore', 'POST /api/automation/:id/webhook',
            'DELETE /api/automation/:id/webhook/:slug', 'POST /api/automation/:id/webhook/:slug/rotate',
            'POST /api/automation/:id/webhook/:slug/test', 'GET /api/automation/:id/webhooks',
            'POST /api/automation/forms/:automationId/answers-table',
            'GET /api/automation/:id/steps/:stepId/rerun-plan', 'POST /api/automation/:id/caller-notice/seen',
            'POST /api/automation/:id/form-pick', 'POST /api/automation/:id/form-scenarios', 'POST /api/automation/:id/restore',
            'POST /api/automation/:id/table-preview', 'POST /api/automation/:id/test-cases', 'POST /api/automation/:id/test-cases/run',
            'POST /api/automation/:id/transfer-owner', 'PUT /api/automation/:id/agent-bindings',
            'PUT /api/automation/:id/form-scenarios/:scenarioId', 'PUT /api/automation/:id/shares',
            'GET /api/automation/forms/:automationId', 'PUT /api/automation/forms/:automationId/audience',
        ],
        // Routes whose body is checked before the handler's access check: a valid body, so the access check answers.
        bodies: {
            'PUT /api/automation/:id/versions/:versionId/name': { name: 'A name that must not land here' },
            'POST /api/automation/:id/caller-notice/seen': { items: [] },
            'POST /api/automation/:id/form-pick': { source: 'src-matrix' },
            'POST /api/automation/:id/form-scenarios': { name: 'Matrix', fromRunId: 'r-matrix' },
            'POST /api/automation/:id/table-preview': { source: { rows: [] }, ops: [] },
            'POST /api/automation/:id/test-cases': { stepId: 's-matrix', name: 'Matrix', input: { kind: 'typed', values: {} } },
            'POST /api/automation/:id/test-cases/run': { stepId: 's-matrix' },
            'POST /api/automation/:id/transfer-owner': { userId: 'u-matrix-a' },
            'PUT /api/automation/:id/agent-bindings': { agentIds: [] },
            'PUT /api/automation/:id/form-scenarios/:scenarioId': { name: 'Matrix' },
            'PUT /api/automation/:id/shares': { shares: [] },
            'PUT /api/automation/forms/:automationId/audience': { audience: 'org' },
        },
        queries: { 'GET /api/automation/:id/steps/:stepId/rerun-plan': 'seedRunId=r-matrix' },
    },
    {
        // A finished run of an automation of org B and the routes under the run's id (routes/automation/runs.js,
        // goldens.js, runFiles, runTables, the run's form). A run is the owner's: a member of org A gets the
        // run's 404 on each; the owner reads it, and gets the 404 of a step, file or table that does not exist.
        kind: 'automationRun',
        mount: '/api/automation',
        router: () => require('../../routes/automation'),
        create: async (ctx) => {
            const { run } = await createRun(ctx);
            await automationStore().updateRun(run.id, { status: 'success', finishedAt: new Date().toISOString() });
            return run.id;
        },
        routes: [
            'GET /api/automation/runs/:id', 'GET /api/automation/runs/:id/steps', 'GET /api/automation/runs/:id/steps/:stepId/full-output',
            'GET /api/automation/runs/:runId/compare/:otherRunId', 'GET /api/automation/runs/:runId/files',
            'GET /api/automation/runs/:runId/files/:fileId', 'GET /api/automation/runs/:runId/files/:fileId/preview',
            'GET /api/automation/runs/:runId/form', 'POST /api/automation/runs/:runId/form',
            'GET /api/automation/runs/:runId/tables/:tableId', 'GET /api/automation/runs/:runId/tables/:tableId/csv',
            'POST /api/automation/runs/:id/approve', 'POST /api/automation/runs/:runId/approve-step',
            'POST /api/automation/runs/:runId/cancel', 'POST /api/automation/runs/:runId/golden',
            'DELETE /api/automation/runs/:runId/golden',
        ],
    },
    {
        // A pending approval of a run of org B, with user B as owner and no assignee (routes/automation/approvals.js):
        // a member of org A neither owns it nor sits in its routing, so gets its 404.
        kind: 'automationApproval',
        mount: '/api/automation',
        router: () => require('../../routes/automation'),
        create: async (ctx) => {
            const { automation: a, run } = await createRun(ctx);
            const approval = present(await automationStore().createApproval({
                organizationId: asNullTyped(ctx.orgId), automationId: asNullTyped(a.id), automationTitle: a.title, runId: asNullTyped(run.id), rootRunId: asNullTyped(run.id),
                stepId: asNullTyped('approve-1'), ownerId: ctx.userId, prompt: 'Approve?',
            }), 'createApproval');
            return approval.id;
        },
        routes: [
            'GET /api/automation/approvals/:id', 'GET /api/automation/approvals/:id/files/:fileId',
            'POST /api/automation/approvals/:id/decide', 'POST /api/automation/approvals/:id/remind',
            'POST /api/automation/approvals/:id/withdraw',
        ],
        bodies: { 'POST /api/automation/approvals/:id/decide': { decision: 'approve' } },
        orgAdminCaller: true,
    },
    {
        // The builder's saved session of an automation of org B (routes/ai/automationBuilder): kept per
        // automation and owner, so a member of org A gets the 404 of no session.
        kind: 'automationBuilderSession',
        mount: '/api/automation/builder',
        router: () => require('../../routes/ai/automationBuilder'),
        create: async (ctx) => {
            const a = await createAutomation(ctx);
            await automationStore().setBuilderSession(a.id, ctx.userId, { sessionId: `s-matrix-${ctx.index}`, automationId: a.id, messages: [] });
            return a.id;
        },
        routes: ['GET /api/automation/builder/session/:automationId', 'POST /api/automation/builder/session/:automationId/review'],
        bodies: { 'POST /api/automation/builder/session/:automationId/review': { action: 'applyProposal', revisionId: 'rev-matrix' } },
    },
    {
        // A folder of org B's automations (routes/automation/folders.js): a folder is looked up in the caller's own
        // organisation, so a member of org A gets its 404.
        kind: 'automationFolder',
        mount: '/api/automation',
        router: () => require('../../routes/automation'),
        create: async ({ orgId, index }) => {
            const folder = await automationStore().createFolder({ organizationId: orgId, name: `Folder ${index}` });
            return folder.id;
        },
        routes: ['PUT /api/automation/folders/:folderId', 'DELETE /api/automation/folders/:folderId'],
        bodies: { 'PUT /api/automation/folders/:folderId': { name: 'A name that must not land here' } },
        ownerStatus: 200,
        orgAdminCaller: true,
    },
    {
        // An automation template of org B (routes/automation/importExport.js): read in the caller's own organisation.
        kind: 'automationTemplate',
        mount: '/api/automation',
        router: () => require('../../routes/automation'),
        create: async ({ orgId, userId, index }) => {
            const t = await automationStore().createAutomationTemplate({ organizationId: orgId, createdBy: userId, title: `Template ${index}`, definition: { steps: [], edges: [] } });
            return present(t, 'createAutomationTemplate').id;
        },
        routes: ['GET /api/automation/templates/:id'],
        orgAdminCaller: true,
    },
    {
        // The automations an agent of org B may call (routes/automation/agentBindings.js): the agent is looked up
        // under the caller's own access, so a member of org A gets the agent's 404.
        kind: 'automationByAgent',
        mount: '/api/automation',
        router: () => require('../../routes/automation'),
        create: async ({ orgId, userId, index }) => {
            const agentStore = require('../../stores/agentStore');
            const organizationId = /** @type {null} */ (/** @type {unknown} */ (orgId));
            const agent = await agentStore.createAgent(`Bound agent ${index}`, 'matrix fixture', 'You are a test.', userId, null, [], true, true, false, {}, organizationId);
            return agent.id;
        },
        routes: ['GET /api/automation/by-agent/:agentId/automation-ids'],
    },
    {
        // The hosted form of a live automation of org B, open to the whole of org B (routes/automation/formPublic):
        // the organisation is the form's outer wall, so a member of org A gets the 404 of an unknown token on every
        // route of the form surface, the session routes before any session is looked up. The owner opens the form.
        kind: 'automationForm',
        mount: '/api/automation',
        router: () => require('../../routes/automation'),
        create: async (ctx) => {
            const store = automationStore();
            const created = await store.createAutomation({
                userId: ctx.userId, organizationId: ctx.orgId, title: `Form ${ctx.index}`, triggerType: 'form',
                definition: {
                    trigger: { id: 'trg', kind: 'form', form: { title: 'Matrix form', fields: [{ name: 'item', type: 'text', label: 'Item', required: true }] } },
                    steps: [], edges: [],
                },
            });
            if (!created) throw new Error('createAutomation answered nothing');
            await store.updateAutomation(created.id, { isActive: true, isDraft: false }, ctx.userId);
            const page = present(await store.ensureFormPage(created.id), 'ensureFormPage');
            await store.setFormPageAudience(page.id, created.id, { audience: 'org', sharedGroups: [], sharedUserIds: [] });
            return page.id;
        },
        routes: [
            'GET /api/automation/form/:token', 'POST /api/automation/form/:token', 'POST /api/automation/form/:token/upload',
            'POST /api/automation/form/:token/pick', 'GET /api/automation/form/:token/s/:sid', 'POST /api/automation/form/:token/s/:sid',
            'GET /api/automation/form/:token/s/:sid/export/:format', 'GET /api/automation/form/:token/s/:sid/file/:fileId',
            'POST /api/automation/form/:token/s/:sid/file/:fileId/notebook', 'POST /api/automation/form/:token/s/:sid/notebook',
            'POST /api/automation/form/:token/s/:sid/webpage',
        ],
        params: { format: 'pdf' },
        bodies: { 'POST /api/automation/form/:token/upload': oneFile() },
    },
];

module.exports = { FIXTURES, createAutomation };
