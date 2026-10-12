import { describe, expect, it } from 'vitest';
import {
    ackKey, buildColumns, effectiveStage, errorKind, followUp, isNoop, outcomeOf, phaseOf, pillStatusOf,
    readStateOf, rowActionOf, submitBlocks,
} from './pipelineModel';
import { operatedStagesOf, stageFromSearch, stripOf } from './stagesApi';
import type { DeploymentSummary, Pipeline, PipelineStage, Plan } from './stagesApi';

/**
 * The state table of the pipeline: which column is in which state, and the ONE
 * action each offers. Pure, so this is where the table can be written out.
 */

const dep = (over: Partial<DeploymentSummary> = {}): DeploymentSummary => ({ id: 'd1', status: 'succeeded', kind: 'deploy', releaseSeq: 3, ...over });

const row = (stage: 'uat' | 'prd', over: Partial<PipelineStage> = {}): PipelineStage => ({
    stage, projectId: `p_${stage}`, currentRelease: null, lastDeployment: null, pending: null,
    bindingsPending: false, enabled: true, role: 'owner', ...over,
});

const pipe = (over: Partial<Pipeline> = {}): Pipeline => ({
    dev: { aheadOf: null, checks: { blocked: false, count: 0 } },
    stages: [row('uat'), row('prd')],
    releases: [],
    ...over,
});

const rel = (seq: number, blocked = false) => ({ id: `rel_${seq}`, seq, gate: { blocked } });
const col = (p: Pipeline, stage: 'dev' | 'uat' | 'prd', owner = true) => buildColumns(p, { owner }).find(c => c.stage === stage)!;

describe('the Dev column', () => {
    it('no stages: the primary action is "Set up stages"', () => {
        const c = col(pipe({ stages: [] }), 'dev');
        expect(c.state).toBe('no_stages');
        expect(c.primary).toEqual({ id: 'setup' });
    });

    it('a non-owner is offered nothing', () => {
        expect(col(pipe({ stages: [] }), 'dev', false).primary).toBeNull();
        expect(col(pipe({ dev: { aheadOf: { seq: 1, changed: 2, added: 0, removed: 0 }, checks: { blocked: false, count: 0 } }, releases: [rel(1)] }), 'dev', false).primary).toBeNull();
    });

    it('no release yet: release and deploy the first one', () => {
        const c = col(pipe(), 'dev');
        expect(c.state).toBe('no_release');
        expect(c.primary).toMatchObject({ id: 'release_deploy_uat', stage: 'uat' });
    });

    it('ahead of the last release: "Release & deploy to UAT" with the counts', () => {
        const c = col(pipe({ dev: { aheadOf: { seq: 6, changed: 2, added: 1, removed: 0 }, checks: { blocked: false, count: 0 } }, releases: [rel(6)] }), 'dev');
        expect(c.state).toBe('ahead');
        expect(c.ahead).toEqual({ changed: 2, added: 1, removed: 0 });
        expect(c.primary?.id).toBe('release_deploy_uat');
    });

    it('blocked checks: no action, the count is kept', () => {
        const c = col(pipe({ dev: { aheadOf: { seq: 1, changed: 1, added: 0, removed: 0 }, checks: { blocked: true, count: 3 } }, releases: [rel(1)] }), 'dev');
        expect(c.state).toBe('blocked');
        expect(c.primary).toBeNull();
        expect(c.blockedCount).toBe(3);
    });

    it('in sync when nothing is ahead; and no action while UAT is busy', () => {
        expect(col(pipe({ releases: [rel(2)] }), 'dev').state).toBe('in_sync');
        const busy = pipe({
            dev: { aheadOf: { seq: 2, changed: 1, added: 0, removed: 0 }, checks: { blocked: false, count: 0 } },
            stages: [row('uat', { lastDeployment: dep({ status: 'preparing' }) }), row('prd')], releases: [rel(2)],
        });
        expect(col(busy, 'dev').primary).toBeNull();
    });

    it('a stage-only operator has no Dev column at all', () => {
        const cols = buildColumns(pipe({ dev: null, stages: [row('uat')], releases: null }), { owner: false });
        expect(cols.map(c => c.stage)).toEqual(['uat']);
    });
});

