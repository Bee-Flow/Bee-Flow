/**
 * routes/compliance/aiAct — auth, strict org scoping, per-kind membership,
 * allow-listed evidence, event emission.
 * Run: node --test --test-force-exit server/routes/compliance/aiAct.test.js
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

// ── Stand-ins ───────────────────────────────────────────────────────
const state = {
    // what each org owns
    automations: { 'org-1': { 'au-1': { id: 'au-1', title: 'Offerte-brieven' } }, 'org-2': { 'au-9': { id: 'au-9', title: 'Elsewhere' } } },
    agents: { 'org-1': { 'ag-1': { id: 'ag-1', name: 'Helpdesk' } } },
    signals: { contains_ai: true, customer_facing: true, generates_content: true, disclosure_present: false, marking_enabled: false, annex_iii_hint: false, steps: { ai: [], generating: [] } },
    rows: [],
    evidence: [],
    events: [],
    nextId: 1,
};

const mockSignals = {
    loadAutomation: async (orgId, id) => (state.automations[orgId] || {})[id] || null,
    loadAgent: async (orgId, id) => (state.agents[orgId] || {})[id] || null,
    signalsForAutomation: async (orgId, id) => ((state.automations[orgId] || {})[id] ? { ...state.signals } : null),
    signalsForAgent: async (orgId, id) => ((state.agents[orgId] || {})[id] ? { ...state.signals, customer_facing: true } : null),
    titlesFor: async (orgId, targets) => {
        const out = { automation: {}, agent: {} };
        for (const t of targets) {
            const src = t.target_kind === 'agent' ? state.agents : state.automations;
            const row = (src[orgId] || {})[t.target_id];
            if (row) out[t.target_kind][t.target_id] = row.title || row.name;
        }
        return out;
    },
};

const mockAssessmentStore = {
    record: async (orgId, kind, targetId, { signals, answers, outcome, attestedBy, expiresAt }) => {
        const row = {
            id: state.nextId++, organization_id: orgId, target_kind: kind, target_id: String(targetId),
            signals, answers, outcome, attested_by: attestedBy || null,
            attested_at: new Date('2026-09-14T10:00:00Z'), expires_at: expiresAt, created_at: new Date(),
        };
        state.rows.push(row);
        return row;
    },
    getLatest: async (orgId, kind, id) => [...state.rows].reverse().find(r => r.organization_id === orgId && r.target_kind === kind && r.target_id === id) || null,
    listHistory: async (orgId, kind, id) => [...state.rows].reverse().filter(r => r.organization_id === orgId && r.target_kind === kind && r.target_id === id),
    listForOrg: async (orgId) => {
        const seen = new Set();
        return [...state.rows].reverse().filter(r => {
            if (r.organization_id !== orgId) return false;
            const k = `${r.target_kind}:${r.target_id}`;
            if (seen.has(k)) return false;
            seen.add(k);
            return true;
        });
    },
    isCurrent: (row) => !!row && (!row.expires_at || new Date(row.expires_at).getTime() > Date.now()),
};

const mockComplianceStore = {
    addEvidence: async (row) => { state.evidence.push(row); return { id: state.evidence.length, seq: state.evidence.length, hash: 'h' }; },
    getSettings: async () => ({ ai_content_marking_enabled: false }),
};
const mockEvents = {
    EVENTS: { AI_ACT_ATTESTED: 'ai_act_attested' },
    emit: (name, payload) => { state.events.push({ name, payload }); },
};
const mockPermissions = {
    requireAuth: (req, res, next) => (req.session?.user ? next() : res.status(401).json({ error: 'Not authenticated' })),
    requirePermission: () => (req, res, next) => (req.session?.user?.canCompliance
        ? next()
        : res.status(403).json({ error: "Permission 'admin_compliance' required" })),
};
// shared.requireOrgId: strict — no organisation → 403, never 'default'.
const mockShared = {
    requireOrgId: async (req, res) => {
        const orgId = req.session?.user?.organizationId || null;
        if (!orgId) { res.status(403).json({ error: 'no_organisation' }); return null; }
        return orgId;
    },
};

const STUBS = [
    ['../../compliance/aiAct/signals.js', mockSignals],
    ['../../stores/aiActAssessmentStore.js', mockAssessmentStore],
    ['../../stores/complianceStore.js', mockComplianceStore],
    ['../../compliance/events.js', mockEvents],
    ['../../auth/permissions.js', mockPermissions],
    ['./shared.js', mockShared],
].map(([rel, exports]) => [require.resolve(rel), exports]);
for (const [file, exports] of STUBS) require.cache[file] = { id: file, filename: file, loaded: true, exports };

const router = require('./aiAct');
test.after(() => { for (const [file] of STUBS) delete require.cache[file]; });

// ── Harness ─────────────────────────────────────────────────────────
let currentSession = null;
const app = express();
app.use(express.json());
app.use((req, _res, next) => { req.session = currentSession; next(); });
app.use('/api/compliance', router);
let server;
let base;

test.before(async () => {
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}/api/compliance`;
});
test.after(() => server && server.close());

const ADMIN = { user: { id: 'u-admin', organizationId: 'org-1', canCompliance: true } };
const NO_ORG = { user: { id: 'u-lonely', organizationId: null, canCompliance: true } };
const NO_PERM = { user: { id: 'u-plain', organizationId: 'org-1', canCompliance: false } };

async function call(method, path, body, session = ADMIN) {
    currentSession = session;
    const res = await fetch(base + path, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not json */ }
    return { status: res.status, json };
}

