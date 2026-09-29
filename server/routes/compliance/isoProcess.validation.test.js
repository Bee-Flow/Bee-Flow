/**
 * What the ISMS process routes accept, and what they say when they refuse
 * (routes/compliance/isoProcess.js).
 *
 * The stores under this router never throw on a value they do not know: they
 * keep what was there, or substitute the mildest member of the set, and the
 * route answers 200 with the row. So `option: 'avoid '` was filed as
 * MITIGATE, `severity: 'critical'` on an audit finding as OBSERVATION, and
 * `status: 'acepted'` left the risk open while skipping both the acceptance
 * stamp and the evidence row. What this file pins is the part a caller can
 * act on:
 *
 *   - the 400 NAMES the field (`body.option`), not just "invalid request";
 *   - the message is a sentence that lists the values, including for a field
 *     simply left out;
 *   - the store is never reached, so a refused request changes nothing;
 *   - and the bodies the two register pages really send still go through.
 *
 * Run: cd server && node --test --test-force-exit routes/compliance/isoProcess.validation.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert');
const Module = require('module');

// Every store call lands in `touched`. A refused request must leave it empty.
const touched = [];
const note = (what) => (...args) => { touched.push({ what, args }); return { id: 1, ...(args[1] || {}) }; };
const pass = (req, res, next) => next();

const riskStore = {
    listRisks: async () => [], listTreatments: async () => [], getStats: async () => ({}),
    createRisk: async (...a) => note('createRisk')(...a),
    updateRisk: async (...a) => note('updateRisk')(...a),
    addTreatment: async (...a) => note('addTreatment')(...a),
    seedMissing: async (...a) => { touched.push({ what: 'seedMissing', args: a }); return 0; },
};
const auditStore = {
    listAudits: async () => [], listFindings: async () => [], listReviews: async () => [],
    listNonconformities: async () => [], listObjectives: async () => [],
    createAudit: async (...a) => note('createAudit')(...a),
    updateAudit: async (...a) => note('updateAudit')(...a),
    addFinding: async (...a) => { touched.push({ what: 'addFinding', args: a }); return { id: 1 }; },
    createReview: async (...a) => note('createReview')(...a),
    createNonconformity: async (...a) => note('createNonconformity')(...a),
    updateNonconformity: async (...a) => note('updateNonconformity')(...a),
    createObjective: async (...a) => note('createObjective')(...a),
    updateObjective: async (...a) => note('updateObjective')(...a),
};
const obligationStore = {
    listObligations: async () => [],
    createObligation: async (...a) => note('createObligation')(...a),
    updateObligation: async (...a) => note('updateObligation')(...a),
    completeObligation: async (...a) => { touched.push({ what: 'completeObligation', args: a }); return { id: 1 }; },
};

const MOCKS = {
    '../../stores/complianceStore': {
        addEvidence: async (row) => { touched.push({ what: 'addEvidence', args: [row] }); return row; },
        getLatestPerCheck: async () => [], getScoreHistory: async () => [], getSettings: async () => ({}),
    },
    '../../stores/soaStore': { getStats: async () => null, listEntries: async () => [] },
    '../../stores/ismsDocStore': { listDocs: async () => [] },
    '../../stores/incidentStore': { getDeadlineStats: async () => null },
    '../../stores/configStore': { getConfig: async () => null },
    '../../db': { getAll: async () => [] },
    '../../auth/permissions': { requireAuth: pass, requirePermission: () => pass },
    './shared': {
        resolveOrgId: async () => 'orgA',
        _riskStore: () => riskStore,
        _auditStore: () => auditStore,
        _obligationStore: () => obligationStore,
    },
};

const MOCK_IDS = {};
for (const [request, exportsObj] of Object.entries(MOCKS)) {
    const mockId = `mock:iso-process-validation:${request}`;
    MOCK_IDS[request] = mockId;
    require.cache[mockId] = { id: mockId, filename: mockId, loaded: true, exports: exportsObj };
}
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
    if (parent && /compliance[\\/]isoProcess\.js$/.test(parent.filename)
        && Object.prototype.hasOwnProperty.call(MOCK_IDS, request)) {
        return MOCK_IDS[request];
    }
    return originalResolve.call(this, request, parent, ...rest);
};

const router = require('./isoProcess');
test.after(() => { Module._resolveFilename = originalResolve; });

// A schema refusal travels as an error to the terminal handler, so the
// harness has to answer one the way index.js does.
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

function dispatch({ method, url, body = {} }) {
    return new Promise((resolve, reject) => {
        const [pathname, search = ''] = String(url).split('?');
        const query = {};
        for (const [k, v] of new URLSearchParams(search)) query[k] = v;
        const req = {
            method, url, originalUrl: url, path: pathname, query, body, headers: {},
            session: { user: { id: 'u1' } }, get() { return undefined; },
        };
        const res = {
            statusCode: 200, headersSent: false,
            set() { return this; }, setHeader() {},
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            send(b) { this.body = b; this.headersSent = true; resolve(this); return this; },
            end() { this.headersSent = true; resolve(this); return this; },
        };
        router(req, res, (err) => {
            if (!err) return reject(new Error(`fell through: ${method} ${url}`));
            terminalErrorHandler(err, req, res, (e) => reject(e));
        });
    });
}

test.beforeEach(() => { touched.length = 0; });

/** Assert: refused with 400, the named field is in `details`, nothing touched. */
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