describe('the UAT column', () => {
    it('empty with a release waiting: deploy the newest clean one', () => {
        const c = col(pipe({ releases: [rel(3), rel(4, true), rel(2)] }), 'uat');
        expect(c.state).toBe('empty');
        expect(c.primary).toMatchObject({ id: 'deploy', stage: 'uat', releaseId: 'rel_3', releaseSeq: 3 });
    });

    it('a newer release than the one running: behind', () => {
        const c = col(pipe({ stages: [row('uat', { currentRelease: { id: 'rel_2', seq: 2 } }), row('prd')], releases: [rel(3), rel(2)] }), 'uat');
        expect(c.state).toBe('behind');
        expect(c.primary?.releaseSeq).toBe(3);
    });

    it('up to date: nothing to do, unless settings changed', () => {
        const p = pipe({ stages: [row('uat', { currentRelease: { id: 'rel_3', seq: 3 } }), row('prd')], releases: [rel(3)] });
        expect(col(p, 'uat').state).toBe('current');
        expect(col(p, 'uat').primary).toBeNull();
        const pending = pipe({ stages: [row('uat', { currentRelease: { id: 'rel_3', seq: 3 }, bindingsPending: true }), row('prd')], releases: [rel(3)] });
        expect(col(pending, 'uat').primary).toMatchObject({ id: 'apply_settings', deployKind: 'redeploy', releaseSeq: 3 });
    });

    it('a running deployment shows progress and offers nothing', () => {
        const p = pipe({ stages: [row('uat', { lastDeployment: dep({ status: 'committing' }) }), row('prd')], releases: [rel(3)] });
        const c = col(p, 'uat');
        expect(c.state).toBe('running');
        expect(c.primary).toBeNull();
    });

    it('a failed last deployment keeps the action but flags attention', () => {
        const p = pipe({ stages: [row('uat', { lastDeployment: dep({ status: 'failed' }) }), row('prd')], releases: [rel(3)] });
        const c = col(p, 'uat');
        expect(c.attention).toBe('failed');
        expect(c.primary?.id).toBe('deploy');
    });

    it('warnings offer a converge retry', () => {
        const p = pipe({ stages: [row('uat', { currentRelease: { id: 'rel_3', seq: 3 }, lastDeployment: dep({ status: 'succeeded_with_warnings', id: 'dw' }) }), row('prd')], releases: [rel(3)] });
        const c = col(p, 'uat');
        expect(c.attention).toBe('warnings');
        expect(c.secondary).toContainEqual({ id: 'retry_converge', stage: 'uat', deploymentId: 'dw' });
    });

    it('a stage that does not exist is "not set up"', () => {
        expect(col(pipe({ stages: [row('prd')] }), 'uat').state).toBe('not_set_up');
    });
});

