import { computeUpstreamGroups, type VariableGroup } from '@/features/flow-editor/bindings';
import { CATALOG, chainDefinition } from '@/features/flow-editor/bindings/testing/fixture';

import { fieldName, fieldPreview, listRows, pickerRows, toggleExpanded } from './pickerModel';

const GROUPS: VariableGroup[] = [
    {
        id: 'trg',
        label: 'Trigger',
        kind: 'trigger',
        basePath: 'trigger.output',
        sample: { subject: 'Hi', from: { name: 'Ann', email: 'a@b.nl' } },
        fields: [
            { key: 'subject', path: 'trigger.output.subject', sample: 'Hi' },
            {
                key: 'from',
                path: 'trigger.output.from',
                sample: { name: 'Ann', email: 'a@b.nl' },
                children: [
                    { key: 'name', path: 'trigger.output.from.name', sample: 'Ann' },
                    { key: 'email', path: 'trigger.output.from.email', sample: 'a@b.nl' },
                ],
            },
        ],
    },
    {
        id: 'act_1',
        label: 'gmail search',
        kind: 'step',
        basePath: 'steps.act_1.output',
        sample: { total: 2, results: [{ id: 'm1' }, { id: 'm2' }] },
        fields: [
            { key: 'total', path: 'steps.act_1.output.total', sample: 2 },
            { key: 'results', path: 'steps.act_1.output.results', sample: [{ id: 'm1' }, { id: 'm2' }] },
        ],
    },
];

const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

describe('pickerRows', () => {
    it('lists the nearest step first, each group before its fields, nested fields closed', () => {
        expect(ids(pickerRows(GROUPS))).toEqual([
            'group:act_1',
            'act_1:steps.act_1.output.total',
            'act_1:steps.act_1.output.results',
            'group:trg',
            'trg:trigger.output.subject',
            'trg:trigger.output.from',
        ]);
    });

    it('opens a nested field on request', () => {
        const expanded = toggleExpanded(new Set(), 'trigger.output.from');
        const rows = pickerRows(GROUPS, { expanded });
        expect(ids(rows)).toContain('trg:trigger.output.from.email');
        const email = rows.find((r) => r.id === 'trg:trigger.output.from.email');
        expect(email).toMatchObject({ kind: 'field', depth: 1 });
        expect(toggleExpanded(expanded, 'trigger.output.from').size).toBe(0);
    });

    it('searches the whole tree and shows every hit, however deep', () => {
        expect(ids(pickerRows(GROUPS, { query: 'email' }))).toEqual([
            'group:trg',
            'trg:trigger.output.from',
            'trg:trigger.output.from.email',
        ]);
        // A group whose NAME matches is kept whole.
        expect(ids(pickerRows(GROUPS, { query: 'gmail' }))).toHaveLength(3);
        expect(pickerRows(GROUPS, { query: 'nothing like it' })).toEqual([]);
    });

    it('shows each field with its sample value', () => {
        const rows = pickerRows(GROUPS);
        const results = rows.find((r) => r.id === 'act_1:steps.act_1.output.results');
        expect(results).toMatchObject({ preview: '[2 items]' });
    });

    it('works over real upstream groups', () => {
        const def = chainDefinition();
        const last = def.steps?.[def.steps.length - 1]?.id as string;
        const rows = pickerRows(computeUpstreamGroups(def, last, CATALOG));
        expect(rows.filter((r) => r.kind === 'group').length).toBeGreaterThan(1);
        expect(rows.every((r) => r.id)).toBe(true);
        expect(new Set(ids(rows)).size).toBe(rows.length);
    });
});

describe('listRows', () => {
    it('offers only lists, searchable', () => {
        const rows = listRows(GROUPS);
        expect(rows.map((r) => r.field.path)).toContain('steps.act_1.output.results');
        expect(rows.every((r) => r.field.path !== 'steps.act_1.output.total')).toBe(true);
        expect(listRows(GROUPS, { query: 'zzz' })).toEqual([]);
    });
});

describe('fieldPreview', () => {
    it('resolves through the sample root when it can, and falls back to the field sample', () => {
        const root = { trigger: { output: { subject: 'Real subject' } }, steps: {} };
        expect(fieldPreview({ path: 'trigger.output.subject', sample: 'Hi' }, root)).toBe('Real subject');
        expect(fieldPreview({ path: 'trigger.output.missing', sample: 'Hi' }, root)).toBe('Hi');
        expect(fieldPreview({ path: 'x', sample: undefined })).toBe('—');
    });
});

describe('fieldName', () => {
    it('reads a field by its own label where the key is internal, else by its key', () => {
        const nl = (key: string, en: string) => (key === 'condition_node.otherwise.label' ? 'Anders' : en);
        expect(fieldName({ key: 'matchesByCase.default', label: 'Otherwise', labelKey: 'condition_node.otherwise.label' }, nl)).toBe('Anders');
        expect(fieldName({ key: 'matchesByCase.pdf', label: 'pdf' }, nl)).toBe('pdf');
        expect(fieldName({ key: 'subject' }, nl)).toBe('subject');
    });
});
