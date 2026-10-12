import { describe, it, expect } from 'vitest';
import { fieldLabelText, routeFieldLabel } from './routeFieldLabel';
import { recordFields } from './fieldTree';
import { describeSwitch as describeSwitchJs } from './controlFlowSteps';

// controlFlowSteps.js is still JavaScript: its `= null` default reads as the parameter's whole type.
type Described = { fields: Array<{ key: string; label?: string }> };
const describeSwitch = describeSwitchJs as unknown as (node: unknown, sampleRoot?: unknown) => Described;

const t = (key: string, fallback: string) => (key === 'condition_node.otherwise.label' ? 'Anders' : fallback);

describe('routeFieldLabel: a Condition output path carries its output name', () => {
    it('names an output and Otherwise', () => {
        expect(routeFieldLabel('steps.s.output.matchesByCase.pdf')).toEqual({ label: 'pdf' });
        expect(routeFieldLabel('steps.s.output.matchesByCase["High priority"]')).toEqual({ label: 'High priority' });
        expect(routeFieldLabel('steps.s.output.matchesByCase.default')).toEqual({ label: 'Otherwise', labelKey: 'condition_node.otherwise.label' });
    });

    it('leaves every other path alone', () => {
        expect(routeFieldLabel('steps.s.output.matchesByCase')).toBeNull();
        expect(routeFieldLabel('steps.s.output.matchesByCase.pdf[*].filename')).toBeNull();
        expect(routeFieldLabel('steps.s.output.items')).toBeNull();
        expect(routeFieldLabel('trigger.output.matchesByCase.pdf')).toBeNull();
    });

    it('fieldLabelText translates a keyed label and is null without one', () => {
        expect(fieldLabelText({ label: 'Otherwise', labelKey: 'condition_node.otherwise.label' }, t)).toBe('Anders');
        expect(fieldLabelText({ label: 'pdf' }, t)).toBe('pdf');
        expect(fieldLabelText({}, t)).toBeNull();
        expect(fieldLabelText(null, t)).toBeNull();
    });
});

describe('the field builders apply it', () => {
    it('a real switch output: the outputs under matchesByCase are labelled', () => {
        const fields = recordFields({ matchesByCase: { pdf: [{ filename: 'a.pdf' }], default: [] } }, 'steps.s.output');
        const byCase = fields.find(f => f.key === 'matchesByCase');
        expect(byCase?.label).toBeUndefined();
        const labels = (byCase?.children ?? []).map(f => f.label);
        expect(labels).toEqual(['pdf', 'Otherwise']);
    });

    it('describeSwitch labels its output fields, with and without sample rows', () => {
        const node = { id: 's', type: 'switch', label: 'By type', cases: [{ name: 'pdf', expr: 'true' }] };
        const labels = (n: Described) => n.fields.filter(f => f.key.startsWith('matchesByCase')).map(f => f.label);
        expect(labels(describeSwitch(node))).toEqual(['pdf', 'Otherwise']);
        const root = { steps: { r: { output: { attachments: [{ filename: 'a.pdf' }] } } } };
        expect(labels(describeSwitch({ ...node, arrayRef: 'steps.r.output.attachments' }, root))).toEqual(['pdf', 'Otherwise']);
    });
});