// ═══ 6.1 the risk register ══════════════════════════════════════════

test('a treatment option nobody implements is refused, not filed as "mitigate"', async () => {
    // 'avoid ' fell back to mitigate: the register then said the org would
    // reduce a risk it had decided to walk away from.
    const res = await refuses({ method: 'POST', url: '/iso/risks/7/treatments', body: { option: 'avoid ' } }, 'body.option');
    assert.strictEqual(res.body.error, 'option is one of: mitigate, transfer, avoid, accept.');
});

test('a treatment with no option is refused in words, not with "Required"', async () => {
    const res = await refuses({ method: 'POST', url: '/iso/risks/7/treatments', body: {} }, 'body.option');
    assert.strictEqual(res.body.error, 'option is one of: mitigate, transfer, avoid, accept.',
        'the caller reads this sentence');
});

test('a misspelled risk status is refused instead of leaving the risk exactly as it was', async () => {
    // 'acepted' kept the old status AND skipped the acceptance stamp and the
    // evidence row, under a 200 carrying the unchanged row.
    await refuses({ method: 'PUT', url: '/iso/risks/7', body: { status: 'acepted' } }, 'body.status');
});

test('a likelihood that is not a number is refused, not stored as the middle of the scale', async () => {
    await refuses({ method: 'POST', url: '/iso/risks', body: { title: 'Prompt leak', likelihood: 'hoog' } }, 'body.likelihood');
});

test('a likelihood off the 1-5 scale is refused rather than clamped to 5', async () => {
    await refuses({ method: 'POST', url: '/iso/risks', body: { title: 'Prompt leak', likelihood: 9 } }, 'body.likelihood');
});

test('a misspelled key is refused rather than answered 200 with nothing changed', async () => {
    await refuses({ method: 'PUT', url: '/iso/risks/7', body: { titel: 'Prompt leak' } }, 'body');
});

test('the body the risk drawer really sends still saves', async () => {
    const res = await dispatch({
        method: 'PUT', url: '/iso/risks/7',
        body: {
            title: 'Prompt leak', description: 'Users paste customer data', category: 'confidentiality',
            likelihood: 4, impact: 4, status: 'treating', owner_user_id: null, review_due_at: null,
        },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'updateRisk').args[2].status, 'treating');
});

// ═══ 9.2 audits and findings ════════════════════════════════════════

test('an audit finding severity outside the set is refused, not downgraded to an observation', async () => {
    // 'observation' is the one severity that raises no nonconformity, so the
    // silent downgrade turned a major finding into a note.
    const res = await refuses({
        method: 'POST', url: '/iso/audits/3/findings',
        body: { description: 'Backups never restored', severity: 'critical' },
    }, 'body.severity');
    assert.strictEqual(res.body.error, 'severity is one of: observation, minor, major.');
});

test('a misspelled audit status is refused instead of leaving the audit open', async () => {
    await refuses({ method: 'PUT', url: '/iso/audits/3', body: { status: 'in-progress' } }, 'body.status');
});

test('the "close audit" button still closes the audit', async () => {
    const res = await dispatch({ method: 'PUT', url: '/iso/audits/3', body: { status: 'closed' } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'updateAudit').args[2].status, 'closed');
});

// ═══ 10 nonconformities ═════════════════════════════════════════════