describe('the Production column', () => {
    const uatAt = (seq: number) => row('uat', { currentRelease: { id: `rel_${seq}`, seq }, lastDeployment: dep({ releaseSeq: seq }) });

    it('waits while UAT has nothing', () => {
        const c = col(pipe({ releases: [rel(3)] }), 'prd');
        expect(c.state).toBe('waiting');
        expect(c.primary).toBeNull();
    });

    it('nothing in Production, UAT runs R7: promote R7', () => {
        const c = col(pipe({ stages: [uatAt(7), row('prd')], releases: [rel(7)] }), 'prd');
        expect(c.state).toBe('empty');
        expect(c.primary).toMatchObject({ id: 'promote', stage: 'prd', releaseSeq: 7, releaseId: 'rel_7' });
    });

    it('with the gate on the action is "request approval"', () => {
        const c = col(pipe({ stages: [uatAt(7), row('prd', { requiresApproval: true })], releases: [rel(7)] }), 'prd');
        expect(c.primary?.id).toBe('request_approval');
    });

    it('UAT ahead of Production: promote, and roll back to the release before', () => {
        const prd = row('prd', { currentRelease: { id: 'rel_5', seq: 5 }, previousRelease: { id: 'rel_4', seq: 4 } });
        const c = col(pipe({ stages: [uatAt(7), prd], releases: [rel(7), rel(5), rel(4)] }), 'prd');
        expect(c.state).toBe('promote');
        expect(c.primary).toMatchObject({ id: 'promote', releaseSeq: 7 });
        expect(c.secondary).toContainEqual(expect.objectContaining({ id: 'rollback', deployKind: 'rollback', releaseSeq: 4 }));
    });

    it('rolls back by id when the server sends no number (seq: null), taking it from the releases', () => {
        const prd = row('prd', { currentRelease: { id: 'rel_5', seq: 5 }, previousRelease: { id: 'rel_4', seq: null } });
        const c = col(pipe({ stages: [uatAt(7), prd], releases: [rel(7), rel(5), rel(4)] }), 'prd');
        expect(c.secondary).toContainEqual(expect.objectContaining({ id: 'rollback', releaseId: 'rel_4', releaseSeq: 4 }));
    });

    it('still offers the rollback when the target is in no release list', () => {
        const prd = row('prd', { currentRelease: { id: 'rel_5', seq: 5 }, previousRelease: { id: 'rel_4', seq: null } });
        const c = col(pipe({ stages: [uatAt(7), prd], releases: null }), 'prd');
        expect(c.secondary).toContainEqual(expect.objectContaining({ id: 'rollback', releaseId: 'rel_4', releaseSeq: null }));
    });

    it('does not promote while UAT is mid-deployment or failed', () => {
        const busy = row('uat', { currentRelease: { id: 'rel_7', seq: 7 }, lastDeployment: dep({ status: 'preparing' }) });
        expect(col(pipe({ stages: [busy, row('prd')], releases: [rel(7)] }), 'prd').primary).toBeNull();
        const failed = row('uat', { currentRelease: { id: 'rel_7', seq: 7 }, lastDeployment: dep({ status: 'failed' }) });
        expect(col(pipe({ stages: [failed, row('prd')], releases: [rel(7)] }), 'prd').primary).toBeNull();
    });

    it('waiting for approval: no deploy action, only a cancel for the owner', () => {
        const pending = dep({ status: 'awaiting_approval', id: 'dp' });
        const p = pipe({ stages: [uatAt(7), row('prd', { pending })], releases: [rel(7)] });
        const c = col(p, 'prd');
        expect(c.state).toBe('awaiting_approval');
        expect(c.primary).toBeNull();
        expect(c.secondary).toEqual([{ id: 'cancel_request', stage: 'prd', deploymentId: 'dp' }]);
        expect(col(p, 'prd', false).secondary).toEqual([]);
    });

    it('current when both run the same release', () => {
        const prd = row('prd', { currentRelease: { id: 'rel_7', seq: 7 } });
        const c = col(pipe({ stages: [uatAt(7), prd], releases: [rel(7)] }), 'prd');
        expect(c.state).toBe('current');
        expect(c.primary).toBeNull();
    });
});

describe('reading and errors', () => {
    it('a failed read is never "no stages"', () => {
        expect(readStateOf({ ok: false, status: 500 })).toBe('unreadable');
        expect(readStateOf({ ok: false, status: 0, code: 'network' })).toBe('unreadable');
        expect(readStateOf({ ok: false, status: 404 })).toBe('not_a_solution');
        expect(readStateOf({ ok: false, status: 402 })).toBe('no_licence');
        expect(readStateOf({ ok: false, status: 403, code: 'feature_not_licensed' })).toBe('no_licence');
        expect(readStateOf({ ok: false, status: 403 })).toBe('forbidden');
        expect(readStateOf({ ok: true, status: 200 })).toBe('ok');
        expect(readStateOf(null)).toBe('unreadable');
    });

    it('names the 409 codes', () => {
        for (const code of ['plan_stale', 'acknowledgement_missing', 'stage_busy', 'approval_pending', 'release_not_in_uat', 'release_blocked', 'rollback_target_invalid', 'plan_blocked', 'solution_owner_only', 'run_as_mismatch', 'stage_not_found', 'stages_need_org', 'capture_raced']) {
            expect(errorKind({ status: 409, code })).toBe(code);
        }
        expect(errorKind({ status: 409, code: 'plan_stale_after_approval' })).toBe('plan_stale');
        expect(errorKind({ status: 0, code: 'network' })).toBe('network');
        expect(errorKind({ status: 402, code: null })).toBe('no_licence');
        expect(errorKind({ status: 403, code: null })).toBe('forbidden');
        expect(errorKind({ status: 500, code: 'whatever' })).toBe('unknown');
    });

    it('202 settings and remove deployments are tracked like a deploy', () => {
        expect(followUp({ deployment: { id: 'd9', status: 'awaiting_approval', kind: 'settings' } }))
            .toEqual({ track: true, awaitingApproval: true, deploymentId: 'd9', kind: 'settings' });
        expect(followUp({ deployment: { id: 'd8', status: 'queued', kind: 'remove' } }))
            .toEqual({ track: true, awaitingApproval: false, deploymentId: 'd8', kind: 'remove' });
        expect(followUp({ deployment: { id: 'd7', status: 'succeeded', kind: 'settings' } }).track).toBe(false);
        expect(followUp(null).track).toBe(false);
    });
});

