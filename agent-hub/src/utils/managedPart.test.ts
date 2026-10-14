import { describe, it, expect } from 'vitest';
import {
    declaresManaged, devTarget, fromError, hrefOf, isManaged, managedOf, parseManaged, pipelineTarget, stageSettingsTarget,
} from './managedPart';

const PART = {
    solutionId: 's1', solutionName: 'Intake', stage: 'prd', releaseSeq: 7, devRef: { kind: 'automation', id: 'dev-a1' },
};

describe('managedOf: the `managed` field the server puts on every part GET', () => {
    it('reads it beside the part (automation, app, webpage, KB, agent GET answers)', () => {
        expect(managedOf({ automation: { id: 'a1' }, managed: PART })).toEqual(PART);
        expect(managedOf({ app: { id: 'x' }, readOnly: false, managed: PART })).toEqual(PART);
        expect(managedOf({ sources: [], managed: PART })).toEqual(PART);
    });

    it('reads it inside the part (a skill or agent row, a document, a datatable)', () => {
        expect(managedOf({ id: 'k1', name: 'Skill', managed: PART })).toEqual(PART);
        expect(managedOf({ document: { id: 'd1', managed: PART }, people: {} })).toEqual(PART);
        expect(managedOf({ datatable: { id: 't1', managed: PART } })).toEqual(PART);
    });

    it('is null for an unmanaged part, for a payload that says nothing and for junk', () => {
        expect(managedOf({ automation: { id: 'a1' }, managed: null })).toBeNull();
        expect(managedOf({ automation: { id: 'a1' } })).toBeNull();
        expect(managedOf(null)).toBeNull();
        expect(managedOf('managed')).toBeNull();
        expect(managedOf({ managed: { solutionId: 's1', stage: 'dev' } })).toBeNull();
        expect(managedOf({ managed: { stage: 'prd' } })).toBeNull();
    });

    it('keeps what is missing as null instead of inventing it', () => {
        expect(parseManaged({ solutionId: 's1', stage: 'uat' })).toEqual({
            solutionId: 's1', solutionName: null, stage: 'uat', releaseSeq: null, devRef: null,
        });
        expect(parseManaged({ solutionId: 's1', stage: 'uat', releaseSeq: 'x', devRef: { kind: 'app' } })?.devRef).toBeNull();
    });

    it('isManaged and declaresManaged tell "not managed" from "did not say"', () => {
        expect(isManaged({ managed: PART })).toBe(true);
        expect(isManaged({ managed: null })).toBe(false);
        expect(declaresManaged({ managed: null })).toBe(true);
        expect(declaresManaged({ automation: { managed: null } })).toBe(true);
        expect(declaresManaged({ automation: { id: 'a1' } })).toBe(false);
        expect(declaresManaged(undefined)).toBe(false);
    });
});

describe('fromError: the two 409 refusals as banner info', () => {
    it('maps a managed_part body, with the stage the terminal handler passes through', () => {
        const info = fromError({
            error: 'This part is managed by a Solution stage. Change it in Dev and deploy.',
            code: 'managed_part',
            correlationId: 'c1',
            details: { solutionId: 's1', stage: 'prd' },
        });
        expect(info).toEqual({
            reason: 'managed',
            code: 'managed_part',
            message: 'This part is managed by a Solution stage. Change it in Dev and deploy.',
            managed: { solutionId: 's1', solutionName: null, stage: 'prd', releaseSeq: null, devRef: null },
        });
    });

    it('maps managed_part_not_deployed, which names no Solution', () => {
        expect(fromError({ error: 'Not deployed yet.', code: 'managed_part_not_deployed', details: { automationId: 'a1' } })).toEqual({
            reason: 'not_deployed', code: 'managed_part_not_deployed', message: 'Not deployed yet.', managed: null,
        });
        expect(fromError({ error: 'No snapshot.', code: 'managed_part_not_deployed' })?.reason).toBe('not_deployed');
    });

    it('reads an Error thrown by a client wrapper (code on the error, body on .body)', () => {
        const err = Object.assign(new Error('refused'), {
            status: 409, code: 'managed_part', body: { error: 'refused', code: 'managed_part', details: { solutionId: 's9', stage: 'uat' } },
        });
        expect(fromError(err)?.managed?.solutionId).toBe('s9');
        const bare = Object.assign(new Error('refused'), { status: 409, code: 'managed_part' });
        expect(fromError(bare)).toMatchObject({ reason: 'managed', message: 'refused', managed: null });
    });

    it('is null for any other body, including other 409s', () => {
        expect(fromError({ error: 'Version changed', code: 'version_changed' })).toBeNull();
        expect(fromError({ error: 'boom' })).toBeNull();
        expect(fromError(null)).toBeNull();
        expect(fromError('managed_part')).toBeNull();
    });
});

describe('links', () => {
    it('Open in Dev goes to the Dev part the server named', () => {
        expect(devTarget(PART as never)).toBe('studio/automations/dev-a1');
        expect(devTarget({ ...PART, devRef: { kind: 'knowledge_base', id: 'kb 1' } } as never)).toBe('studio/knowledge/kb%201');
    });

    it('falls back to the Solution when the Dev part is unknown or of a kind with no screen', () => {
        expect(devTarget({ ...PART, devRef: null } as never)).toBe('studio/solutions/s1');
        expect(devTarget({ ...PART, devRef: { kind: 'mystery', id: 'x' } } as never)).toBe('studio/solutions/s1');
    });

    it('Stage settings and the pipeline stay inside the Solution', () => {
        expect(stageSettingsTarget(PART as never)).toBe('studio/solutions/s1?stage=prd&tab=settings');
        expect(pipelineTarget('s1')).toBe('studio/solutions/s1?tab=pipeline');
        expect(hrefOf('studio/solutions/s1')).toBe('/app/studio/solutions/s1');
    });
});
