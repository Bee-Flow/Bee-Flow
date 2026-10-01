// @vitest-environment node
import { describe, it, expect } from 'vitest';
import {
    parseRefTokens,
    serializeRefTokens,
    classifyRef,
    resolveChipLabel,
    hasRefTokens,
} from './refTokens';

const roundTrip = (s, mode) => serializeRefTokens(parseRefTokens(s, { mode }));

describe('refTokens — parse/serialize round-trip', () => {
    const cases = [
        ['bare steps ref (expr)', 'steps.ai_87e358.output.sources', 'expression'],
        ['bare trigger ref (expr)', 'trigger.output.keyTopics', 'expression'],
        ['bare loop ref (expr)', 'loop.item.amount', 'expression'],
        ['expr with operators', 'steps.s1.output.amount > 1000 ? "high" : "low"', 'expression'],
        ['nested + bracket path', 'steps.s1.output.results[0].subject', 'expression'],
        ['plain literal in fixed mode', 'just some text, no refs', 'fixed'],
        ['steps-looking text stays literal in fixed mode', 'steps.s1.output.x', 'fixed'],
        ['multi-ref template', 'From: {{trigger.output.from}} / {{steps.s1.output.subject}}', 'fixed'],
        ['template with a non-ref interpolation', 'Hi {{name}} — {{steps.s1.output.count}} items', 'fixed'],
        ['empty', '', 'expression'],
    ];
    for (const [name, input, mode] of cases) {
        it(`round-trips: ${name}`, () => {
            expect(roundTrip(input, mode)).toBe(input);
        });
    }
});

describe('refTokens — token structure', () => {
    it('extracts a steps ref with stepId + fieldPath', () => {
        const [tok] = parseRefTokens('steps.ai_87e358.output.sources', { mode: 'expression' });
        expect(tok).toMatchObject({ type: 'ref', source: 'steps', stepId: 'ai_87e358', fieldPath: 'sources' });
    });

    it('extracts a trigger ref fieldPath', () => {
        const [tok] = parseRefTokens('trigger.output.keyTopics', { mode: 'expression' });
        expect(tok).toMatchObject({ type: 'ref', source: 'trigger', fieldPath: 'keyTopics' });
    });

    it('extracts a loop ref itemVar + fieldPath', () => {
        const [tok] = parseRefTokens('loop.row.email', { mode: 'expression' });
        expect(tok).toMatchObject({ type: 'ref', source: 'loop', itemVar: 'row', fieldPath: 'email' });
    });

    it('keeps bracket-indexed nested paths in fieldPath', () => {
        const [tok] = parseRefTokens('steps.s1.output.results[0].subject', { mode: 'expression' });
        expect(tok.fieldPath).toBe('results[0].subject');
    });

    it('does not chip lookalike identifiers', () => {
        const toks = parseRefTokens('mysteps.x + avars.trigger.y + x.loop.y + "steps.a.output.b"', { mode: 'expression' });
        expect(toks.some(t => t.type === 'ref')).toBe(false);
    });

    it('splits an expression into literal + ref tokens', () => {
        const toks = parseRefTokens('steps.s1.output.amount > 1000', { mode: 'expression' });
        expect(toks.map(t => t.type)).toEqual(['ref', 'literal']);
        expect(toks[1].text).toBe(' > 1000');
    });
});

describe('classifyRef', () => {
    it('classifies each source and rejects non-refs', () => {
        expect(classifyRef('steps.a.output.b')).toMatchObject({ source: 'steps', stepId: 'a' });
        expect(classifyRef('trigger.output.b')).toMatchObject({ source: 'trigger' });
        expect(classifyRef('loop.it.b')).toMatchObject({ source: 'loop', itemVar: 'it' });
        expect(classifyRef('amount > 1000')).toBeNull();
        expect(classifyRef('"a literal"')).toBeNull();
    });
});

describe('resolveChipLabel', () => {
    const map = new Map([['ai_87e358', 'Search web & compile news digest']]);

    it('resolves a known step id to its label', () => {
        const tok = { source: 'steps', stepId: 'ai_87e358', fieldPath: 'sources' };
        expect(resolveChipLabel(tok, map)).toEqual({ name: 'Search web & compile news digest', suffix: 'sources', missing: false });
    });

    it('falls back to the id and flags missing for a deleted step', () => {
        const tok = { source: 'steps', stepId: 'gone_123', fieldPath: 'x' };
        const r = resolveChipLabel(tok, map);
        expect(r).toMatchObject({ name: 'gone_123', missing: true });
    });

    it('labels trigger and loop sources', () => {
        expect(resolveChipLabel({ source: 'trigger', fieldPath: 'subject' }, map)).toMatchObject({ name: 'Trigger', missing: false });
        expect(resolveChipLabel({ source: 'loop', itemVar: 'row', fieldPath: 'email' }, map)).toMatchObject({ name: 'Loop item · row', missing: false });
    });
});

