/**
 * Characterisation ("golden") test of executeAutomation's main paths.
 *
 * Pins the ORDER of everything a run does to the outside world — store writes,
 * lifecycle events, the trigger-payload Privacy Shield gate, notifications and
 * the approval hand-off — for the paths a user can tell apart: a plain live
 * run, a dry run, a scanned trigger payload, a payload the shield blocks, a
 * run skipped because the automation is busy, a failing step with its retry,
 * a disabled brancher and a pinned step, an approval pause, and the primary
 * and secondary schedule advancement. Written before execution.js was split
 * into modules, so the split can be checked against what the code did.
 *
 * Everything is driven through the real runner; only the outside world is
 * cut: the automation store, the safety, event bus, notification, outcome and
 * approval collaborators get their methods replaced on the real module
 * objects (the runner reads them through the object, or destructures them
 * after the patch is in place), and are restored after the file.
 *
 * Run: cd server && node --test core/automationRunner/execution.golden.test.js
 */

const { test, beforeEach } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

process.env.NODE_ENV = 'test';
process.env.AUTOMATION_AUTH_LEGACY = '0';

/** Everything the runner did to the outside world, in order. */
let trace = [];
const runs = new Map();
let markRunningAnswer = true;

const storeStub = {
    initDB: async () => {},
    createRun: async (args) => {
        const row = { id: 'run-1', status: 'queued', rootRunId: args.rootRunId ?? null, ...args };
        runs.set(row.id, row);
        trace.push(`createRun:${args.triggerKind}:${args.mode}:${args.rootStepId}:${args.isTest}`);
        return row;
    },
    getRun: async (id) => { trace.push('getRun'); return runs.get(id) ? { ...runs.get(id) } : null; },
    getAutomation: async () => null,
    updateRun: async (id, patch) => {
        Object.assign(runs.get(id) || {}, patch);
        const keys = Object.keys(patch).sort().join(',');
        trace.push(`updateRun:${patch.status || '-'}:${keys}`);
        return true;
    },
    getRunsForAutomation: async () => [],
    getRunSteps: async () => [],
    getRunStepsForRuns: async () => [],
    recordRunStep: async (rec) => {
        trace.push(`recordRunStep:${rec.stepId}:${rec.status}:${rec.attempts}`);
        const r = runs.get(rec.runId);
        if (r) (r._steps ||= []).push(rec);
    },
    markRunning: async () => { trace.push('markRunning'); return markRunningAnswer; },
    releaseAutomation: async () => { trace.push('releaseAutomation'); },
    resetAttempts: async () => { trace.push('resetAttempts'); },
    updateAutomation: async (id, patch) => {
        const shown = Object.keys(patch).sort().map(k => (k === 'isActive' || k === 'lastStatus' ? `${k}=${patch[k]}` : (k === 'nextRunAt' ? `${k}=${patch[k] ? 'set' : 'null'}` : k))).join(',');
        trace.push(`updateAutomation:${shown}`);
    },
    advanceSchedule: async (id, patch) => { trace.push(`advanceSchedule:${id}:${patch.nextRunAt ? 'next' : 'none'}:${patch.lastStatus}`); },
    getRunTokenMap: async () => { trace.push('getRunTokenMap'); return null; },
    saveRunTokenMap: async () => { trace.push('saveRunTokenMap'); return true; },
    requestCancelRun: async () => null,
    touchRunHeartbeat: async () => {},
    touchAutomationRunning: async () => {},
};

// The real modules, their methods replaced for this file (no module-system
// stubbing: the runner reads `automationStore.<fn>` and the others at call
// time), restored afterwards.
const patched = [];
function patch(obj, fns) {
    for (const [k, fn] of Object.entries(fns)) { patched.push([obj, k, obj[k]]); obj[k] = fn; }
}
test.after(() => { for (const [obj, k, fn] of patched.reverse()) obj[k] = fn; });

patch(require('../../stores/automationStore'), storeStub);
patch(require('../../stores/userStore'), { getUser: async () => null });
patch(require('../../auth/audience'), { resolveUserGroups: async () => [] });
// Approvals are gated on the Enterprise `approvals` capability (covered by
// engine.approval.test.js).
patch(require('../entitlements/entitlements'), { hasCapability: async () => true });

// ── Collaborators patched on their module objects ─────────────────────────
let shield = { enabled: false, block: false };
patch(require('./safety'), {
    resolveAutomationPolicy: async () => {
        trace.push('safety.resolvePolicy');
        return { piiEnabled: shield.enabled, regexRules: [] };
    },
    buildAuditBase: (ctx, step) => ({ step: step.id }),
    guardToolInput: async (value, policy, audit) => {
        trace.push(`safety.guardInput:${audit.step}`);
        if (shield.block) {
            const e = new Error('Blocked by the Privacy Shield');
            e.guardrailBlocked = true;
            throw e;
        }
        return { value: { ...value, name: '[person_1]' } };
    },
    restoreForRunState: (value) => {
        trace.push('safety.restoreForRunState');
        return { ...value, name: `restored(${value.name})` };
    },
});