test('unauthenticated → 401, no admin_compliance → 403, no organisation → 403 (never the default bucket)', async () => {
    assert.strictEqual((await call('GET', '/ai-act/assessments', null, null)).status, 401);
    assert.strictEqual((await call('GET', '/ai-act/assessments', null, NO_PERM)).status, 403);
    const r = await call('GET', '/ai-act/assessments', null, NO_ORG);
    assert.strictEqual(r.status, 403);
    assert.strictEqual(r.json.error, 'no_organisation');
    assert.strictEqual((await call('PUT', '/ai-act/assessments/automation/au-1', { answers: {} }, NO_ORG)).status, 403);
    assert.strictEqual(state.rows.length, 0, 'nothing written');
});

test('kind and id are validated', async () => {
    assert.deepStrictEqual((await call('GET', '/ai-act/assessments/widget/au-1')).json, { error: 'invalid_kind', allowed: ['automation', 'agent'] });
    assert.strictEqual((await call('GET', '/ai-act/assessments/automation/' + encodeURIComponent('bad id!'))).status, 400);
    assert.strictEqual((await call('PUT', '/ai-act/assessments/automation/au-1', { answers: ['x'] })).status, 400);
});

test('org scoping per kind: a target in another org (or unknown) is a 404 on detail, signals and PUT', async () => {
    assert.strictEqual((await call('GET', '/ai-act/assessments/automation/au-9')).status, 404, 'org-2 automation');
    assert.strictEqual((await call('GET', '/ai-act/assessments/automation/au-9/signals')).status, 404);
    assert.strictEqual((await call('PUT', '/ai-act/assessments/automation/au-9', { answers: {} })).status, 404);
    assert.strictEqual((await call('GET', '/ai-act/assessments/agent/ag-404')).status, 404);
    assert.strictEqual(state.rows.length, 0);
    assert.strictEqual(state.evidence.length, 0);
});

test('detail of a never-assessed target carries live signals, null outcome and the open duties', async () => {
    const r = await call('GET', '/ai-act/assessments/automation/au-1');
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.title, 'Offerte-brieven');
    assert.strictEqual(r.json.outcome, null);
    assert.strictEqual(r.json.current, false);
    assert.strictEqual(r.json.signals.contains_ai, true);
    assert.deepStrictEqual(r.json.open_duties, ['art50_1_disclosure', 'art50_2_marking']);
    assert.deepStrictEqual(r.json.history, []);
    const live = await call('GET', '/ai-act/assessments/automation/au-1/signals');
    assert.strictEqual(live.status, 200);
    assert.strictEqual(live.json.generates_content, true);
});

