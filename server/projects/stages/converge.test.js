/**
 * CONVERGE (design 6.4), with every store and engine injected.
 *
 * Pinned:
 *   - the tasks come from the deployment's own commit journal, so a resumed
 *     converge does the same: a flipped automation gets convergeAfterPublish
 *     (saveSyncs, the stage's organisation, the previous live definition), a
 *     page its `current/` slots from the pinned version with the capability,
 *     an app its usage reindex, a retired automation loses its subscriptions,
 *     tables drop the engine cache, knowledge bumps the base version;
 *   - a feed event `deployment.succeeded` on the stage and on Dev;
 *   - a failing task is retried with backoff, up to 5 attempts; what still
 *     fails gives `succeeded_with_warnings` with task and ref only.
 *
 * Run: cd server && node --test projects/stages/converge.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { converge, MAX_ATTEMPTS } = require('./converge');

const STAGE = { projectId: 'p_uat', solutionId: 'p_dev', stage: 'uat', organizationId: 'org1', runAsUserId: 'so' };
const DEPLOYMENT = { id: 'dep_1', kind: 'deploy', releaseSeq: 2, requestedBy: 'so' };

function harness(steps) {
    const log = [];
    const deps = {
        solutionStageStore: {
            listSteps: async () => steps,
            transitionDeployment: async (id, from, to, patch) => { log.push(['status', from, to, patch.report]); return { id, status: to }; },
        },
        automationStore: {
            getAutomation: async (id) => ({ id, kind: 'automation', isActive: true, liveDefinition: { steps: ['live'] }, definition: { steps: ['working'] } }),
            getVersionDefinitions: async (pairs) => new Map(pairs.map(p => [`${p.automationId}@${p.version}`, { steps: ['before'] }])),
            deleteSubscriptionsForAutomation: async (id) => { log.push(['subs_deleted', id]); },
        },
        webpageStore: {
            getWebpageRaw: async (id) => ({ id, publishedVersionId: 'ver_9' }),
            restoreSlotFromVersion: async (owner, id, versionId, slot, opts) => { log.push(['slot', id, versionId, slot, opts.managedWrite.deploymentId]); },
        },
        datatableStore: { orgScope: (id) => ({ kind: 'org', id }) },
        datatableDbStore: { scopeKey: (s) => `${s.kind}:${s.id}`, invalidate: (k) => { log.push(['invalidate', k]); } },
        kbStore: { bumpKBVersion: async (id) => { log.push(['kb_bump', id]); } },
        goLive: {
            convergeAfterPublish: async (args) => {
                log.push(['converge', args.automation.id, args.saveSyncs, args.organizationId, args.previousLive, args.definition]);
                return { warnings: [] };
            },
        },
        reconcileAppUsage: async (id) => { log.push(['app_usage', id]); },
        revokeRemoteSubscriptions: async (id, owner) => { log.push(['revoke', id, owner]); },
        emitProjectEvent: async (projectId, event) => { log.push(['feed', projectId, event.kind, event.payload.deploymentId]); },
        sleep: async (ms) => { log.push(['sleep', ms]); },
    };
    return { log, deps };
}

test('the tasks come from the commit journal and the deployment closes as succeeded', async () => {
    const steps = [
        { phase: 'prepare', action: 'write_working', entityId: 'u-aut-1', before: { liveVersion: 4 } },
        { phase: 'commit', action: 'flip', kind: 'automation', ref: 'aut_1', entityId: 'u-aut-1' },
        { phase: 'commit', action: 'flip', kind: 'webpage', ref: 'web_1', entityId: 'u-web-1' },
        { phase: 'commit', action: 'flip', kind: 'app', ref: 'app_1', entityId: 'u-app-1' },
        { phase: 'commit', action: 'retire', kind: 'automation', ref: 'aut_9', entityId: 'u-aut-9' },
        { phase: 'commit', action: 'schema', kind: 'datatable', ref: 'dt_1', entityId: 'tbl_1' },
        { phase: 'commit', action: 'knowledge', kind: 'knowledge_base', ref: 'kb_1', entityId: 'kb-uat' },
    ];
    const h = harness(steps);
    const out = await converge({ deployment: DEPLOYMENT, stage: STAGE }, h.deps);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'converge'),
        ['converge', 'u-aut-1', true, 'org1', { steps: ['before'] }, { steps: ['live'] }]);
    assert.deepStrictEqual(h.log.filter(e => e[0] === 'slot').map(e => e[3]), ['html', 'css', 'js']);
    assert.ok(h.log.filter(e => e[0] === 'slot').every(e => e[2] === 'ver_9' && e[4] === 'dep_1'));
    assert.deepStrictEqual(h.log.find(e => e[0] === 'app_usage'), ['app_usage', 'u-app-1']);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'revoke'), ['revoke', 'u-aut-9', 'so']);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'subs_deleted'), ['subs_deleted', 'u-aut-9']);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'invalidate'), ['invalidate', 'org:org1']);
    assert.deepStrictEqual(h.log.find(e => e[0] === 'kb_bump'), ['kb_bump', 'kb-uat']);
    assert.deepStrictEqual(h.log.filter(e => e[0] === 'feed').map(e => e[1]), ['p_uat', 'p_dev']);
    assert.ok(!h.log.some(e => e[0] === 'sleep'), 'nothing was retried');
    assert.deepStrictEqual(h.log.find(e => e[0] === 'status').slice(1, 3), [['converging'], 'succeeded']);
    assert.deepStrictEqual(out.report, { warnings: [], attempts: 1 });
});

test('a task that fails is retried with backoff; one that keeps failing gives succeeded_with_warnings', async () => {
    const h = harness([]);
    let flaky = 0;
    h.deps.tasks = [
        { name: 'flaky', ref: 'aut_1', run: async () => { flaky += 1; if (flaky < 3) throw new Error('not yet'); } },
        { name: 'broken', ref: 'web_1', run: async () => { throw Object.assign(new Error('secret body text'), { code: 'storage_down' }); } },
    ];
    const out = await converge({ deployment: DEPLOYMENT, stage: STAGE }, h.deps);
    assert.strictEqual(flaky, 3);
    assert.strictEqual(out.report.attempts, MAX_ATTEMPTS);
    assert.deepStrictEqual(out.report.warnings, [{ task: 'broken', ref: 'web_1', code: 'storage_down' }]);
    assert.deepStrictEqual(h.log.filter(e => e[0] === 'sleep').map(e => e[1]), [1000, 2000, 4000, 8000]);
    assert.strictEqual(h.log.find(e => e[0] === 'status')[2], 'succeeded_with_warnings');
    assert.ok(!JSON.stringify(out.report).includes('secret'), 'no message text in the report');
});

test('automation side effects that come back as warnings count as a failed task', async () => {
    const h = harness([{ phase: 'commit', action: 'flip', kind: 'automation', ref: 'aut_1', entityId: 'u-aut-1' }]);
    h.deps.goLive = { convergeAfterPublish: async () => ({ warnings: [{ step: 'form pages', message: 'x' }] }) };
    h.deps.maxAttempts = 2;
    const out = await converge({ deployment: DEPLOYMENT, stage: STAGE }, h.deps);
    assert.deepStrictEqual(out.report.warnings, [{ task: 'automation', ref: 'aut_1', code: 'failed' }]);
    assert.strictEqual(out.report.attempts, 2);
});
