// @typecheck
/**
 * The DPIA expiry nudge fires once per assessment and expiry date, like every
 * other sweep of the deadline notifier, not on every daily tick of the 30-day
 * window.
 *
 * Run: cd server && node --test jobs/complianceDeadlineNotifier.dpia.test.js
 */

'use strict';

process.env.NODE_ENV = 'test';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const notifier = require('./complianceDeadlineNotifier');

const NOW = Date.parse('2026-09-14T12:00:00Z');
const DAY = 24 * 3600 * 1000;
const at = (ms) => new Date(NOW + ms).toISOString();

function harness(dpias) {
    const sent = [];
    const claimed = new Set();
    const deps = {
        now: () => NOW,
        getAll: async (sql, params) => {
            if (/FROM users/.test(sql)) return params[0] === 'org_a' ? [{ id: 'admin_a' }] : [];
            if (/FROM dpia_assessments/.test(sql)) return params[0] === 'org_a' ? dpias : [];
            return [];
        },
        userStore: { getAllOrganizations: async () => [{ id: 'org_a' }] },
        notificationStore: { createNotification: async (n) => { sent.push(n); } },
        complianceStore: {
            markNotified: async (...key) => {
                const k = key.join('|');
                if (claimed.has(k)) return false;
                claimed.add(k);
                return true;
            },
        },
        incidentStore: { listNeedingAttention: async () => [], listOpenClocks: async () => [] },
        dsrStore: { listOpenWithDeadlines: async () => [] },
        obligationStore: null,
        aiActAssessmentStore: { listExpiring: async () => [] },
        frameworkPolicy: null,
        calendar: null,
        frameworks: { MILESTONES: [] },
    };
    const dpiaNudges = () => sent.filter((n) => n.title === 'DPIA re-attestation due');
    return { deps, dpiaNudges };
}

test('a DPIA inside the 30-day window is announced once, not on every daily tick', async () => {
    const dpias = [
        { agent_id: 'agent-1', expires_at: at(20 * DAY) },
        { agent_id: 'agent-2', expires_at: at(90 * DAY) },
    ];
    const { deps, dpiaNudges } = harness(dpias);

    await notifier.runOnce({ deps });
    assert.equal(dpiaNudges().length, 1);
    assert.match(dpiaNudges()[0].message, /^1 impact assessment\(s\) expire within 30 days/);

    for (let day = 1; day <= 5; day++) {
        deps.now = () => NOW + day * DAY;
        await notifier.runOnce({ deps });
    }
    assert.equal(dpiaNudges().length, 1, 'the following daily ticks stay quiet');
});

test('an assessment that enters the window later, or is re-attested and nears its next expiry, is announced', async () => {
    const dpias = [{ agent_id: 'agent-1', expires_at: at(20 * DAY) }, { agent_id: 'agent-2', expires_at: at(40 * DAY) }];
    const { deps, dpiaNudges } = harness(dpias);
    await notifier.runOnce({ deps });
    assert.equal(dpiaNudges().length, 1);

    // agent-2 crosses into the window: one nudge that counts it alone.
    deps.now = () => NOW + 15 * DAY;
    await notifier.runOnce({ deps });
    assert.equal(dpiaNudges().length, 2);
    assert.match(dpiaNudges()[1].message, /^1 impact assessment/);

    // agent-1 re-attested for a year, then that expiry nears: a new expiry date, a new nudge.
    dpias[0] = { agent_id: 'agent-1', expires_at: at(385 * DAY) };
    deps.now = () => NOW + 16 * DAY;
    await notifier.runOnce({ deps });
    assert.equal(dpiaNudges().length, 2);
    deps.now = () => NOW + 360 * DAY;
    await notifier.runOnce({ deps });
    assert.equal(dpiaNudges().length, 3);
});
