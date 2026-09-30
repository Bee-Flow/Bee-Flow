import {
    bindingToText,
    canAdjust,
    chipLabel,
    chipsIn,
    fromFormula,
    insertPath,
    partsToText,
    textToBinding,
    textToParts,
    toFormula,
    unwrapRefs,
} from './bindingText';

const labels = new Map([['act_1', 'gmail search']]);

describe('bindingToText / textToBinding: the binding round trip', () => {
    // Each shape the visual model supports comes back as the SAME binding.
    it.each([
        ['an empty literal', { kind: 'literal', value: '' }, ''],
        ['a literal', { kind: 'literal', value: 'Hello' }, 'Hello'],
        ['a ref', { kind: 'ref', path: 'steps.act_1.output.total' }, '{{steps.act_1.output.total}}'],
        ['a template', { kind: 'template', value: 'Hi {{trigger.output.name}}!' }, 'Hi {{trigger.output.name}}!'],
        ['a loop item', { kind: 'ref', path: 'loop.item.email' }, '{{loop.item.email}}'],
        ['a row value', { kind: 'template', value: 'Row {{_index}}: {{item.name}}' }, 'Row {{_index}}: {{item.name}}'],
    ])('%s', (_name, binding, text) => {
        const shown = bindingToText(binding, 'binding');
        expect(shown).toEqual({ text, formula: false });
        expect(textToBinding(shown.text, 'binding', shown.formula)).toEqual(binding);
    });

    it('shows a JSON pick as its pill, and keeps it', () => {
        const binding = { kind: 'expr', value: 'parseJson(steps.act_1.output.body, "a.b")' };
        const shown = bindingToText(binding, 'binding');
        expect(shown).toEqual({ text: '', formula: false, pick: { path: 'steps.act_1.output.body', jsonPath: 'a.b' } });
        expect(textToBinding(shown.text, 'binding', false, shown)).toEqual(binding);
        expect(toFormula('', shown).text).toBe('parseJson(steps.act_1.output.body, "a.b")');
    });

    it('edits an expression as a formula, and keeps it', () => {
        for (const binding of [
            { kind: 'expr', value: 'steps.act_1.output.total > 100' },
        ]) {
            const shown = bindingToText(binding, 'binding');
            expect(shown).toEqual({ text: binding.value, formula: true });
            expect(textToBinding(shown.text, 'binding', true)).toEqual(binding);
        }
    });

    it('shows an adjusted value as its pill plus the adjustment, and keeps it', () => {
        for (const [binding, adjust] of [
            [{ kind: 'expr', value: 'upper(steps.act_1.output.name)' }, { transform: 'upper', arg: null, arg2: null }],
            [{ kind: 'expr', value: 'formatDate(steps.act_1.output.date, "DD-MM-YYYY")' }, { transform: 'formatDate', arg: 'DD-MM-YYYY', arg2: null }],
            [{ kind: 'expr', value: 'yesNoText(trigger.output.ok, "ja", "nee")' }, { transform: 'yesNoText', arg: 'ja', arg2: 'nee' }],
        ] as const) {
            const shown = bindingToText(binding, 'binding');
            expect(shown.formula).toBe(false);
            expect(shown.adjust).toEqual(adjust);
            expect(canAdjust(shown.text)).toBe(true);
            expect(textToBinding(shown.text, 'binding', false, shown)).toEqual(binding);
        }
    });

    it('drops an adjustment once there is text around the value', () => {
        const adjust = { transform: 'upper', arg: null, arg2: null };
        expect(canAdjust('Hi {{trigger.output.name}}')).toBe(false);
        expect(textToBinding('Hi {{trigger.output.name}}', 'binding', false, { adjust })).toEqual({ kind: 'template', value: 'Hi {{trigger.output.name}}' });
    });

    it('writes an adjusted value as a formula with the adjustment in it', () => {
        expect(toFormula('{{steps.act_1.output.name}}', { adjust: { transform: 'upper', arg: null, arg2: null } }).text).toBe('upper(steps.act_1.output.name)');
    });

    it('keeps a template whose interpolation is hand-written as a template', () => {
        const binding = { kind: 'template', value: 'Total {{ a + b }}' };
        const shown = bindingToText(binding, 'binding');
        expect(shown).toEqual({ text: 'Total {{ a + b }}', formula: false });
        expect(textToBinding(shown.text, 'binding')).toEqual(binding);
    });

    it('reads a bare literal (a value bind.js passes through) as its text', () => {
        expect(bindingToText(42, 'binding')).toEqual({ text: '42', formula: false });
        expect(bindingToText(null, 'binding')).toEqual({ text: '', formula: false });
    });

    it('builds the kind from the shape of what was typed', () => {
        expect(textToBinding('', 'binding')).toEqual({ kind: 'literal', value: '' });
        expect(textToBinding('{{trigger.output.subject}}', 'binding')).toEqual({ kind: 'ref', path: 'trigger.output.subject' });
        expect(textToBinding('Re: {{trigger.output.subject}}', 'binding')).toEqual({
            kind: 'template',
            value: 'Re: {{trigger.output.subject}}',
        });
        expect(textToBinding('steps.act_1.output.total', 'binding', true)).toEqual({ kind: 'ref', path: 'steps.act_1.output.total' });
    });

    it('passes templates and paths through as strings', () => {
        expect(bindingToText('Hi {{trigger.output.name}}', 'template')).toEqual({ text: 'Hi {{trigger.output.name}}', formula: false });
        expect(textToBinding('Hi {{x}}', 'template')).toBe('Hi {{x}}');
        expect(textToBinding('  steps.a.output.items ', 'path')).toBe('steps.a.output.items');
    });
});