patch(require('../runEventBus'), { emitRunEvent: (type) => { trace.push(`emit:${type}`); } });
patch(require('./runNotifications'), {
    notifyRunEvent: async (automation, event, payload) => { trace.push(`notify:${event}:${payload.code || payload.title}`); },
});
patch(require('./approvalLifecycle'), {
    createApprovalOnPause: async () => { trace.push('createApprovalOnPause'); return { id: 'appr-1' }; },
    approvalNotificationTargets: async () => { trace.push('approvalNotificationTargets'); return { userIds: ['u9'], link: '/approvals/appr-1' }; },
});
patch(require('../../automation/runOutcome'), {
    resolveRunOutcome: async (input) => {
        trace.push(`resolveRunOutcome:${input.status}`);
        return { code: `outcome.${input.status}` };
    },
});

// The run's token vault is flushed to disk before the run row goes terminal
// (an approval resumes in another process from that map). The factory is
// destructured at load, so the wrap goes in before the runner is required and
// delegates to the real vault.
const tokenVaultModule = require('./tokenVault');
const realCreateTokenVault = tokenVaultModule.createTokenVault;
let flushedAt = [];
patch(tokenVaultModule, {
    createTokenVault: (opts) => {
        const vault = realCreateTokenVault(opts);
        const realFlush = vault.flush;
        vault.flush = (...a) => { flushedAt.push(trace.length); return realFlush(...a); };
        return vault;
    },
});

const { executeAutomation } = require(path.join(__dirname, 'execution.js'));

/** Index of the first terminal (finishedAt-carrying) updateRun in the trace. */
const terminalWrite = () => trace.findIndex(t => /^updateRun:[a-z_]+:.*finishedAt/.test(t));

beforeEach(() => {
    trace = [];
    runs.clear();
    markRunningAnswer = true;
    shield = { enabled: false, block: false };
    flushedAt = [];
});

function automation(steps, extra = {}) {
    const ids = steps.map(s => s.id);
    return {
        id: 'auto-g', version: 3, userId: 'user-1', organizationId: 'org-a', title: 'Golden', triggerType: 'manual',
        definition: {
            trigger: { id: 'trig', type: 'trigger', kind: 'manual' },
            steps,
            edges: ids.map((id, i) => ({ from: i === 0 ? 'trig' : ids[i - 1], to: id })),
        },
        ...extra,
    };
}
const SET = { id: 's1', type: 'set', fields: { greeting: { kind: 'literal', value: 'hi' } } };

test('a live run: created, marked, started, stepped, finalised, released, notified — in that order', async () => {
    const row = await executeAutomation(automation([SET]), { triggerKind: 'manual' });
    assert.strictEqual(row.status, 'success');
    assert.deepStrictEqual(row.lastOutput, { greeting: 'hi' });
    assert.deepStrictEqual(trace, [
        'createRun:manual:live:trig:false',
        'markRunning',
        'updateRun:running:startedAt,status',
        'emit:run.started',
        'emit:step.started',
        'recordRunStep:s1:running:1',
        'getRun',
        'recordRunStep:s1:success:1',
        'emit:step.finished',
        'getRun',
        'updateRun:success:durationMs,error,finishedAt,status,summary',
        'resolveRunOutcome:success',
        'updateRun:-:outcome',
        'emit:run.finished',
        'updateAutomation:lastRunAt,lastStatus=success',
        'releaseAutomation',
        'resetAttempts',
        'notify:onSuccess:🤖 Golden',
        'getRun',
    ]);
    assert.deepStrictEqual(flushedAt, [terminalWrite()], 'the vault is flushed once, right before the terminal row write');
});

test('a dry run never touches the marker, the event stream or the notifications', async () => {
    const row = await executeAutomation(automation([SET]), { triggerKind: 'dry_run', mode: 'dry_run' });
    assert.strictEqual(row.status, 'success');
    assert.deepStrictEqual(trace, [
        'createRun:dry_run:dry_run:trig:true',
        'updateRun:running:startedAt,status',
        'recordRunStep:s1:running:1',
        'getRun',
        'recordRunStep:s1:success:1',
        'getRun',
        'updateRun:success:durationMs,error,finishedAt,status,summary',
        'resolveRunOutcome:success',
        'updateRun:-:outcome',
        'getRun',
    ]);
});

