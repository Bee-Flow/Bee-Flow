/**
 * playbookView.ts held to the web's playbookView.js and recipes.js on the
 * same phases: the status chip's words, the phase words and tiles, the one
 * fact per phase, the error wording and the durations. The web's imports are
 * stubbed with its own phase machine and the phone's elapsed clock (itself
 * pinned to the web's by elapsed.test.ts).
 *
 * When this fails, the web side changed: update playbookView.ts to match.
 */

import fs from 'node:fs';
import path from 'node:path';

import { formatElapsed } from '@/shared/lib/elapsed';
import { loadWebModule } from '@/shared/testing/webModule';

import {
    PHASE_LABEL_KEYS,
    PHASE_VISUAL,
    errorText,
    phaseDuration,
    phaseFact,
    phaseKind,
    phaseLabel,
    phaseLinks,
    playbookStatus,
    totalElapsed,
} from './playbookView';
import type { Phase } from './types';

const DIR = path.resolve(__dirname, '../../../../../agent-hub/src/components/admin/Studio/Playbooks');
const describeIfWeb = fs.existsSync(path.join(DIR, 'playbookView.js')) ? describe : describe.skip;

type Fn = (...args: unknown[]) => unknown;
const t = (_k: string, en: string, p: Record<string, unknown> = {}) => en.replace(/\{(\w+)\}/g, (m, n: string) => (n in p ? String(p[n]) : m));

function loadWeb() {
    const machine = loadWebModule<Record<string, Fn>>(path.join(DIR, 'phaseMachine.js'));
    const view = loadWebModule<Record<string, Fn>>(path.join(DIR, 'playbookView.js'), {
        kindOf: machine.kindOf,
        getItem: () => null,
        formatElapsed,
    });
    const recipes = loadWebModule<Record<string, unknown>>(path.join(DIR, 'recipes.js'));
    return { view, recipes };
}

const p = (key: string, over: Partial<Phase> = {}): Phase => ({
    key, kind: null, label: null, status: 'pending', attempt: 0, brief: null, artifacts: {}, summary: null, error: null, startedAt: null, finishedAt: null, requires: null, ...over,
});

const PHASES: Phase[] = [
    p('table', { artifacts: { datatableName: 'Invoices', rowCount: 32 } }),
    p('table', { artifacts: { datatableName: 'Invoices', rowCount: '32' } }),
    p('table'),
    p('routine', { artifacts: { automationTitle: 'Read invoices' } }),
    p('fill', { artifacts: { rowCount: 12 } }),
    p('d1', { kind: 'design', artifacts: { designName: 'Board', screenCount: 3 } }),
    p('d2', { kind: 'design', artifacts: { designName: 'Board' } }),
    p('app', { artifacts: { appName: 'Tracker' } }),
    p('approvals', { artifacts: { appName: 'Tracker' } }),
    p('access', { kind: 'access', artifacts: { accessApplied: true } }),
    p('c1', { kind: 'compliance', artifacts: { findings: [] } }),
    p('c2', { kind: 'compliance', artifacts: { findings: [{}, {}] } }),
    p('custom', { kind: 'fill', label: 'Load the first rows' }),
    p('mystery', { kind: 'weird' }),
];

const TIMED: Partial<Phase>[] = [
    {},
    { startedAt: '2026-09-24T10:00:00Z', finishedAt: '2026-09-24T10:03:05Z' },
    { startedAt: '2026-09-24T10:00:00Z', finishedAt: '2026-09-24T09:00:00Z' },
    { startedAt: '2026-09-24T10:00:00Z' },
];

describeIfWeb('playbookView matches the web', () => {
    it('shares the phase words and tiles', () => {
        const { recipes } = loadWeb();
        expect(PHASE_LABEL_KEYS).toEqual(recipes.PHASE_LABEL_KEYS);
        expect(PHASE_VISUAL).toEqual(recipes.PHASE_VISUAL);
        for (const phase of PHASES) {
            expect({ key: phase.key, label: phaseLabel(phase, t) }).toEqual({ key: phase.key, label: (recipes.phaseLabel as Fn)(phase, t) });
            expect({ key: phase.key, kind: phaseKind(phase) }).toEqual({ key: phase.key, kind: (recipes.phaseKind as Fn)(phase) });
        }
    });

    it('says the same fact, error and status', () => {
        const { view } = loadWeb();
        for (const phase of PHASES) expect({ key: phase.key, fact: phaseFact(phase, t) }).toEqual({ key: phase.key, fact: view.phaseFact!(phase, t) });
        for (const code of [null, '', 'aborted', 'interrupted', 'artifacts_missing', 'The server said no.']) expect(errorText(code, t)).toBe(view.errorText!(code, t));
        const lists = [[], [p('a', { status: 'failed' })], [p('a', { status: 'running' })], [p('a', { status: 'awaiting' })], [p('a', { status: 'done' })]];
        for (const status of ['active', 'done', 'stopped'] as const) {
            for (const phases of lists) {
                const theirs = view.playbookStatusLabel!({ status, phases }, t) as { text: string };
                expect({ status, text: playbookStatus({ status, phases }, t).text }).toEqual({ status, text: theirs.text });
            }
        }
    });

    it('measures the same durations', () => {
        const { view } = loadWeb();
        for (const time of TIMED) expect(phaseDuration(p('x', time))).toBe(view.phaseDuration!(p('x', time)));
        const phases = TIMED.map((time, i) => p(`x${i}`, time));
        expect(totalElapsed(phases)).toBe(view.totalElapsed!({ phases }));
        expect(totalElapsed([])).toBe(view.totalElapsed!({ phases: [] }));
    });
});

describe('phaseLinks', () => {
    it('opens every artifact on a native screen, the table included', () => {
        const phase = p('fill', { kind: 'fill', artifacts: { datatableId: 't 1', automationId: 'a1', appId: 'x1' } });
        expect(phaseLinks(phase)).toEqual([
            { kind: 'datatable', href: '/datatables/t%201' },
            { kind: 'automation', href: '/automations/a1' },
            { kind: 'app', href: '/apps/x1' },
        ]);
    });
});