describe('textToParts / partsToText', () => {
    it('splits text around data and joins it back', () => {
        const parts = textToParts('Order {{item.id}} for {{trigger.output.name}}');
        expect(parts).toEqual([
            { type: 'text', text: 'Order ' },
            { type: 'data', path: 'item.id' },
            { type: 'text', text: ' for ' },
            { type: 'data', path: 'trigger.output.name' },
        ]);
        expect(partsToText(parts ?? [])).toBe('Order {{item.id}} for {{trigger.output.name}}');
    });

    it('refuses a secret or a formula inside the braces', () => {
        expect(textToParts('{{secrets.token}}')).toBeNull();
        expect(textToParts('{{ a * 2 }}')).toBeNull();
    });
});

describe('insertPath', () => {
    it('puts a pill at the caret in text, the bare path in a formula, the whole value in a path field', () => {
        expect(insertPath('Hi !', { start: 3, end: 3 }, 'trigger.output.name', { mode: 'template' })).toEqual({
            value: 'Hi {{trigger.output.name}}!',
            caret: 26,
        });
        expect(insertPath('x > ', null, 'steps.a.output.n', { mode: 'binding', formula: true })).toEqual({
            value: 'x > steps.a.output.n',
            caret: 20,
        });
        expect(insertPath('old.path', { start: 0, end: 0 }, 'steps.a.output.items', { mode: 'path' })).toEqual({
            value: 'steps.a.output.items',
            caret: 20,
        });
    });

    it('replaces a selection', () => {
        expect(insertPath('Hello NAME', { start: 6, end: 10 }, 'item.name', { mode: 'binding' }).value).toBe('Hello {{item.name}}');
    });
});

describe('toFormula / fromFormula', () => {
    it('carries the value across, both ways', () => {
        expect(toFormula('Hi {{trigger.output.name}}')).toEqual({ text: 'concat("Hi ", trigger.output.name)', formula: true });
        expect(toFormula('{{steps.act_1.output.total}}')).toEqual({ text: 'steps.act_1.output.total', formula: true });
        expect(toFormula('plain')).toEqual({ text: '"plain"', formula: true });
        expect(fromFormula('steps.act_1.output.total')).toEqual({ text: '{{steps.act_1.output.total}}', formula: false });
        expect(fromFormula('')).toEqual({ text: '', formula: false });
    });

    it('refuses to flatten a real formula', () => {
        expect(fromFormula('steps.a.output.n > 3')).toBeNull();
        expect(fromFormula('upper(item.name) + 1')).toBeNull();
    });

    it('flattens an adjusted value to its pill and the adjustment', () => {
        expect(fromFormula('upper(item.name)')).toEqual({ text: '{{item.name}}', formula: false, adjust: { transform: 'upper', arg: null, arg2: null } });
    });
});

describe('chipsIn', () => {
    it('names every reference in a text, with where it sits', () => {
        const text = 'From {{steps.act_1.output.from}} at {{trigger.output.date}}';
        const chips = chipsIn(text, false, labels);
        expect(chips.map(chipLabel)).toEqual(['gmail search ▸ From', 'Trigger ▸ Date']);
        expect(text.slice(chips[0]?.start, chips[0]?.end)).toBe('{{steps.act_1.output.from}}');
    });

    it('says when a step is gone', () => {
        expect(chipsIn('{{steps.gone.output.x}}', false, labels)[0]?.missing).toBe(true);
    });

    it('finds bare paths in a formula', () => {
        const chips = chipsIn('steps.act_1.output.total > 100 && item.ok', true, labels);
        expect(chips.map((c) => c.path)).toEqual(['steps.act_1.output.total', 'item.ok']);
    });

    it('ignores what is not data', () => {
        expect(chipsIn('{{secrets.key}} and {{ 1 + 2 }}', false)).toEqual([]);
        expect(chipsIn('mysteps.x.y', true)).toEqual([]);
    });
});

describe('expression mode', () => {
    it('stores the expression as its text and inserts a bare path at the caret', () => {
        expect(textToBinding(' a > 1 ', 'expression')).toBe('a > 1');
        expect(insertPath('a > 1 && ', { start: 9, end: 9 }, 'trigger.output.ok', { mode: 'expression' })).toEqual({
            value: 'a > 1 && trigger.output.ok',
            caret: 26,
        });
    });
});

describe('unwrapRefs: a pasted {{path}} in a path or a formula', () => {
    it('keeps the bare path and leaves hand-written braces alone', () => {
        expect(unwrapRefs('{{steps.act_1.output.items}}')).toBe('steps.act_1.output.items');
        expect(unwrapRefs('{{ item.amount }} > 1000')).toBe('item.amount > 1000');
        expect(unwrapRefs('{{ a + b }}')).toBe('{{ a + b }}');
    });

    it('stores what a path or expression field means', () => {
        expect(textToBinding(' {{trigger.output.rows}} ', 'path')).toBe('trigger.output.rows');
        expect(textToBinding('{{item.ok}} && x', 'expression')).toBe('item.ok && x');
        expect(textToBinding('{{steps.act_1.output.total}} > 1', 'binding', true)).toEqual({ kind: 'expr', value: 'steps.act_1.output.total > 1' });
        expect(textToBinding('Hi {{trigger.output.name}}', 'template')).toBe('Hi {{trigger.output.name}}');
    });
});
