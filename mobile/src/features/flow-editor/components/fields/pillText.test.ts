import { chipsIn } from './bindingText';
import { applyDisplayEdit, pillLabel, pillText, rangeToRaw, toDisplay, toRaw, type PillText } from './pillText';

const labels = new Map([
    ['act_1', 'gmail search'],
    ['act_2', 'ai'],
]);
const NB = ' ';
const TOTAL = `${NB}gmail${NB}search${NB}▸${NB}Total${NB}`;
const NAME = `${NB}Trigger${NB}▸${NB}Name${NB}`;

function of(raw: string, expression = false): PillText {
    return pillText(raw, chipsIn(raw, expression, labels));
}

/** Type `next` over a display selection and return the new raw text. */
function edit(raw: string, next: (display: string) => string, selection: [number, number] | null, expression = false) {
    const pt = of(raw, expression);
    return applyDisplayEdit(pt, next(pt.display), selection ? { start: selection[0], end: selection[1] } : null);
}

describe('pillText: the display a person reads', () => {
    it('draws each reference as its label, never the raw path', () => {
        const pt = of('Re: {{steps.act_1.output.total}} from {{trigger.output.name}}');
        expect(pt.display).toBe(`Re: ${TOTAL} from ${NAME}`);
        expect(pt.display).not.toContain('{{');
        expect(pt.segments.map((s) => s.kind)).toEqual(['text', 'pill', 'text', 'pill']);
    });

    it('keeps a pill on one line and padded', () => {
        expect(pillLabel({ name: 'gmail search', suffix: 'Total' })).toBe(TOTAL);
        expect(pillLabel({ name: 'Trigger', suffix: '' })).toBe(`${NB}Trigger${NB}`);
    });

    it('leaves plain text and hand-written formulas inside braces alone', () => {
        expect(of('Hello there').display).toBe('Hello there');
        expect(of('Total {{ a + b }}').display).toBe('Total {{ a + b }}');
    });

    it('pills bare paths in a formula', () => {
        const pt = of('steps.act_1.output.total > 100', true);
        expect(pt.display).toBe(`${TOTAL} > 100`);
    });

    it('marks a reference to a deleted step', () => {
        const pt = of('{{steps.gone.output.x}}');
        const pill = pt.segments[0];
        expect(pill?.kind === 'pill' && pill.chip.missing).toBe(true);
    });
});

describe('toDisplay / toRaw: positions across the two texts', () => {
    const raw = 'Re: {{steps.act_1.output.total}}!';
    const pt = of(raw);
    const pillEnd = 4 + TOTAL.length;

    it('maps literal positions one to one', () => {
        expect(toRaw(pt, 2)).toBe(2);
        expect(toDisplay(pt, 2)).toBe(2);
        expect(toRaw(pt, pillEnd + 1)).toBe(raw.length);
        expect(toDisplay(pt, raw.length)).toBe(pt.display.length);
    });

    it('snaps a position inside a pill to after it', () => {
        expect(toRaw(pt, 6)).toBe(raw.indexOf('!'));
        expect(toDisplay(pt, 10)).toBe(pillEnd);
    });

    it('keeps the pill edges as they are', () => {
        expect(toRaw(pt, 4)).toBe(4);
        expect(toRaw(pt, pillEnd)).toBe(raw.indexOf('!'));
        expect(toDisplay(pt, 4)).toBe(4);
    });

    it('maps a selection', () => {
        expect(rangeToRaw(pt, { start: pillEnd + 1, end: 0 })).toEqual({ start: 0, end: raw.length });
    });
});

describe('applyDisplayEdit: typing', () => {
    const raw = 'Re: {{steps.act_1.output.total}}';

    it('types into the literal text', () => {
        const out = edit(raw, (d) => `X${d}`, [0, 0]);
        expect(out).toEqual({ raw: `X${raw}`, caret: 1, typed: { start: 0, end: 1 } });
    });

    it('types after a pill', () => {
        const out = edit(raw, (d) => `${d} ok`, [4 + TOTAL.length, 4 + TOTAL.length]);
        expect(out.raw).toBe(`${raw} ok`);
        expect(out.caret).toBe(out.raw.length);
    });

    it('types right before a pill, even when the letter matches its label', () => {
        // The display "Re: " + NBSP… — typing an NBSP before the pill must not
        // be read as typed after the pill's own leading NBSP.
        const out = edit(raw, (d) => `${d.slice(0, 4)}${NB}${d.slice(4)}`, [4, 4]);
        expect(out.raw).toBe(`Re: ${NB}{{steps.act_1.output.total}}`);
    });

    it('moves text typed inside a pill label to after the pill', () => {
        const out = edit(raw, (d) => `${d.slice(0, 7)}x${d.slice(7)}`, [7, 7]);
        expect(out.raw).toBe(`${raw}x`);
        expect(out.caret).toBe(out.raw.length);
    });

    it('replaces a selection that covers part of a pill, pill and all', () => {
        const out = edit(raw, (d) => `${d.slice(0, 2)}y${d.slice(8)}`, [2, 8]);
        expect(out.raw).toBe('Rey');
        expect(out.caret).toBe(3);
    });

    it('pastes over everything', () => {
        const pt = of(raw);
        const out = applyDisplayEdit(pt, 'new', { start: 0, end: pt.display.length });
        expect(out.raw).toBe('new');
    });

    it('reads an autocorrect that rewrote a word before the caret', () => {
        const out = edit('teh {{trigger.output.name}}', (d) => `the${d.slice(3)}`, [4, 4]);
        expect(out.raw).toBe('the {{trigger.output.name}}');
    });

    it('falls back to a diff when no selection was reported', () => {
        const out = edit(raw, (d) => `${d}!`, null);
        expect(out.raw).toBe(`${raw}!`);
    });
});