describe('hasRefTokens', () => {
    it('is true only when a renderable ref is present', () => {
        expect(hasRefTokens('steps.s1.output.x', 'expression')).toBe(true);
        expect(hasRefTokens('Hello {{trigger.output.x}}', 'fixed')).toBe(true);
        expect(hasRefTokens('just text', 'fixed')).toBe(false);
        expect(hasRefTokens('steps.s1.output.x', 'fixed')).toBe(false); // literal in fixed mode
    });
});

// Confirmed bug: "No pill for root-level bracket keys or the item/vars roots".
// A key in brackets right after `output` (or `trigger`) stayed raw text, or
// became a `steps.x.output` pill with a `["content-type"]` tail that
// Backspace left behind; item.* and vars.* never became pills.
describe('refTokens — root bracket keys, item and vars', () => {
    it('makes the whole path one pill when a bracket key follows output', () => {
        for (const mode of ['expression', 'fixed']) {
            const text = mode === 'fixed' ? '{{steps.x.output["content-type"]}}' : 'steps.x.output["content-type"]';
            const toks = parseRefTokens(text, { mode });
            expect(toks).toHaveLength(1);
            expect(toks[0]).toMatchObject({ type: 'ref', source: 'steps', stepId: 'x', fieldPath: '["content-type"]' });
        }
        const [tok] = parseRefTokens('trigger.output["x-id"]', { mode: 'expression' });
        expect(tok).toMatchObject({ type: 'ref', raw: 'trigger.output["x-id"]', fieldPath: '["x-id"]' });
    });

    it('keeps a list column in the pill', () => {
        const toks = parseRefTokens('join(steps.a.output.rows[*]["Order date"], ", ")', { mode: 'expression' });
        expect(toks.map(t => t.type)).toEqual(['literal', 'ref', 'literal']);
        expect(toks[1].raw).toBe('steps.a.output.rows[*]["Order date"]');
    });

    it('pills item and vars refs, in expressions and templates', () => {
        const toks = parseRefTokens('item.amount > vars.limit', { mode: 'expression' });
        expect(toks.filter(t => t.type === 'ref').map(t => [t.source, t.fieldPath])).toEqual([['item', 'amount'], ['vars', 'limit']]);
        const [tpl] = parseRefTokens('{{item["Order date"]}}', { mode: 'fixed' });
        expect(tpl).toMatchObject({ type: 'ref', source: 'item', fieldPath: '["Order date"]' });
        expect(resolveChipLabel(tpl).name).toBe('Current row');
    });

    it('still round-trips byte for byte', () => {
        for (const s of ['steps.x.output["a b"].c + 1', 'item + vars', '{{ vars.rate }} and {{item.x}}', 'trigger.output[0]', 'steps.x.output["unclosed']) {
            expect(roundTrip(s, 'expression')).toBe(s);
            expect(roundTrip(s, 'fixed')).toBe(s);
        }
    });
});

// Confirmed bug: "trigger.<field> without .output looks like a valid chip but
// resolves to undefined". The chip is shown as missing; the trigger's own
// metadata (`trigger.firedAt`) is read on purpose and stays a plain chip.
describe('refTokens — trigger without .output', () => {
    it('marks trigger.<payload key> as missing, metadata keys not', () => {
        const [bad] = parseRefTokens('trigger.subject', { mode: 'expression' });
        expect(bad).toMatchObject({ type: 'ref', source: 'trigger', fieldPath: 'subject', noOutput: true });
        expect(resolveChipLabel(bad).missing).toBe(true);
        for (const ok of ['trigger.firedAt', 'trigger.output.subject', 'trigger', 'trigger.output']) {
            const [tok] = parseRefTokens(ok, { mode: 'expression' });
            expect(tok.noOutput).toBeUndefined();
            expect(resolveChipLabel(tok).missing).toBe(false);
        }
    });
});

// Review M4b: the bare `item` / `vars` roots matched inside longer words
// (`count(items)` became a "Current row" pill plus `s`) and inside quoted
// strings, where re-picking the pill overwrote the user's own words.
describe('refTokens — whole words outside strings only', () => {
    const refs = (s) => parseRefTokens(s, { mode: 'expression' }).filter(t => t.type === 'ref').map(t => t.raw);

    it('a root word inside a longer word is text', () => {
        expect(refs('count(items)')).toEqual([]);
        expect(refs('itemCount > 2 && variables.x')).toEqual([]);
        expect(refs('triggered || loops.x')).toEqual([]);
        expect(refs('item + items')).toEqual(['item']);
    });

    it('a ref-looking word inside a quoted string is text', () => {
        expect(refs('subject == "3 items left"')).toEqual([]);
        expect(refs('contains(x, "an item")')).toEqual([]);
        expect(refs("contains(item.name, 'the item.x and vars.y') && vars.z")).toEqual(['item.name', 'vars.z']);
        expect(refs('contains(x, "say \\"item\\" twice") || item.a')).toEqual(['item.a']);
        expect(refs('steps.x.output["an item"] == item.b')).toEqual(['steps.x.output["an item"]', 'item.b']);
        for (const s of ['subject == "3 items left"', 'contains(x, "an item', "a == 'item' + item"]) {
            expect(roundTrip(s, 'expression')).toBe(s);
        }
    });
});
