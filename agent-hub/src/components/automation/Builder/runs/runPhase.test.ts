// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { RUN_PHASES, RUN_PHASE_LABELS, runPhase, type RunPhaseName } from './runPhase';
import EN_DEFAULTS from '@/i18n/en-defaults';

// The same table runs against the phone's mirror (mobile/src/features/runs/runPhase.lockstep.test.ts).
const STATUS_TABLE: Array<[string, RunPhaseName, boolean]> = [
    ['queued', 'running', false],
    ['running', 'running', false],
    ['awaiting_form', 'paused_form', false],
    ['awaiting_approval', 'paused_approval', false],
    ['awaiting_confirm', 'paused_approval', false],
    ['success', 'done', true],
    ['handled_error', 'done', true],
    ['error', 'failed', true],
    ['failed', 'failed', true],
    ['cancelled', 'cancelled', true],
    ['', 'running', false],
    ['something_new', 'running', false],
    ['constructor', 'running', false],
];

const PROFILE_TABLE: Array<[string, Parameters<typeof runPhase>[0], { isTest: boolean; isDry: boolean }]> = [
    ['production profile', { profile: { kind: 'production' } }, { isTest: false, isDry: false }],
    ['test profile', { profile: { kind: 'test' } }, { isTest: true, isDry: false }],
    ['dry profile', { profile: { kind: 'dry' } }, { isTest: true, isDry: true }],
    ['profile wins over a legacy dry mode', { profile: { kind: 'production' }, mode: 'dry_run', isTest: true }, { isTest: false, isDry: false }],
    ['legacy live run', { mode: 'live' }, { isTest: false, isDry: false }],
    ['legacy test run', { mode: 'live', isTest: true }, { isTest: true, isDry: false }],
    ['legacy dry run', { mode: 'dry_run' }, { isTest: true, isDry: true }],
    ['legacy dry run with isTest false', { mode: 'dry_run', isTest: false }, { isTest: true, isDry: true }],
    ['unknown profile kind falls back to mode', { profile: { kind: 'uat' }, mode: 'dry_run' }, { isTest: true, isDry: true }],
    ['empty profile falls back to isTest', { profile: {}, isTest: true }, { isTest: true, isDry: false }],
    ['no facts at all', {}, { isTest: false, isDry: false }],
    ['null run', null, { isTest: false, isDry: false }],
];

describe('runPhase', () => {
    it.each(STATUS_TABLE)('status %s reads as %s (terminal %s)', (status, phase, terminal) => {
        expect(runPhase({ status })).toEqual({ phase, terminal, isTest: false, isDry: false });
    });

    it('reads a status in any case and with stray spaces', () => {
        expect(runPhase({ status: ' AWAITING_APPROVAL ' }).phase).toBe('paused_approval');
        expect(runPhase({ status: null }).phase).toBe('running');
    });

    it.each(PROFILE_TABLE)('%s', (_name, run, testness) => {
        expect(runPhase(run)).toMatchObject(testness);
    });

    it('crosses every status with every profile kind', () => {
        for (const [status, phase, terminal] of STATUS_TABLE) {
            for (const kind of ['production', 'test', 'dry'] as const) {
                const got = runPhase({ status, profile: { kind } });
                expect(got.phase).toBe(phase);
                expect(got.terminal).toBe(terminal);
                expect(got.isTest).toBe(kind !== 'production');
                expect(got.isDry).toBe(kind === 'dry');
            }
        }
    });

    it('names every phase with a key the dictionary has', () => {
        for (const phase of RUN_PHASES) {
            const { labelKey, label } = RUN_PHASE_LABELS[phase];
            expect((EN_DEFAULTS as Record<string, string>)[labelKey]).toBe(label);
        }
    });
});