describe('applyDisplayEdit: deleting', () => {
    it('removes the whole reference on one backspace after its pill', () => {
        const raw = 'Re: {{steps.act_1.output.total}} ok';
        const end = 4 + TOTAL.length;
        const out = edit(raw, (d) => d.slice(0, end - 1) + d.slice(end), [end, end]);
        expect(out).toEqual({ raw: 'Re:  ok', caret: 4, typed: null });
    });

    it('removes the pill before the caret, not an identical-looking neighbour', () => {
        const raw = '{{steps.act_1.output.total}}{{trigger.output.name}}';
        const between = TOTAL.length;
        // Backspace between two pills: the first ends in an NBSP and the
        // second starts with one; a plain diff would blame the second.
        const out = edit(raw, (d) => d.slice(0, between - 1) + d.slice(between), [between, between]);
        expect(out.raw).toBe('{{trigger.output.name}}');
        expect(out.caret).toBe(0);
    });

    it('removes the same pill when the caret was reported after the backspace', () => {
        const raw = '{{steps.act_1.output.total}}{{trigger.output.name}}';
        const between = TOTAL.length;
        const out = edit(raw, (d) => d.slice(0, between - 1) + d.slice(between), [between - 1, between - 1]);
        expect(out.raw).toBe('{{trigger.output.name}}');
    });

    it('types before a pill when the caret was reported after the letter', () => {
        const raw = 'Re: {{steps.act_1.output.total}}';
        const out = edit(raw, (d) => `${d.slice(0, 4)}x${d.slice(4)}`, [5, 5]);
        expect(out.raw).toBe('Re: x{{steps.act_1.output.total}}');
        expect(out.caret).toBe(5);
    });

    it('removes a pill with a forward delete before it', () => {
        const raw = 'a{{trigger.output.name}}b';
        const out = edit(raw, (d) => d.slice(0, 1) + d.slice(2), [1, 1]);
        expect(out.raw).toBe('ab');
        expect(out.caret).toBe(1);
    });

    it('deletes literal text only', () => {
        const raw = 'abc{{trigger.output.name}}';
        const out = edit(raw, (d) => d.slice(0, 1) + d.slice(2), [2, 2]);
        expect(out.raw).toBe('ac{{trigger.output.name}}');
        expect(out.caret).toBe(1);
    });

    it('cuts a selection spanning text and pills', () => {
        const raw = 'a {{trigger.output.name}} b {{steps.act_1.output.total}} c';
        const pt = of(raw);
        const from = 1;
        const to = pt.display.indexOf(' c');
        const out = applyDisplayEdit(pt, pt.display.slice(0, from) + pt.display.slice(to), { start: from, end: to });
        expect(out.raw).toBe('a c');
    });

    it('clears the field', () => {
        const out = edit('{{trigger.output.name}}', () => '', [NAME.length, NAME.length]);
        expect(out.raw).toBe('');
        expect(out.caret).toBe(0);
    });
});

describe('applyDisplayEdit: a formula', () => {
    it('keeps operators typed after a pill as text', () => {
        const raw = 'steps.act_1.output.total';
        const out = edit(raw, (d) => `${d} > 100`, [TOTAL.length, TOTAL.length], true);
        expect(out.raw).toBe('steps.act_1.output.total > 100');
    });

    it('removes a bare reference whole', () => {
        const raw = 'steps.act_1.output.total > 100';
        const out = edit(raw, (d) => d.slice(0, TOTAL.length - 1) + d.slice(TOTAL.length), [TOTAL.length, TOTAL.length], true);
        expect(out.raw).toBe(' > 100');
    });
});

describe('applyDisplayEdit: nothing changed', () => {
    it('keeps the raw text and maps the caret', () => {
        const raw = 'x{{trigger.output.name}}';
        const pt = of(raw);
        expect(applyDisplayEdit(pt, pt.display, { start: 3, end: 3 })).toEqual({ raw, caret: raw.length, typed: null });
    });
});
