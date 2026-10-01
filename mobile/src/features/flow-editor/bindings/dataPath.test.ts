import { describeDataPath, isDataPath } from './dataPath';
import { classifyRef, resolveChipLabel } from './refTokens';

const labels = new Map([['a', 'Gmail search']]);

describe('describeDataPath', () => {
    it.each<[string, { name: string; suffix: string; missing: boolean; source: string }]>([
        ['steps.a.output.total', { name: 'Gmail search', suffix: 'Total', missing: false, source: 'steps' }],
        ['steps.gone.output.x', { name: 'Previous step', suffix: 'X', missing: true, source: 'steps' }],
        ['trigger.output.subject', { name: 'Trigger', suffix: 'Subject', missing: false, source: 'trigger' }],
        ['loop.row.name', { name: 'Loop item · row', suffix: 'Name', missing: false, source: 'loop' }],
        ['item.from_email', { name: 'Current row', suffix: 'From email', missing: false, source: 'item' }],
        ['_index', { name: 'Row number', suffix: '', missing: false, source: 'item' }],
        ['vars.my_var', { name: 'Variable', suffix: 'My var', missing: false, source: 'vars' }],
        ['', { name: '', suffix: '', missing: false, source: 'steps' }],
    ])('%p', (path, label) => {
        expect(describeDataPath(path, labels)).toEqual(label);
    });

    it('never names a step by its id when the label is known', () => {
        expect(describeDataPath('steps.a.output.results[*].subject', labels).name).toBe('Gmail search');
    });
});

describe('isDataPath', () => {
    it.each<[string, boolean]>([
        ['steps.a.output', true], ['item', true], ['_index', true], [' item.a ', true], ['item[0]', true], ['vars', true],
        ['secrets.x', false], ['x.y', false], ['', false], ['a + b', false],
    ])('%p is %p', (path, yes) => {
        expect(isDataPath(path)).toBe(yes);
    });
});

describe('refTokens', () => {
    it('classifies a ref', () => {
        expect(classifyRef('steps.a.output.x')).toEqual({ source: 'steps', stepId: 'a', fieldPath: 'x' });
        expect(classifyRef('loop.row.y')).toEqual({ source: 'loop', itemVar: 'row', fieldPath: 'y' });
        expect(classifyRef('trigger.output.z')).toEqual({ source: 'trigger', fieldPath: 'z' });
        expect(classifyRef('trigger')).toEqual({ source: 'trigger', fieldPath: '' });
        expect(classifyRef('nope')).toBeNull();
        expect(classifyRef(5)).toBeNull();
    });

    it('names a chip', () => {
        expect(resolveChipLabel({ source: 'steps', stepId: 'a', fieldPath: 'x' }, labels)).toEqual({ name: 'Gmail search', suffix: 'x', missing: false });
        expect(resolveChipLabel({ source: 'steps', stepId: 'gone', fieldPath: '' }, labels)).toEqual({ name: 'gone', suffix: '', missing: true });
        expect(resolveChipLabel({ source: 'loop', fieldPath: 'z' })).toEqual({ name: 'Loop item', suffix: 'z', missing: false });
        expect(resolveChipLabel(null)).toEqual({ name: '', suffix: '', missing: false });
    });
});
