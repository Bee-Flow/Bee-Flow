// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { describeSwitch as describeSwitchJs } from './controlFlowSteps';
import { describeNode as describeNodeJs } from './describeNode';

/**
 * W6: before any run, the field picker and auto-map offer one list per output
 * of a Condition that works through a list, each row with the source list's
 * item fields. A list switch has no `value`; one that decides for the whole
 * run keeps it.
 */
interface Field { key: string; path: string; sample?: unknown; children?: Field[] }

// Both describers are JavaScript whose `sampleRoot = null` default reads as
// the parameter's whole type; these state the contract their headers describe.
const describeSwitch = describeSwitchJs as (node: unknown, sampleRoot?: unknown) => unknown;
const describeNode = describeNodeJs as (node: unknown, definition: unknown, toolToOutput: Map<string, unknown>, triggerOutputs: unknown, sampleRoot?: unknown) => unknown;

const ATTACHMENTS = [
    { filename: 'F-2026-0917.pdf', mimeType: 'application/pdf', size: 48211 },
    { filename: 'logo.png', mimeType: 'image/png', size: 5120 },
];
const sampleRoot = {
    steps: { read_many: { output: { messages: [{ id: 'm1', from: 'billing@fabrikam.example', attachments: ATTACHMENTS }] } } },
};
const listSwitch = {
    id: 'split', type: 'switch', label: 'Condition', routeStyle: 'rules',
    arrayRef: 'steps.read_many.output.messages[*].attachments',
    cases: [{ name: 'pdf', expr: 'equals(fileType(item), "pdf")' }, { name: 'word', expr: 'equals(fileType(item), "word")' }],
};

const keys = (fields: Field[]) => fields.map(f => f.key);
const allPaths = (fields: Field[]): string[] => fields.flatMap(f => [f.path, ...allPaths(f.children || [])]);

describe('describeSwitch — a Condition with several outputs working through a list', () => {
    it('offers one list per output plus Otherwise, and no value', () => {
        const g = describeSwitch(listSwitch, sampleRoot) as { fields: Field[]; sample: Record<string, unknown> };
        expect(keys(g.fields)).toEqual(['matched', 'branch', 'total', 'matchesByCase.pdf', 'matchesByCase.word', 'matchesByCase.default']);
        expect(g.sample).not.toHaveProperty('value');
    });

    it('gives every output the source list item fields', () => {
        const g = describeSwitch(listSwitch, sampleRoot) as { fields: Field[]; sample: { matchesByCase: Record<string, unknown[]> } };
        const pdf = g.fields.find(f => f.key === 'matchesByCase.pdf');
        expect(pdf?.path).toBe('steps.split.output.matchesByCase.pdf');
        expect(allPaths(pdf?.children || [])).toContain('steps.split.output.matchesByCase.pdf[*].mimeType');
        expect(allPaths(g.fields)).toContain('steps.split.output.matchesByCase.default[*].filename');
        expect(g.sample.matchesByCase.word[0]).toMatchObject({ filename: expect.any(String), mimeType: expect.any(String) });
    });

    it('still offers the outputs, empty, before the source list has a sample', () => {
        const g = describeSwitch(listSwitch, null) as { fields: Field[] };
        const pdf = g.fields.find(f => f.key === 'matchesByCase.pdf');
        expect(pdf).toMatchObject({ path: 'steps.split.output.matchesByCase.pdf', sample: [] });
        expect(keys(g.fields)).not.toContain('value');
    });

    it('keeps value for a Switch that decides for the whole run', () => {
        const whole = { id: 'sw', type: 'switch', expr: 'trigger.output.kind', cases: [{ name: 'vip', value: 'v' }] };
        const g = describeSwitch(whole, sampleRoot) as { fields: Field[] };
        expect(keys(g.fields)).toEqual(['matched', 'value', 'branch', 'matchesByCase.vip', 'matchesByCase.default']);
    });

    it('is what describeNode answers for a list switch (the sample root is passed on)', () => {
        const g = describeNode(listSwitch, { steps: [], edges: [] }, new Map(), {}, sampleRoot) as { fields: Field[] };
        expect(allPaths(g.fields)).toContain('steps.split.output.matchesByCase.pdf[*].size');
    });
});