test('a trigger payload is scanned by the Privacy Shield after the run starts and before step 1', async () => {
    shield.enabled = true;
    const def = automation([{ id: 's1', type: 'set', fields: { who: { kind: 'ref', path: 'trigger.output.name' } } }]);
    const row = await executeAutomation(def, { triggerKind: 'webhook', triggerPayload: { name: 'Jan' } });
    assert.strictEqual(row.status, 'success');
    assert.deepStrictEqual(row.lastOutput, { who: 'restored([person_1])' }, 'the run state holds what restoreForRunState returned');
    assert.deepStrictEqual(trace.slice(0, 8), [
        'createRun:webhook:live:trig:false',
        'markRunning',
        'updateRun:running:startedAt,status',
        'emit:run.started',
        'safety.resolvePolicy',
        'safety.guardInput:trigger:webhook',
        'safety.restoreForRunState',
        'emit:step.started',
    ]);
    assert.strictEqual(trace[10], 'recordRunStep:s1:success:1');
});

test('a payload the shield blocks fails the run before any step, and releases the marker', async () => {
    shield = { enabled: true, block: true };
    const row = await executeAutomation(automation([SET]), { triggerKind: 'webhook', triggerPayload: { name: 'Jan' } });
    assert.strictEqual(row.status, 'error');
    assert.strictEqual(row.errorClass, 'guardrail_blocked');
    assert.strictEqual(row.summary, 'Failed: Blocked by the Privacy Shield');
    assert.strictEqual(row.lastOutput, null);
    assert.deepStrictEqual(trace, [
        'createRun:webhook:live:trig:false',
        'markRunning',
        'updateRun:running:startedAt,status',
        'emit:run.started',
        'safety.resolvePolicy',
        'safety.guardInput:trigger:webhook',
        'updateRun:error:durationMs,error,errorClass,finishedAt,status,summary',
        'resolveRunOutcome:error',
        'updateRun:-:outcome',
        'updateAutomation:lastRunAt,lastStatus=error',
        'releaseAutomation',
        'emit:run.failed',
        'getRun',
    ]);
    assert.deepStrictEqual(flushedAt, [], 'the blocked path writes no vault');
});

test('a manual run that finds the automation busy is cancelled without running anything', async () => {
    markRunningAnswer = false;
    const row = await executeAutomation(automation([SET]), { triggerKind: 'manual' });
    assert.strictEqual(row.status, 'cancelled');
    assert.strictEqual(row.error, 'Skipped: automation already running');
    assert.strictEqual(row.lastOutput, null);
    assert.deepStrictEqual(trace, [
        'createRun:manual:live:trig:false',
        'markRunning',
        'updateRun:cancelled:durationMs,error,finishedAt,status,summary',
        'resolveRunOutcome:cancelled',
        'updateRun:-:outcome',
        'emit:run.started',
        'emit:run.finished',
        'getRun',
    ]);
});

test('a failing step records every attempt, then the run fails with a sanitised summary and an error notification', async () => {
    const row = await executeAutomation(automation([{ id: 'bad', type: 'bogus', retry: { max: 1 } }]), { triggerKind: 'manual' });
    assert.strictEqual(row.status, 'error');
    assert.match(row.summary, /^Failed: Unknown step type: bogus/);
    assert.deepStrictEqual(trace, [
        'createRun:manual:live:trig:false',
        'markRunning',
        'updateRun:running:startedAt,status',
        'emit:run.started',
        'emit:step.started',
        'recordRunStep:bad:running:1',
        'getRun',
        'recordRunStep:bad:error:1',
        'recordRunStep:bad:error:2',
        'updateRun:error:durationMs,error,errorClass,finishedAt,status,summary',
        'resolveRunOutcome:error',
        'updateRun:-:outcome',
        'emit:run.failed',
        'updateAutomation:lastRunAt,lastStatus=error',
        'releaseAutomation',
        'notify:onError:⚠️ Automation failed: Golden',
        'getRun',
    ]);
});

test('a disabled If passes through its then-port, a pinned step answers with its pin', async () => {
    const def = automation([
        { id: 'pin', type: 'set', fields: {}, pinnedOutput: { pinned: 42 } },
        { id: 'cond', type: 'condition', disabled: true, expr: 'false' },
        { id: 'tail', type: 'set', fields: { v: { kind: 'ref', path: 'steps.pin.output.pinned' } } },
    ]);
    def.definition.edges = [
        { from: 'trig', to: 'pin' }, { from: 'pin', to: 'cond' },
        { from: 'cond', to: 'tail', label: 'then' },
    ];
    const row = await executeAutomation(def, { triggerKind: 'manual' });
    assert.strictEqual(row.status, 'success');
    assert.deepStrictEqual(row.lastOutput, { v: 42 });
    const steps = runs.get('run-1')._steps.filter(s => s.status !== 'running').map(s => [s.stepId, s.status, JSON.stringify(s.output)]);
    assert.deepStrictEqual(steps, [
        ['pin', 'pinned', '{"pinned":42}'],
        ['cond', 'skipped', '{"disabled":true,"branch":"then"}'],
        ['tail', 'success', '{"v":42}'],
    ]);
});