describe('statuses', () => {
    it('maps statuses to phases and pill words', () => {
        expect(phaseOf('queued')).toBe('preparing');
        expect(phaseOf('committing')).toBe('switching');
        expect(phaseOf('converging')).toBe('finishing');
        expect(phaseOf('succeeded_with_warnings')).toBe('done');
        expect(phaseOf('awaiting_approval')).toBe('awaiting');
        expect(phaseOf('failed')).toBe('stopped');
        expect(pillStatusOf('succeeded')).toBe('published');
        expect(pillStatusOf('failed')).toBe('stale');
        expect(pillStatusOf('cancelled')).toBe('paused');
        expect(pillStatusOf('preparing')).toBe('draft');
    });

    it('offers retry and cancel where they make sense', () => {
        expect(rowActionOf({ status: 'failed', kind: 'deploy' })).toBe('retry');
        expect(rowActionOf({ status: 'failed', kind: 'remove' })).toBeNull();
        expect(rowActionOf({ status: 'succeeded_with_warnings', kind: 'deploy' })).toBe('retry');
        expect(rowActionOf({ status: 'awaiting_approval', kind: 'deploy' })).toBe('cancel');
        expect(rowActionOf({ status: 'succeeded', kind: 'deploy' })).toBeNull();
    });
});

const plan = (over: Partial<Plan> = {}): Plan => ({
    kind: 'deploy', stage: 'prd', release: { id: 'rel_7', seq: 7 }, from: { releaseId: 'rel_5', seq: 5 },
    parts: [], data: [], referenceRows: [], knowledge: [],
    bindings: { missing: [], orphaned: [] }, variables: { missing: [], invalid: [], steeringPending: [] },
    readiness: [], blocking: [], gates: { approval: 'not_required' }, differsFromUat: [],
    acknowledgementsRequired: [], planHash: 'sha256:x', ...over,
});

describe('the deploy dialog rules', () => {
    const base = { acked: new Set<string>(), typedName: '', solutionName: 'Onboarding', stage: 'uat' as const };

    it('is open for a clean UAT plan', () => {
        expect(submitBlocks({ ...base, plan: plan({ stage: 'uat' }) })).toEqual([]);
    });

    it('an unticked acknowledgement blocks, a ticked one does not', () => {
        const a = { code: 'kb.personal_data', ref: 'kb_1' };
        const p = plan({ stage: 'uat', acknowledgementsRequired: [a] });
        expect(submitBlocks({ ...base, plan: p })).toEqual(['ack_missing']);
        expect(submitBlocks({ ...base, plan: p, acked: new Set([ackKey(a)]) })).toEqual([]);
    });

    it('production wants the Solution name, typed', () => {
        expect(submitBlocks({ ...base, stage: 'prd', plan: plan() })).toEqual(['name_mismatch']);
        expect(submitBlocks({ ...base, stage: 'prd', plan: plan(), typedName: ' Onboarding ' })).toEqual([]);
        expect(submitBlocks({ ...base, stage: 'prd', plan: plan(), typedName: 'onboarding' })).toEqual(['name_mismatch']);
    });

    it('blocking findings, missing settings and variables keep it shut', () => {
        const p = plan({
            stage: 'uat', blocking: [{ code: 'app.data_model_not_additive' }],
            bindings: { missing: [{ slot: 'connection:cn_1' }], orphaned: [] },
            variables: { missing: ['region'], invalid: ['limit'], steeringPending: [] },
        });
        expect(submitBlocks({ ...base, plan: p })).toEqual(['blocking', 'bindings_missing', 'variables_missing', 'variables_invalid']);
        expect(submitBlocks({ ...base, plan: null })).toEqual(['no_plan']);
    });

    it('names the outcome on the button', () => {
        expect(outcomeOf(plan({ stage: 'uat' }), 'uat', 'deploy')).toBe('deploy_uat');
        expect(outcomeOf(plan(), 'prd', 'deploy')).toBe('promote');
        expect(outcomeOf(plan({ gates: { approval: 'required' } }), 'prd', 'deploy')).toBe('request_approval');
        expect(outcomeOf(plan(), 'prd', 'rollback')).toBe('rollback');
        expect(outcomeOf(plan({ from: { releaseId: 'rel_7', seq: 7 } }), 'prd', 'redeploy')).toBe('apply_settings');
    });

    it('knows a plan that changes nothing', () => {
        expect(isNoop(plan({ parts: [{ ref: 'a', kind: 'app', action: 'unchanged' }] }))).toBe(true);
        expect(isNoop(plan({ parts: [{ ref: 'a', kind: 'app', action: 'replace' }] }))).toBe(false);
        expect(isNoop(plan({ referenceRows: [{ ref: 'dt', insert: 1, update: 0, delete: 0 }] }))).toBe(false);
    });
});

