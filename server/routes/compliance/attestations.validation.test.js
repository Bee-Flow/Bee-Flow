/**
 * What the attestation routes accept, and what they say when they refuse
 * (routes/compliance/dpia.js, machinery.js, customFrameworks.js and aiAct.js
 * — the register surface where an admin puts something on the record; the
 * relevance note lives in frameworks.test.js beside the route it belongs to).
 *
 * All four kept a value they did not recognise instead of refusing it, and on
 * a register that an auditor samples that is the whole problem:
 *
 *   - dpiaStore answers an unknown `mode` with 'attestation', so a completed
 *     Art-35(7) questionnaire filed under a near-miss spelling was stored as a
 *     bare attestation — answers in the body, "nobody answered anything" on
 *     the row, 200 with the saved row;
 *   - `evidence_refs` is filtered by the store down to OBJECTS carrying an
 *     evidence_id or a sha256, so a list of bare hash STRINGS passed the
 *     `evidence_required` gate (non-empty array) and landed as `[]`;
 *   - a check row's `evidence_required` was `=== true || === 'true' || === 1`,
 *     so 'yes' imported the item as NOT requiring evidence;
 *   - `answers` on an AI-Act assessment was read off a key nobody checked, so
 *     `answer` attested the outcome of the live signals alone.
 *
 * Run: cd server && node --test routes/compliance/attestations.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');
const express = require('express');

// Every store, evidence and runner call lands in `touched`. A refused request
// must leave it empty.
const touched = [];
const pass = (req, res, next) => next();

const OUTCOMES = ['compliant', 'partial', 'non_compliant', 'not_applicable'];

const customFrameworkStore = {
    OUTCOMES,
    InvalidCodeError: class InvalidCodeError extends Error {},
    CodeTakenError: class CodeTakenError extends Error {},
    customCheckId: (code, ref) => `CUSTOM-${code}-${ref}`,
    isCurrent: () => true,
    listFrameworks: async (orgId, opts) => { touched.push({ what: 'listFrameworks', args: [orgId, opts] }); return []; },
    createFramework: async (orgId, input) => { touched.push({ what: 'createFramework', args: [orgId, input] }); return { id: 'fw', ...input }; },
    getFramework: async () => ({ id: 'fw', code: 'ACME', attestation_valid_months: 12 }),
    updateFramework: async (orgId, id, patch) => { touched.push({ what: 'updateFramework', args: [orgId, id, patch] }); return { id, ...patch }; },
    listChecks: async () => [],
    upsertChecks: async (orgId, fwId, rows) => { touched.push({ what: 'upsertChecks', args: [orgId, fwId, rows] }); return rows; },
    getCheck: async () => ({ id: 'ck', framework_id: 'fw', framework_code: 'ACME', ref: 'A.1', evidence_required: true }),
    attest: async (orgId, input) => { touched.push({ what: 'attest', args: [orgId, input] }); return { id: 'att', ...input, evidence_refs: input.evidenceRefs || [] }; },
    listAttestations: async (orgId, checkId, subjectId, opts) => { touched.push({ what: 'listAttestations', args: [orgId, checkId, subjectId, opts] }); return []; },
    listLatestByPrefix: async () => [],
};

const MOCKS = {
    '../../stores/complianceStore': {
        addEvidence: async (row) => { touched.push({ what: 'addEvidence', args: [row] }); return { id: 'ev' }; },
        getSettings: async () => ({ machinery_manual_subjects: [] }),
        getLatestPerCheck: async () => [],
    },
    '../../stores/dpiaStore': {
        listForOrg: async () => [],
        getLatestForAgent: async () => null,
        upsertAssessment: async (orgId, agentId, input) => { touched.push({ what: 'upsertAssessment', args: [orgId, agentId, input] }); return { agent_id: agentId, ...input }; },
    },
    '../../stores/customFrameworkStore': customFrameworkStore,
    '../../stores/aiActAssessmentStore': {
        isCurrent: () => true,
        listForOrg: async () => [],
        getLatest: async () => null,
        listHistory: async () => [],
        record: async (orgId, kind, id, input) => { touched.push({ what: 'record', args: [orgId, kind, id, input] }); return { target_kind: kind, target_id: id, ...input, attested_at: '2026-01-01T00:00:00Z' }; },
    },
    '../../compliance/aiAct/signals': {
        titlesFor: async () => ({}),
        loadAgent: async (orgId, id) => ({ id, name: 'Support agent' }),
        loadAutomation: async (orgId, id) => ({ id, title: 'Nightly sweep' }),
        signalsForAgent: async () => ({ public: true }),
        signalsForAutomation: async () => ({ public: false }),
    },
    '../../compliance/aiAct/assess': {
        // The questionnaire's own vocabulary: the outcome follows the answers.
        assess: (live, answers) => ({
            answers, outcome: answers.high_risk === true ? 'high_risk' : 'limited_risk',
            expires_at: null, open_duties: [],
        }),
        openDuties: () => [],
    },
    '../../compliance/runner': { runOne: async (...a) => { touched.push({ what: 'runOne', args: a }); } },
    '../../compliance/events': { emit: () => {} },
    '../../compliance/evidence/writeFailures': { onEvidenceWriteFailed: () => () => {} },
    '../../auth/permissions': { requireAuth: pass, requirePermission: () => pass },
    '../../core/entitlements/entitlements': { requireCapability: () => pass },
    './shared': { resolveOrgId: async () => 'orgA', requireOrgId: async () => 'orgA' },
    './counts': { invalidate: () => {} },
    '../../db': { getAll: async () => [] },
};

MOCKS['../events'] = MOCKS['../../compliance/events'];
MOCKS['./assess'] = MOCKS['../../compliance/aiAct/assess'];

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:compliance-attestations-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    // compliance/aiAct/attest.js is the shared writer the aiAct route calls
    // (the automation's own AI Act check uses it too), so it resolves against
    // the same stubs.
    if (parent && /compliance[\\/]((dpia|machinery|customFrameworks|aiAct)|aiAct[\\/]attest)\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = express.Router();
router.use(require('./dpia'));
router.use(require('./machinery'));
router.use(require('./customFrameworks'));
router.use(require('./aiAct'));
test.after(() => { Module._resolveFilename = originalResolve; });

const { dispatcher } = require('../../core/http/routeHarness');

const dispatch = dispatcher(router);

test.beforeEach(() => { touched.length = 0; });

async function refuses(request, field) {
    const res = await dispatch(request);
    const what = `${request.method} ${request.url} ${JSON.stringify(request.body)}`;
    assert.strictEqual(res.statusCode, 400, what);
    assert.strictEqual(res.body.code, 'invalid_request', what);
    assert.ok(res.body.details.some((d) => d.path === field),
        `the 400 must name ${field}; it said ${JSON.stringify(res.body.details)}`);
    assert.deepStrictEqual(touched, [], 'a refused request must not reach the store');
    return res;
}

// ═══ POST /dpia/:agentId ═══════════════════════════════════════════

test('a misspelled mode is refused instead of filing a questionnaire as a bare attestation', async () => {
    const res = await refuses({ method: 'POST', url: '/dpia/agent-7', body: { mode: 'questionaire', risk_level: 'high' } }, 'body.mode');
    assert.strictEqual(res.body.error, 'mode is one of: attestation, questionnaire.');
});

test('a misspelled risk level is refused rather than stored verbatim', async () => {
    const res = await refuses({ method: 'POST', url: '/dpia/agent-7', body: { mode: 'attestation', risk_level: 'hgih' } }, 'body.risk_level');
    assert.strictEqual(res.body.error, 'risk_level is one of: low, medium, high.');
});

test('a misspelled mitigations key is refused rather than losing the measures', async () => {
    await refuses({ method: 'POST', url: '/dpia/agent-7', body: { mode: 'questionnaire', mitigation: ['PII redaction'] } }, 'body');
});

test('the quick attest and the questionnaire the DPIA drawer sends both still save', async () => {
    const quick = await dispatch({ method: 'POST', url: '/dpia/agent-7', body: { mode: 'attestation', risk_level: 'medium', expires_at: '2027-09-22T00:00:00.000Z' } });
    assert.strictEqual(quick.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'upsertAssessment').args[2].mode, 'attestation');

    touched.length = 0;
    const full = await dispatch({
        method: 'POST', url: '/dpia/agent-7',
        body: {
            mode: 'questionnaire', risk_level: 'high', expires_at: '2027-09-22T00:00:00.000Z',
            // The three answers a questionnaire cannot do without
            // (dpia.validation.test.js pins the refusals).
            answers: {
                purpose: 'Support triage', data_categories: 'Ticket text',
                automated_decisions: false, human_oversight: 'An agent sends every reply',
            },
            mitigations: ['PII redaction before the model call'],
        },
    });
    assert.strictEqual(full.statusCode, 200);
    const saved = touched.find((t) => t.what === 'upsertAssessment').args[2];
    assert.strictEqual(saved.mode, 'questionnaire');
    assert.deepStrictEqual(saved.mitigations, ['PII redaction before the model call']);
    assert.strictEqual(saved.answers.purpose, 'Support triage', 'the questionnaire keeps its own vocabulary');
});

// ═══ POST /machinery/subjects/:id/attest ═══════════════════════════

test('evidence refs as bare hash strings are refused, instead of landing as an empty list', async () => {
    const res = await refuses({
        method: 'POST', url: '/machinery/subjects/plc:line-3/attest',
        body: { classification: 'safety_component', evidence_refs: ['a'.repeat(64)] },
    }, 'body.evidence_refs.0');
    assert.ok(/object/i.test(res.body.error), `a string is not an evidence reference; it said ${res.body.error}`);
});

test('the upload drawer\'s evidence rows still reach the attestation', async () => {
    const res = await dispatch({
        method: 'POST', url: '/machinery/subjects/plc:line-3/attest',
        body: { classification: 'monitoring_only', statement: 'Read-only OPC-UA tap.', evidence_refs: [{ sha256: 'a'.repeat(64), filename: 'tap.pdf' }] },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(touched.find((t) => t.what === 'attest').args[1].evidenceRefs[0].sha256, 'a'.repeat(64));
});

test('a misspelled classification keeps its own answer, which lists the three', async () => {
    const res = await dispatch({ method: 'POST', url: '/machinery/subjects/plc:line-3/attest', body: { classification: 'safety_componet' } });
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'invalid_outcome');
});

test('a misspelled machinery key is refused rather than dropped from the assessment', async () => {
    await refuses({ method: 'POST', url: '/machinery/subjects/plc:line-3/attest', body: { classification: 'safety_component', statment: 'x' } }, 'body');
});

// ═══ Custom frameworks ═════════════════════════════════════════════

test('a check row that says evidence is required with "yes" is refused, not imported as not required', async () => {
    const res = await refuses({
        method: 'POST', url: '/custom/frameworks/11111111-1111-1111-1111-111111111111/checks',
        body: { checks: [{ ref: 'A.1', title: 'Encryption at rest', evidence_required: 'yes' }] },
    }, 'body.0.evidence_required');
    assert.strictEqual(res.body.error, 'evidence_required is true or false.');
});

test('the questionnaire import still upserts its rows', async () => {
    const res = await dispatch({
        method: 'POST', url: '/custom/frameworks/11111111-1111-1111-1111-111111111111/checks',
        body: { checks: [{ ref: 'A.1', title: 'Encryption at rest', severity: 'high', evidence_required: true }] },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'upsertChecks').args[2][0].evidence_required, true);
});

test('a bare array of rows is still accepted, as the import posts it', async () => {
    const res = await dispatch({
        method: 'POST', url: '/custom/frameworks/11111111-1111-1111-1111-111111111111/checks',
        body: [{ ref: 'A.1', title: 'Encryption at rest' }],
    });
    assert.strictEqual(res.statusCode, 200);
});

test('an evidence reference with neither an id nor a hash is refused by name', async () => {
    const res = await refuses({
        method: 'POST', url: '/custom/checks/22222222-2222-2222-2222-222222222222/attest',
        body: { outcome: 'compliant', evidence_refs: [{ filename: 'proof.pdf' }] },
    }, 'body.evidence_refs.0');
    assert.strictEqual(res.body.error, 'An evidence reference needs an evidence_id or a sha256.');
});

test('an attestation whose evidence is a list of strings is refused before the gate lets it through', async () => {
    await refuses({
        method: 'POST', url: '/custom/checks/22222222-2222-2222-2222-222222222222/attest',
        body: { outcome: 'compliant', evidence_refs: ['a'.repeat(64)] },
    }, 'body.evidence_refs.0');
});

test('the attest drawer\'s body still records, with its evidence rows', async () => {
    const res = await dispatch({
        method: 'POST', url: '/custom/checks/22222222-2222-2222-2222-222222222222/attest',
        body: { outcome: 'compliant', statement: 'Reviewed annually.', evidence_refs: [{ sha256: 'b'.repeat(64) }] },
    });
    assert.strictEqual(res.statusCode, 201);
    assert.strictEqual(touched.find((t) => t.what === 'attest').args[1].outcome, 'compliant');
});

test('a misspelled framework patch key is refused rather than answered with an unchanged row', async () => {
    await refuses({
        method: 'PUT', url: '/custom/frameworks/11111111-1111-1111-1111-111111111111',
        body: { nmae: 'Acme questionnaire' },
    }, 'body');
});

test('a validity that is not a whole number of months is refused in words', async () => {
    const res = await refuses({ method: 'POST', url: '/custom/frameworks', body: { code: 'ACME', name: 'Acme', attestation_valid_months: 'twelve' } }, 'body.attestation_valid_months');
    assert.strictEqual(res.body.error, 'attestation_valid_months is a whole number of months, 1..120.');
});

test('a misspelled archive filter is refused, not read as "hide the archived ones"', async () => {
    const res = await dispatch({ method: 'GET', url: '/custom/frameworks?include_archive=1' });
    assert.strictEqual(res.statusCode, 400);
    assert.ok(res.body.details.some((d) => d.path === 'query'));
});

test('the archive filter the page sends still reaches the store', async () => {
    const res = await dispatch({ method: 'GET', url: '/custom/frameworks?include_archived=1' });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'listFrameworks').args[1].includeArchived, true);
});

// ═══ PUT /ai-act/assessments/:kind/:id ══════════════════════════

test('a misspelled answers key is refused, instead of attesting an empty questionnaire', async () => {
    await refuses({ method: 'PUT', url: '/ai-act/assessments/agent/a1', body: { answer: { high_risk: true } } }, 'body');
});

test('answers that are not an object are refused in words', async () => {
    const res = await refuses({ method: 'PUT', url: '/ai-act/assessments/agent/a1', body: { answers: 'high_risk' } }, 'body.answers');
    assert.strictEqual(res.body.error, 'answers is a JSON object.');
});

test('the ladder\'s answers still reach assess, and the outcome follows them', async () => {
    const res = await dispatch({ method: 'PUT', url: '/ai-act/assessments/agent/a1', body: { answers: { high_risk: true } } });
    assert.strictEqual(res.statusCode, 200);
    const rec = touched.find((t) => t.what === 'record');
    assert.strictEqual(rec.args[3].outcome, 'high_risk');
    assert.deepStrictEqual(rec.args[3].answers, { high_risk: true });
});