test('an approval pauses the run: token minted, row awaiting, approval created, outcome, approver notified', async () => {
    const row = await executeAutomation(automation([{ id: 'ap', type: 'approval', prompt: 'ok?' }, SET]), { triggerKind: 'manual' });
    assert.strictEqual(row.status, 'awaiting_approval');
    assert.strictEqual(row.summary, 'Waiting for approval.');
    assert.strictEqual(row.awaitingStepId, 'ap');
    assert.match(row.approvalToken, /^[0-9a-f]{48}$/);
    assert.deepStrictEqual(trace, [
        'createRun:manual:live:trig:false',
        'markRunning',
        'updateRun:running:startedAt,status',
        'emit:run.started',
        'emit:step.started',
        'recordRunStep:ap:running:1',
        'getRun',
        'recordRunStep:ap:awaiting_approval:1',
        'updateRun:awaiting_approval:approvalToken,awaitingStepExpiresAt,awaitingStepId,durationMs,error,finishedAt,status,summary',
        'createApprovalOnPause',
        'resolveRunOutcome:awaiting_approval',
        'updateRun:-:outcome',
        'emit:run.finished',
        'updateAutomation:lastRunAt,lastStatus=awaiting_approval',
        'releaseAutomation',
        'approvalNotificationTargets',
        'notify:onApproval:automation.notify.approval_needed',
        'getRun',
    ]);
    assert.deepStrictEqual(flushedAt, [terminalWrite()], 'the paused run hands its vault over before the row says awaiting');
});

test('a primary schedule run advances next_run_at after the notifications', async () => {
    const def = automation([SET], { triggerType: 'schedule', scheduleCron: '0 9 * * *', scheduleTz: 'Europe/Amsterdam' });
    const row = await executeAutomation(def, { triggerKind: 'schedule' });
    assert.strictEqual(row.status, 'success');
    assert.deepStrictEqual(trace.slice(-6), [
        'updateAutomation:lastRunAt,lastStatus=success',
        'releaseAutomation',
        'resetAttempts',
        'notify:onSuccess:🤖 Golden',
        'updateAutomation:nextRunAt=set',
        'getRun',
    ]);
    assert.ok(!trace.includes('markRunning'), 'a schedule run was claimed by the scheduler, not here');
});

test('a primary cron with no future match disables the schedule and says so', async () => {
    const def = automation([SET], { triggerType: 'schedule', scheduleCron: '0 0 31 2 *', scheduleTz: 'Europe/Amsterdam' });
    await executeAutomation(def, { triggerKind: 'schedule' });
    assert.deepStrictEqual(trace.slice(-3), [
        'updateAutomation:isActive=false,nextRunAt=null',
        'notify:onError:automation.notify.schedule_disabled',
        'getRun',
    ]);
});

test('a secondary schedule advances its own row before the marker is released, never the primary', async () => {
    const def = automation([SET], { triggerType: 'schedule', scheduleCron: '0 9 * * *', scheduleTz: 'Europe/Amsterdam' });
    await executeAutomation(def, { triggerKind: 'schedule', schedule: { id: 'sch-2', cron: '0 0 31 2 *', tz: 'Europe/Amsterdam' } });
    const tail = trace.slice(trace.indexOf('updateAutomation:lastRunAt,lastStatus=success'));
    assert.deepStrictEqual(tail, [
        'updateAutomation:lastRunAt,lastStatus=success',
        'advanceSchedule:sch-2:none:success',
        'notify:onError:automation.notify.schedule_idle',
        'releaseAutomation',
        'resetAttempts',
        'notify:onSuccess:🤖 Golden',
        'getRun',
    ]);
});

test('a resumed leg seeds its vault from the parent and records the resume boundary before anything runs', async () => {
    const created = [];
    const def = automation([{ id: 'ap', type: 'approval', prompt: 'ok?' }, SET]);
    const row = await executeAutomation(def, {
        triggerKind: 'manual', parentRunId: 'run-0', rootRunId: 'run-0',
        skipUntilStepId: 'ap', replayState: { ap: { output: { approved: true } } },
        onRunCreated: (r) => { created.push(`${r.id}@${trace.length}`); },
    });
    assert.strictEqual(row.status, 'success');
    assert.deepStrictEqual(created, ['run-1@1'], 'onRunCreated fires right after the row exists, before the marker');
    assert.deepStrictEqual(trace.slice(0, 7), [
        'createRun:manual:live:trig:false',
        'markRunning',
        'updateRun:running:startedAt,status',
        'emit:run.started',
        'getRunTokenMap',
        'recordRunStep:ap:success:1',
        'emit:step.started',
    ]);
});