test('PUT records the row, writes an allow-listed evidence row and emits AI_ACT_ATTESTED', async () => {
    const r = await call('PUT', '/ai-act/assessments/automation/au-1', {
        answers: {
            art5: { answer: 'no', practices: [] },
            art50: { interacts: 'yes', disclosure: 'no', generates: 'yes', marking: 'no', prompt: 'You are a helpful assistant for Jan Jansen' },
            annex_iii: { answer: 'no', category: null, contact: 'jan@example.com' },
        },
    });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.outcome, 'transparency');
    assert.strictEqual(r.json.target_kind, 'automation');
    assert.strictEqual(r.json.target_id, 'au-1');
    assert.strictEqual(r.json.attested_by, 'u-admin');
    assert.strictEqual(r.json.current, true);
    assert.strictEqual(r.json.title, 'Offerte-brieven');
    assert.ok(!('prompt' in r.json.answers.art50), 'free text never reaches the stored answers');
    assert.ok(!JSON.stringify(r.json.answers).includes('example.com'));

    assert.strictEqual(state.rows.length, 1);
    assert.strictEqual(state.rows[0].organization_id, 'org-1');
    assert.strictEqual(new Date(state.rows[0].expires_at).toISOString().slice(0, 7), new Date(Date.now()).getUTCFullYear() + 1 + '-' + String(new Date().getUTCMonth() + 1).padStart(2, '0'));

    assert.strictEqual(state.evidence.length, 1);
    const ev = state.evidence[0];
    assert.strictEqual(ev.organization_id, 'org-1');
    assert.strictEqual(ev.check_id, 'AIA-Art53-model-inventory');
    assert.strictEqual(ev.subject_type, 'ai_act_assessment');
    assert.strictEqual(ev.subject_id, 'automation:au-1');
    assert.deepStrictEqual(Object.keys(ev.payload).sort(), ['actor', 'attested_at', 'outcome', 'target_id', 'target_kind']);
    assert.deepStrictEqual(
        [ev.payload.target_kind, ev.payload.target_id, ev.payload.outcome, ev.payload.actor],
        ['automation', 'au-1', 'transparency', 'u-admin'],
    );
    assert.match(ev.payload.attested_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(!JSON.stringify(ev.payload).includes('Offerte'), 'no title in evidence');

    assert.deepStrictEqual(state.events, [{
        name: 'ai_act_attested',
        payload: { orgId: 'org-1', targetKind: 'automation', targetId: 'au-1', outcome: 'transparency', actorId: 'u-admin' },
    }]);
});

test('a prohibited answer wins; the list shows the newest row per target with its title', async () => {
    const r = await call('PUT', '/ai-act/assessments/agent/ag-1', { answers: { art5: { answer: 'yes', practices: ['social_scoring'] } } });
    assert.strictEqual(r.status, 200);
    assert.strictEqual(r.json.outcome, 'prohibited');

    const again = await call('PUT', '/ai-act/assessments/automation/au-1', { answers: { annex_iii: { answer: 'yes', category: 'employment' } } });
    assert.strictEqual(again.json.outcome, 'high_risk');

    const list = await call('GET', '/ai-act/assessments');
    assert.strictEqual(list.status, 200);
    assert.strictEqual(list.json.length, 2, 'DISTINCT ON target');
    const au = list.json.find(x => x.target_kind === 'automation');
    assert.deepStrictEqual(Object.keys(au).sort(), ['attested_at', 'attested_by', 'current', 'expires_at', 'outcome', 'target_id', 'target_kind', 'title']);
    assert.strictEqual(au.outcome, 'high_risk');
    assert.strictEqual(au.title, 'Offerte-brieven');
    assert.strictEqual(list.json.find(x => x.target_kind === 'agent').title, 'Helpdesk');

    const detail = await call('GET', '/ai-act/assessments/automation/au-1');
    assert.strictEqual(detail.json.outcome, 'high_risk');
    assert.strictEqual(detail.json.history.length, 2);
    assert.deepStrictEqual(detail.json.history.map(h => h.outcome), ['high_risk', 'transparency']);

    // another org sees nothing of it
    const other = await call('GET', '/ai-act/assessments', null, { user: { id: 'u2', organizationId: 'org-2', canCompliance: true } });
    assert.deepStrictEqual(other.json, []);
});