test('raising a nonconformity from a finding still carries the finding id', async () => {
    // The audits tab sends `finding_id`; the store does not read it, but a
    // `.strict()` body that left it out would break that button.
    const res = await dispatch({
        method: 'POST', url: '/iso/ncs',
        body: { title: 'Backups never restored', description: 'From internal audit', source: 'internal_audit', severity: 'major', finding_id: 12 },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'createNonconformity').args[1].severity, 'major');
});

test('a nonconformity severity outside the set is refused, not filed as "minor"', async () => {
    await refuses({ method: 'POST', url: '/iso/ncs', body: { title: 'x', severity: 'critical' } }, 'body.severity');
});

test('"confirm effectiveness & close" still closes the nonconformity', async () => {
    const res = await dispatch({ method: 'PUT', url: '/iso/ncs/5', body: { status: 'closed', confirm_effectiveness: true } });
    assert.strictEqual(res.statusCode, 200);
    assert.strictEqual(touched.find((t) => t.what === 'updateNonconformity').args[2].confirm_effectiveness, true);
});

test('a confirmation sent as the string "true" is refused rather than read as a human pressing confirm', async () => {
    await refuses({ method: 'PUT', url: '/iso/ncs/5', body: { status: 'closed', confirm_effectiveness: 'true' } }, 'body.confirm_effectiveness');
});

// ═══ 9.3 management reviews ═════════════════════════════════════════

test('the 9.3.2 agenda snapshot passes through the schema untouched', async () => {
    const inputs = { score_now: 71, failing_checks: 3, soa_approved: '40/93' };
    const res = await dispatch({
        method: 'POST', url: '/iso/reviews',
        body: { held_at: '2026-09-22', attendees: [{ id: 'u1', name: 'A' }], decisions: 'Renew the pentest', inputs },
    });
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(touched.find((t) => t.what === 'createReview').args[1].inputs, inputs);
});

test('a management review with no date is refused in words', async () => {
    const res = await refuses({ method: 'POST', url: '/iso/reviews', body: { decisions: 'x' } }, 'body.held_at');
    assert.strictEqual(res.body.error, 'held_at is required — the date the review was held.');
});

// ═══ 6.2 objectives and the obligations engine ══════════════════════

test('a misspelled objective status is refused instead of leaving it active', async () => {
    await refuses({ method: 'PUT', url: '/iso/objectives/2', body: { status: 'acheived' } }, 'body.status');
});

test('an obligation kind nobody schedules is refused, not filed as "custom"', async () => {
    await refuses({ method: 'POST', url: '/iso/obligations', body: { title: 'Policy review', due_at: '2026-12-01', kind: 'polcy_review' } }, 'body.kind');
});

test('a recurrence that is not a number is refused rather than making the obligation evergreen', async () => {
    // 'twaalf' became null, which is "never again" — not "every year".
    await refuses({ method: 'POST', url: '/iso/obligations', body: { title: 'Policy review', due_at: '2026-12-01', recur_months: 'twaalf' } }, 'body.recur_months');
});

test('reminder tiers that are not days are refused rather than replaced by the defaults', async () => {
    await refuses({
        method: 'POST', url: '/iso/obligations',
        body: { title: 'Policy review', due_at: '2026-12-01', notify_offsets: ['dertig'] },
    }, 'body.notify_offsets.0');
});

test('an obligation with no due date is refused in words', async () => {
    const res = await refuses({ method: 'POST', url: '/iso/obligations', body: { title: 'Policy review' } }, 'body.due_at');
    assert.strictEqual(res.body.error, 'due_at is required — when this obligation falls due.');
});

test('an unreadable due date is refused rather than reaching the column as Invalid Date', async () => {
    await refuses({ method: 'PUT', url: '/iso/obligations/4', body: { due_at: 'morgen' } }, 'body.due_at');
});

// ═══ the empty-body buttons ═════════════════════════════════════════

test('the seed button posts an empty body and still seeds', async () => {
    const res = await dispatch({ method: 'POST', url: '/iso/risks/seed', body: {} });
    assert.strictEqual(res.statusCode, 200);
    assert.ok(touched.some((t) => t.what === 'seedMissing'));
});

test('a key the seed route does not read is refused rather than silently ignored', async () => {
    await refuses({ method: 'POST', url: '/iso/risks/seed', body: { provider: 'Scaleway' } }, 'body');
});

test('a training note is capped rather than truncated in silence', async () => {
    await refuses({ method: 'POST', url: '/iso/training/u2/attest', body: { note: 'x'.repeat(301) } }, 'body.note');
});
