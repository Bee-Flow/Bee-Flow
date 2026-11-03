/**
 * A headless dry run (MCP, the AI builder, mobile, the API: pauses
 * 'synthesise') asks nobody, and says so (RM-4, tests-and-docs F7, pauses F10).
 *
 *   - an approval is auto-approved in the ONE approval output shape
 *     (approvalOutput.mts: approved, by, reason, decidedAt, answers, votes),
 *     its answers blank per approver question, marked dryRunSynthesised with
 *     dryRunFallback 'auto_approved', and named in the run's warnings;
 *   - a form page is answered with blanks, marked 'form_blank', and warned;
 *   - the dry-run-only `prompt` output key is gone; the question, details,
 *     questions, attachments and a names-free count of who a live run would
 *     ask are in `_preview`, with a warning for a route nobody can take.
 *
 * Seat and licence lookups are injected through dryPause.mts's seam.
 * Run: node --test core/automationRunner/execApproval.synthesise.test.js
 */

const { test, beforeEach, after } = require('node:test');
const assert = require('node:assert');

require('../../automation/runnerPorts');
require('../../integrations/runnerPorts');
require('../../services/runnerPorts');
process.env.NODE_ENV = 'test';

const { execApproval, execFormPage } = require('./execApproval');
const { setPauseDepsForTests } = require('./dryPause.mts');
const { approvalOutput } = require('../automationModel/approvalOutput.mts');
const { profileFor } = require('../automationModel/runProfile.mts');

const CONTRACT = Object.keys(approvalOutput()).sort();
const dataKeys = (out) => Object.keys(out).filter((k) => !k.startsWith('_')).sort();

// Org 'org1' knows user u-in and group g-full (2 members) and g-empty (none).
const MEMBERS = new Set(['u-in']);
const GROUPS = { 'g-full': 2, 'g-empty': 0 };
beforeEach(() => setPauseDepsForTests({
    hasCapability: async () => true,
    validateAssignee: async (seat) => {
        if (seat.userId) return MEMBERS.has(seat.userId) ? { userId: seat.userId } : null;
        return seat.groupId in GROUPS ? { groupId: seat.groupId } : null;
    },
    groupMemberTotal: async (groupId) => GROUPS[groupId] || 0,
}));
after(() => setPauseDepsForTests(null));

const dryCtx = (extra = {}) => ({
    userId: 'owner-1', orgId: 'org1', layerStack: [],
    profile: profileFor({ mode: 'dry_run', startedByUserId: 'tester-1' }, {}),
    ...extra,
});
const state = () => ({
    trigger: { output: { supplier: 'Example Supplies' } },
    steps: { gen: { output: { fileId: 'file-9' } } },
    vars: {}, secrets: {}, _templateWarnings: [],
});

const APPROVAL = {
    id: 'ap', type: 'approval', title: 'Manager sign-off', prompt: 'Pay {{trigger.output.supplier}}?',
    approval: {
        details: 'Supplier: **{{trigger.output.supplier}}**',
        fields: [
            { name: 'budget', label: 'Approved budget', type: 'number' },
            { name: 'tags', label: 'Tags', type: 'multiselect', options: ['a', 'b'] },
        ],
        attachments: [
            { binding: '{{steps.gen.output.fileId}}', label: 'Quote' },
            { binding: '{{steps.missing.output.fileId}}', label: 'Contract' },
        ],
        stages: [
            { name: 'Team lead', approvers: [{ userId: 'u-in' }, { userId: 'u-out' }] },
            { name: 'Finance', approvers: [{ groupId: 'g-empty' }, { userId: 'u-out' }] },
            { name: 'Board', approvers: [{ groupId: 'g-full' }], when: 'false' },
        ],
    },
};

test('the auto-approval has exactly the contract keys, filled the way a decision would be', async () => {
    const before = Date.now();
    const res = await execApproval(APPROVAL, dryCtx(), state(), 'dry_run');
    assert.deepStrictEqual(dataKeys(res.output), CONTRACT);
    assert.strictEqual(res.output.approved, true);
    assert.strictEqual(res.output.by, 'dry_run');
    assert.strictEqual(res.output.reason, null);
    assert.deepStrictEqual(res.output.votes, []);
    assert.ok(Date.parse(res.output.decidedAt) >= before - 1000, 'decidedAt is a real timestamp');
    // Blank per approver question, so steps.ap.output.answers.budget resolves.
    assert.deepStrictEqual(Object.keys(res.output.answers).sort(), ['budget', 'tags']);
    assert.deepStrictEqual(res.output.answers.tags, []);
    assert.strictEqual(res.output._dryRun, true);
    assert.strictEqual(res.output.prompt, undefined, 'the dry-run-only prompt key is dropped');
});

