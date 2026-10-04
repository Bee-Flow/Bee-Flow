// @vitest-environment node
/**
 * The Automations demo's handoff-5 screens read as one story: the run list,
 * its facets and the header counts agree, the newest run is the failed test
 * the canvas rehydrates from, the versions compose into the field diff, and
 * the one-segment library routes (templates, folders, trash) are answered by
 * their own handlers instead of by `GET /api/automation/:id`, which used to
 * swallow them into "Not found".
 *
 * Run: cd agent-hub && npx vitest run src/demo/fixtures/automationsHandoff5.test.ts
 */
import { describe, it, expect } from 'vitest';
import { createDemoTransport } from '../demoTransport';
import { COMMON_ROUTES } from './common';
import * as automations from './automations';

type Json = Record<string, any>;

function demo() {
    const state = automations.createState();
    const fetch = createDemoTransport({ ...COMMON_ROUTES, ...automations.ROUTES }, state) as (url: string, init?: Json) => Promise<Response>;
    const call = async (url: string, init?: Json): Promise<{ status: number; body: Json }> => {
        const res = await fetch(url, init);
        return { status: res.status, body: await res.json() };
    };
    return { state, call };
}

const SR = '/api/automation/auto_demo_spend_report';

describe('automations demo: library routes', () => {
    it.each([
        ['/api/automation/templates', 'templates'],
        ['/api/automation/folders', 'folders'],
        ['/api/automation/_trash', 'automations'],
        ['/api/automation/catalog', 'tools'],
    ])('%s is answered by its own handler', async (url, key) => {
        const { status, body } = await demo().call(url);
        expect(status).toBe(200);
        expect(body).toHaveProperty(key);
    });

    it('lists the organisation templates before the built-in ones', async () => {
        const { body } = await demo().call('/api/automation/templates');
        const sources = body.templates.map((t: Json) => t.source);
        expect(sources.indexOf('builtin')).toBeGreaterThan(sources.lastIndexOf('org'));
    });

    it('unlocks sharing for this demo only', async () => {
        const { body } = await demo().call('/auth/my-entitlements');
        expect(body.effective.core).toContain('automation_sharing');
        expect(COMMON_ROUTES['GET /auth/my-entitlements']().effective.core).not.toContain('automation_sharing');
    });
});

describe('automations demo: runs', () => {
    it('opens on the failed test run, with the error card data on the step that stopped', async () => {
        const { call } = demo();
        const { body: list } = await call(`${SR}/runs?limit=1`);
        const [newest] = list.runs;
        expect(newest).toMatchObject({ status: 'error', isTest: true, outcome: { code: 'stopped_at' } });
        const { body } = await call(`/api/automation/runs/${newest.id}/steps`);
        const failed = body.steps.find((s: Json) => s.status === 'error');
        expect(failed.stepId).toBe(newest.outcome.params.stepId);
        expect(failed.errorInfo).toMatchObject({ code: expect.any(String), title: expect.any(String), settingKey: expect.any(String) });
        expect(failed.errorInfo.fixes.length).toBeGreaterThan(0);
        expect(body.definition.steps.length).toBeGreaterThan(0);
    });

    it('counts the facets over the same rows the list shows', async () => {
        const { call } = demo();
        const { body } = await call(`${SR}/runs?limit=100&since=${encodeURIComponent(new Date(Date.now() - 7 * 86_400_000).toISOString())}`);
        expect(body.facets.all).toBe(body.runs.length);
        expect(body.facets.failed).toBe(body.runs.filter((r: Json) => r.status === 'error').length);
        expect(body.facets.waiting).toBe(1);
        for (const r of body.runs) expect(r.stepStatuses).toHaveLength(r.stepsTotal);
    });

    it('filters on status and leaves the facets alone', async () => {
        const { body } = await demo().call(`${SR}/runs?status=error`);
        expect(body.runs.every((r: Json) => r.status === 'error')).toBe(true);
        expect(body.facets.all).toBeGreaterThan(body.runs.length);
    });

    it('says who a waiting run waits on, and remembers a reminder', async () => {
        const { call } = demo();
        const { body } = await call(`${SR}/runs?status=awaiting_approval`);
        expect(body.runs[0].outcome.params.who).toBe('S. de Boer');
        const first = await call(`/api/automation/approvals/${body.runs[0].approvalId}/remind`, { method: 'POST' });
        const again = await call(`/api/automation/approvals/${body.runs[0].approvalId}/remind`, { method: 'POST' });
        expect(first.status).toBe(200);
        expect(again.status).toBe(429);
        expect(again.body.code).toBe('remind_rate_limited');
    });

    it('header counts leave test runs out', async () => {
        const { body } = await demo().call(`${SR}/counts`);
        expect(body).toMatchObject({ versions: 5, pendingChanges: 2 });
        expect(body.runs7d).toBeGreaterThan(0);
    });
});

