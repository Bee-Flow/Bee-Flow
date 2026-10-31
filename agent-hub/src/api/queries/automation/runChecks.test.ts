// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    goldenPollMs, parseChange, parseCompare, parseFileSummary, parseGolden, parseGoldenList,
    parseScenario, parseScenarioDetail, parseScenarioList,
} from './runChecks';

describe('parseCompare', () => {
    it('reads a full answer', () => {
        const out = parseCompare({
            a: { runId: 'r1', status: 'success', mode: 'live', version: 3, triggerKind: 'form', startedAt: '2026-10-01T10:00:00Z' },
            b: { runId: 'r2', status: 'success', mode: 'dry_run', version: 4, triggerKind: 'dry_run', startedAt: null },
            verdict: 'soft',
            summary: { same: 4, changed: 0, soft: 1, onlyA: 0, onlyB: 0, notComparable: 2 },
            steps: [{
                key: '/s1#', stepId: 's1', stepType: 'ai_step', parentStepId: null,
                a: { present: true, status: 'success' }, b: { present: true, status: 'success' },
                verdict: 'soft', softReason: 'ai', kind: 'json', changesTruncated: true,
                changes: [{ path: 'answer', change: 'changed', before: '"a"', after: '"b"' }],
            }],
            truncated: false,
        });
        expect(out.verdict).toBe('soft');
        expect(out.summary.notComparable).toBe(2);
        expect(out.b.mode).toBe('dry_run');
        expect(out.steps[0]).toMatchObject({ stepId: 's1', softReason: 'ai', changesTruncated: true, files: [] });
        expect(out.steps[0].changes[0]).toEqual({ path: 'answer', change: 'changed', before: '"a"', after: '"b"' });
    });

    it('survives nothing at all', () => {
        for (const raw of [null, undefined, 'x', 7, []]) {
            const out = parseCompare(raw);
            expect(out.steps).toEqual([]);
            expect(out.verdict).toBe('changed');
            expect(out.summary).toEqual({ same: 0, changed: 0, soft: 0, onlyA: 0, onlyB: 0, notComparable: 0 });
            expect(out.a.runId).toBe('');
        }
    });

    it('drops steps without an id and turns unknown verdicts into a difference', () => {
        const out = parseCompare({
            verdict: 'maybe',
            steps: [null, { verdict: 'same' }, { stepId: 's2', verdict: 'brand_new', softReason: 'something', kind: 'table', changes: [null, { path: 'rows' }] }],
        });
        expect(out.verdict).toBe('changed');
        expect(out.steps).toHaveLength(1);
        // A differ kind this build does not know is kept, so the generic list can show it.
        expect(out.steps[0]).toMatchObject({ stepId: 's2', verdict: 'changed', softReason: null, kind: 'table' });
        expect(out.steps[0].changes).toEqual([{ path: 'rows', change: 'changed', before: null, after: null }]);
    });
});

describe('parseChange and parseFileSummary', () => {
    it('turns a non-text value into its JSON', () => {
        expect(parseChange({ path: 'n', change: 'added', after: 5 })).toEqual({ path: 'n', change: 'added', before: null, after: '5' });
        expect(parseChange('nope')).toBeNull();
    });

    it('keeps only well-formed parts', () => {
        const s = parseFileSummary({ name: 'deck.pptx', mime: 'x', size: 10, parts: [{ kind: 'slide', index: 1, title: 'Intro', textChars: 12 }, 3, null] });
        expect(s?.parts).toHaveLength(1);
        expect(s?.parts[0]).toMatchObject({ kind: 'slide', index: 1, title: 'Intro', textChars: 12, rows: null });
        expect(parseFileSummary(null)).toBeNull();
    });
});

describe('goldens', () => {
    it('reads the list and its cap', () => {
        const out = parseGoldenList({
            goldens: [
                { goldenId: 'g1', runId: 'r1', label: 'Normal', ignorePaths: ['a', 3], run: { status: 'success', version: 2 }, lastReplay: { status: 'soft', replayRunId: 'r9', summary: { soft: 1 } } },
                { goldenId: 'g2' },
                { goldenId: 'g3', runId: 'r3', lastReplay: { status: 'a_new_status' } },
            ],
            limits: { max: 50 },
        });
        expect(out.max).toBe(50);
        expect(out.goldens.map(g => g.goldenId)).toEqual(['g1', 'g3']);
        expect(out.goldens[0].ignorePaths).toEqual(['a']);
        expect(out.goldens[0].lastReplay).toMatchObject({ status: 'soft', replayRunId: 'r9' });
        // A status from a newer server reads as an error, never as a pass.
        expect(out.goldens[1].lastReplay?.status).toBe('error');
    });

    it('treats a missing or zero cap as unlimited', () => {
        expect(parseGoldenList({ goldens: [] }).max).toBeNull();
        expect(parseGoldenList({ goldens: [], limits: { max: 0 } }).max).toBeNull();
        expect(parseGoldenList(undefined)).toEqual({ goldens: [], max: null });
        expect(parseGolden({})).toBeNull();
    });

    it('polls only while a replay is running', () => {
        const mk = (status: string) => parseGoldenList({ goldens: [{ goldenId: 'g', runId: 'r', lastReplay: { status } }] });
        expect(goldenPollMs(mk('running'))).toBe(3000);
        expect(goldenPollMs(mk('same'))).toBe(false);
        expect(goldenPollMs(mk('interrupted'))).toBe(false);
        expect(goldenPollMs(undefined)).toBe(false);
    });
});

describe('scenarios', () => {
    const wire = {
        scenarioId: 'fsc_1', name: 'Complete', sourceRunId: 'r1', hasTriggerAnswers: true,
        pages: [{ stepId: 'p2', fieldCount: 2 }, { fieldCount: 1 }],
        skipped: [{ stepId: null, field: 'cv', reason: 'file' }, { field: '' }],
    };

    it('reads the summary', () => {
        const s = parseScenario(wire);
        expect(s).toMatchObject({ scenarioId: 'fsc_1', name: 'Complete', hasTriggerAnswers: true });
        expect(s?.pages).toEqual([{ stepId: 'p2', fieldCount: 2 }]);
        expect(s?.skipped).toEqual([{ stepId: null, field: 'cv', reason: 'file' }]);
        expect(parseScenario({ name: 'x' })).toBeNull();
    });

    it('reads the answers per page and ignores what is not an object', () => {
        const d = parseScenarioDetail({ ...wire, answers: { trigger: { name: 'A' }, pages: { p2: { city: 'B' }, p3: 'bad' } } });
        expect(d?.answers).toEqual({ trigger: { name: 'A' }, pages: { p2: { city: 'B' } } });
        expect(parseScenarioDetail({ ...wire })?.answers).toEqual({ trigger: null, pages: {} });
        expect(parseScenarioDetail(null)).toBeNull();
    });

    it('reads the list', () => {
        expect(parseScenarioList({ scenarios: [wire, 5], limits: { max: 20 } })).toMatchObject({ max: 20 });
        expect(parseScenarioList(null)).toEqual({ scenarios: [], max: null });
    });
});