test('it is marked as synthesised, so reads that bind it synthesise too', async () => {
    const res = await execApproval(APPROVAL, dryCtx(), state(), 'dry_run');
    assert.strictEqual(res.dryRunSynthesised, true);
    assert.strictEqual(res.dryRunFallback, 'auto_approved');
});

test('the run warnings name the step: auto-approved, and the routes a live run could not take', async () => {
    const rs = state();
    await execApproval(APPROVAL, dryCtx(), rs, 'dry_run');
    const text = rs._templateWarnings.join('\n');
    assert.match(text, /Approval "Manager sign-off" was auto-approved \(simulated\)/);
    assert.match(text, /stage "Finance": no approver is a member of this organisation/);
    assert.ok(!/stage "Team lead"/.test(text), 'a stage with one member is fine');
    assert.ok(!/stage "Board"/.test(text), 'a skipped stage asks nobody, so it needs nobody');
    assert.match(text, /attachment "Contract" resolved to nothing/);
    assert.ok(!text.includes('Example Supplies'), 'a warning carries no run value');
});

test('the preview says what a live run would ask, and of how many seats, never who', async () => {
    const res = await execApproval(APPROVAL, dryCtx(), state(), 'dry_run');
    const p = res.output._preview;
    assert.strictEqual(p.prompt, 'Pay Example Supplies?');
    assert.match(p.detailsMd, /Example Supplies/);
    assert.deepStrictEqual(p.fields.map((f) => f.name), ['budget', 'tags']);
    assert.deepStrictEqual(p.attachments, [{ label: 'Quote', resolved: true }, { label: 'Contract', resolved: false }]);
    assert.strictEqual(p.route, 'stages');
    assert.deepStrictEqual(p.stages, [
        { name: 'Team lead', skipped: false, seatCount: 1 },
        { name: 'Finance', skipped: false, seatCount: 0 },
        { name: 'Board', skipped: true, seatCount: 1 },
    ]);
    const json = JSON.stringify(p);
    for (const id of ['u-in', 'u-out', 'g-full', 'g-empty']) assert.ok(!json.includes(id), `no seat id in the preview (${id})`);
});

test('a single assignee outside the organisation is a warning; no assignee asks the owner', async () => {
    const rs = state();
    const res = await execApproval({ id: 'a2', type: 'approval', prompt: 'ok?', approval: { assignee: { userId: 'u-out' } } }, dryCtx(), rs, 'dry_run');
    assert.strictEqual(res.output._preview.route, 'assignee');
    assert.strictEqual(res.output._preview.assigneeSeatCount, 0);
    assert.match(rs._templateWarnings.join('\n'), /the assignee is not a member of this organisation/);
    const plain = await execApproval({ id: 'a3', type: 'approval', prompt: 'ok?' }, dryCtx(), state(), 'dry_run');
    assert.strictEqual(plain.output._preview.route, 'owner');
    assert.deepStrictEqual(plain.output.answers, {});
});

test('a form page is answered with blanks, marked form_blank and warned', async () => {
    const rs = state();
    const page = { id: 'fp', type: 'form_page', mode: 'input', title: 'Delivery', form: { title: 'Delivery', fields: [{ name: 'street', type: 'text', label: 'Street' }] } };
    const res = await execFormPage(page, dryCtx(), rs, 'dry_run');
    assert.deepStrictEqual(res.output, { street: '', _dryRun: true });
    assert.strictEqual(res.dryRunSynthesised, true);
    assert.strictEqual(res.dryRunFallback, 'form_blank');
    assert.match(rs._templateWarnings.join('\n'), /Form page "Delivery" was answered with blanks \(simulated\)/);
});

test('a live run is untouched: no preview, it pauses as before', async () => {
    await assert.rejects(
        execApproval(APPROVAL, { ...dryCtx(), profile: profileFor({ mode: 'live' }, {}) }, state(), 'live'),
        (e) => e.name === 'ApprovalRequiredError' && e.preview === null && e.prompt === 'Pay Example Supplies?',
    );
});