describe('automations demo: versions', () => {
    it('is live on v3 while editing v5', async () => {
        const { body } = await demo().call(`${SR}/versions`);
        expect(body.versions.map((v: Json) => v.version)).toEqual([5, 4, 3, 2, 1]);
        expect(body.versions.find((v: Json) => v.isLive)).toMatchObject({ version: 3, name: 'Approved by finance' });
        expect(body.versions[0].isEditing).toBe(true);
    });

    it('composes the field diff from the versions in between, both ways', async () => {
        const { call } = demo();
        const { body: ahead } = await call(`${SR}/versions/5/fielddiff/live`);
        expect(ahead.stepIds.added).toContain('over_budget');
        expect(ahead.stepIds.removed).toContain('approve_summary');
        const { body: back } = await call(`${SR}/versions/3/fielddiff/5`);
        expect(back.stepIds.removed).toContain('over_budget');
        expect(back.stepIds.added).toContain('approve_summary');
    });

    it('a layout-only save is no version, a structural one is a change not live', async () => {
        const { state, call } = demo();
        const a = state.automations.find((x: Json) => x.id === 'auto_demo_spend_report') as Json;
        const moved = JSON.parse(JSON.stringify(a.definition));
        moved.steps[0].position = { x: 40, y: 80 };
        await call(SR, { method: 'PUT', body: JSON.stringify({ definition: moved }) });
        expect(a.version).toBe(5);
        const edited = JSON.parse(JSON.stringify(moved));
        edited.steps[0].label = 'Search billing emails';
        await call(SR, { method: 'PUT', body: JSON.stringify({ definition: edited }) });
        expect(a).toMatchObject({ version: 6, pendingChanges: 3 });
    });
});

describe('automations demo: settings', () => {
    it('answers the readiness checklist', async () => {
        const { body } = await demo().call(`${SR}/readiness`);
        expect(body).toMatchObject({ stepsComplete: { ok: true }, aiAct: { required: true, status: 'valid' }, lastTest: { ok: false } });
    });

    it('records the intake check once its one open question is answered', async () => {
        const { call } = demo();
        const before = await call('/api/automation/auto_demo_intake/ai-act/check');
        expect(before.body.questions).toHaveLength(1);
        const after = await call('/api/automation/auto_demo_intake/ai-act/answers', { method: 'PUT', body: JSON.stringify({ sensitiveUse: 'no' }) });
        expect(after.body).toMatchObject({ status: 'valid', recorded: true, questions: [] });
    });

    it('shares with a group and a person', async () => {
        const { body } = await demo().call(`${SR}/shares`);
        expect(body.shares.map((s: Json) => [s.name, s.role])).toEqual([['Finance', 'run'], ['S. de Boer', 'edit']]);
        expect(body.sharingAvailable).toBe(true);
    });

    it('lists the webhook without its secret, and shows a secret only on renew', async () => {
        const { call } = demo();
        const { body } = await call(`${SR}/webhooks`);
        expect(body.webhooks).toHaveLength(1);
        expect(body.webhooks[0]).toMatchObject({ name: 'Accounting package', url: expect.stringContaining('/api/automation/webhook/') });
        expect(body.webhooks[0]).not.toHaveProperty('secret');
        const renewed = await call(`${SR}/webhook/${body.webhooks[0].id}/rotate`, { method: 'POST' });
        expect(renewed.body.webhook.secret).toBeTruthy();
    });

    it('deletes into the trash and restores from it', async () => {
        const { state, call } = demo();
        await call('/api/automation/auto_demo_vat', { method: 'DELETE' });
        const { body } = await call('/api/automation/_trash');
        expect(body.automations.map((a: Json) => a.id)).toContain('auto_demo_vat');
        await call('/api/automation/auto_demo_vat/restore', { method: 'POST' });
        expect(state.automations.some((a: Json) => a.id === 'auto_demo_vat')).toBe(true);
    });
});
