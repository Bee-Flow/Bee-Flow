import { describe, expect, it } from 'vitest';
import type { TranslateFn } from '../../../../hooks/useTranslation';
import {
    continuesSummary, familyWord, firstSentence, headerTitle, incomingSummary, lastRunPill, stepDuration, whatItDoes,
} from './ndvModel';

const t = ((_key: string, en: string, params?: Record<string, unknown>) =>
    String(en).replace(/\{(\w+)\}/g, (m, k) => (params && k in params ? String(params[k]) : m))) as unknown as TranslateFn;
const walk = (path: string, root: unknown) => path.split('.').reduce<unknown>((o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined), root);

describe('ndvModel — the header', () => {
    it('kicks off with the family word, and a trigger keeps its kind', () => {
        expect(familyWord({ id: 's', type: 'integration_action' }, t)).toBe('Action');
        expect(familyWord({ id: 's', type: 'ai_step' }, t)).toBe('AI step');
        expect(familyWord({ id: 't', type: 'trigger', kind: 'schedule' }, t)).toBe('Schedule trigger');
    });

    it('titles a step by its own name first', () => {
        expect(headerTitle({ id: 's', type: 'ai_step', label: 'Read invoice' }, null)).toBe('Read invoice');
    });

    it('says how the last run went in one pill', () => {
        const none = { pinned: false, edited: false };
        expect(lastRunPill({ status: 'error' }, null, none, t)).toEqual({ tone: 'error', label: 'Failed on last run' });
        expect(lastRunPill({ status: 'success' }, { count: 23, kind: 'list', label: '23 files' }, none, t))
            .toEqual({ tone: 'success', label: 'Worked · 23 files' });
        expect(lastRunPill(null, null, none, t)).toBeNull();
        expect(lastRunPill(null, null, { pinned: true, edited: true }, t)?.label).toBe('Output written by hand');
    });
});

describe('ndvModel — the column summaries', () => {
    it('column 1 names the nearest step and the record that came in', () => {
        const groups = [
            { label: 'Manual start', basePath: 'trigger.output', sample: {} },
            { label: 'New file', basePath: 'steps.s1.output', sample: { name: '<string>' } },
        ];
        const sample = { steps: { s1: { output: { name: 'Invoice-2026-001.pdf' } } } };
        expect(incomingSummary(groups, sample, null, walk, t)).toBe('New file · Invoice-2026-001.pdf');
        // A design-time placeholder is not a record: fall back to the count.
        expect(incomingSummary(groups, null, { count: 1, kind: 'record', label: '1 record' }, walk, t)).toBe('New file · 1 record');
        expect(incomingSummary([], null, null, walk, t)).toBe('Nothing yet, this step comes first');
    });

    it('column 1 skips "Trigger info": it comes after the steps but is not the nearest one', () => {
        const groups = [
            { label: 'Manual start', basePath: 'trigger.output', sample: {} },
            { label: 'Mail accounts', basePath: 'steps.s1.output', sample: {} },
            { label: 'Trigger info', kind: 'trigger_meta', basePath: 'trigger', sample: {} },
        ];
        expect(incomingSummary(groups, null, null, walk, t)).toBe('Mail accounts');
    });

    it('column 2 reads the catalog description, one sentence', () => {
        const catalog = { apps: [{ label: 'Nextcloud', actions: [{ name: 'nc_read', description: 'Reads the content of a file from Nextcloud. Supports PDF.' }] }] };
        expect(whatItDoes({ id: 's', type: 'integration_action', tool: 'nc_read' }, catalog, t)).toBe('Reads the content of a file from Nextcloud');
    });

    it('column 3 says what came out and how long it took', () => {
        const run = { status: 'success', startedAt: '2026-09-28T08:00:00.000Z', finishedAt: '2026-09-28T08:00:01.200Z' };
        expect(continuesSummary(run, { count: 23, kind: 'list', label: 'List of 23 files' }, false, t)).toBe('List of 23 files · 1.2 s');
        expect(continuesSummary({ status: 'error' }, null, false, t)).toBe('Nothing, the step stopped');
        expect(continuesSummary(null, null, false, t)).toBe('Not run yet, this is what it will give');
    });

    it('formats durations and first sentences', () => {
        expect(stepDuration({ durationMs: 340 })).toBe('340 ms');
        expect(stepDuration({})).toBeNull();
        expect(firstSentence('One. Two.')).toBe('One');
    });
});