describe('what /summary sends', () => {
    it('reads the strip, UAT before PRD, and never paints an undeployed stage green', () => {
        const strip = stripOf([
            { stage: 'prd', projectId: 'p2', currentReleaseSeq: 6, lastDeploymentStatus: 'succeeded' },
            { stage: 'uat', projectId: 'p1', currentReleaseSeq: 7, lastDeploymentStatus: null },
            { stage: 'bogus' }, null,
        ]);
        expect(strip.map(s => [s.stage, s.seq, s.tone])).toEqual([['uat', 7, 'none'], ['prd', 6, 'ok']]);
        expect(stripOf([{ stage: 'uat', lastDeploymentStatus: 'failed' }])[0].tone).toBe('error');
        expect(stripOf([{ stage: 'uat', lastDeploymentStatus: 'preparing' }])[0].tone).toBe('busy');
        expect(stripOf([{ stage: 'prd', lastDeploymentStatus: 'succeeded', pending: { id: 'd' } }])[0].tone).toBe('warning');
        expect(stripOf(undefined)).toEqual([]);
    });

    it('reads operated stages and drops malformed rows', () => {
        expect(operatedStagesOf([
            { solutionId: 's1', solutionName: 'Quotes', stage: 'uat', projectId: 'p1', role: 'editor' },
            { solutionId: 's2', stage: 'dev', projectId: 'p2' }, 'x', null,
        ])).toEqual([{ solutionId: 's1', solutionName: 'Quotes', stage: 'uat', projectId: 'p1', role: 'editor' }]);
        expect(operatedStagesOf(null)).toEqual([]);
    });

    it('reads ?stage=', () => {
        expect(stageFromSearch('?stage=uat')).toBe('uat');
        expect(stageFromSearch('?stage=prd&tab=settings')).toBe('prd');
        expect(stageFromSearch('?stage=nonsense')).toBe('dev');
        expect(stageFromSearch('')).toBe('dev');
        expect(stageFromSearch(null)).toBe('dev');
    });
});

describe('which stage is shown', () => {
    const stages = [{ stage: 'uat' as const }];
    it('honours a listed stage', () => {
        expect(effectiveStage('uat', { status: 'ok', stages, hasDev: true })).toBe('uat');
    });
    it('falls back to Dev for a stage the pipeline does not list', () => {
        expect(effectiveStage('prd', { status: 'ok', stages, hasDev: true })).toBe('dev');
    });
    it('a caller without a Dev role gets the first stage they hold', () => {
        expect(effectiveStage('dev', { status: 'ok', stages, hasDev: false })).toBe('uat');
        expect(effectiveStage('prd', { status: 'ok', stages, hasDev: false })).toBe('uat');
    });
    it('a failed read is Dev, and nothing is decided while it is still loading', () => {
        expect(effectiveStage('uat', { status: 'error', stages: [], hasDev: false })).toBe('dev');
        expect(effectiveStage('uat', { status: 'loading', stages: [], hasDev: false })).toBe('uat');
    });
});
