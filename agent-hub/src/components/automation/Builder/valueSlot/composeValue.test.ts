import { describe, expect, it } from 'vitest';
import { evaluate } from '@shared/expr/index.mjs';
import * as parse from '@shared/expr/parse.mjs';
import { createResolver } from '@shared/mapping/index.mjs';
import type { ComposeBinding, MappingSource, PickPart } from '@shared/mapping/index.mjs';
import {
    classifyPlaceholder, composeSite, exampleOf, legacyPlaceholderOf, liftPlaceholder, normalizePieces, partForInsert, partLabel,
    piecesFromValue, placeholderForInsert, tokenizeText, valueFromPieces, withIntent, withNamedInputs, readablePlaceholder,
} from './composeValue';
import type { SlotPiece } from './composeValue';

const SAMPLE = {
    trigger: {
        output: {
            customer: { name: 'Anna de Vries', email: 'anna@voorbeeld.nl' },
            orders: [
                { id: 'A-100', lines: [{ product: 'Bureaustoel', qty: 1 }, { product: 'Lamp', qty: 2 }] },
                { id: 'A-101', lines: [{ product: 'Muismat', qty: 3 }] },
            ],
        },
    },
    steps: { fetch: { output: { subjects: ['Levering vertraagd', 'Factuur 2026-118'] } } },
    vars: {},
};

const resolver = createResolver({ evaluate, parse });
const PRODUCTS: MappingSource = { root: 'trigger', path: ['orders', 'lines', 'product'] };
const NAME: MappingSource = { root: 'trigger', path: ['customer', 'name'] };

/** What an edit of the field stores, for pieces as the editor would hold them. */
function edit(pieces: SlotPiece[], stepType: string, field: string, wasMapping = false) {
    return valueFromPieces(pieces, { stepType, field, site: composeSite(stepType, field), wasMapping });
}

describe('composeSite: what the sites table says about a text field', () => {
    it('a notification body takes a compose and lifts a template, one value per line', () => {
        expect(composeSite('notification', 'body')).toEqual({ compose: true, lift: true, sole: false, slot: { as: 'text', multiLine: true } });
        expect(composeSite('notification', 'title').slot).toEqual({ as: 'text', multiLine: false });
    });

    it('an AI step prompt renders a compose but keeps its template (it reads inputs by name)', () => {
        expect(composeSite('ai_step', 'prompt')).toMatchObject({ compose: true, lift: false });
    });

    it('a text whose executor reads a plain string only takes no compose', () => {
        expect(composeSite('approval', 'approval.details')).toMatchObject({ compose: false, lift: false });
        expect(composeSite('return_to_app', 'toast.message')).toMatchObject({ compose: false });
        expect(composeSite('form_page', 'form')).toMatchObject({ compose: false });
        expect(composeSite('nope', 'x')).toMatchObject({ compose: false, lift: false });
        expect(composeSite(undefined, undefined)).toMatchObject({ compose: false });
    });

    it('a fill_document value is one value on its own', () => {
        expect(composeSite('fill_document', 'values.klant')).toMatchObject({ compose: true, lift: true, sole: true });
        expect(composeSite('fill_document', 'fileName')).toMatchObject({ sole: false });
    });
});

describe('pieces: a stored value as the editor shows it', () => {
    it('a template splits into text and placeholders, kept verbatim', () => {
        expect(piecesFromValue('Beste {{ trigger.output.customer.name }},\nbedankt')).toEqual([
            'Beste ', { raw: '{{ trigger.output.customer.name }}' }, ',\nbedankt',
        ]);
        expect(piecesFromValue('a { b {{}} c')).toEqual(['a { b {{}} c']);
    });

    it('a compose shows its parts, a pick its one part: never "[object Object]"', () => {
        const part: PickPart = { from: PRODUCTS, take: 'all', as: 'text', join: 'lines', label: 'Product' };
        expect(piecesFromValue({ kind: 'compose', v: 1, parts: ['Orders: ', part] })).toEqual(['Orders: ', { part }]);
        expect(piecesFromValue({ kind: 'pick', v: 1, from: NAME, take: 'one', as: 'native' })).toEqual([{ part: { from: NAME, take: 'one', as: 'native' } }]);
        expect(piecesFromValue({ some: 'object' })).toEqual([]);
        expect(piecesFromValue(null)).toEqual([]);
        expect(piecesFromValue({ kind: 'ref', path: 'trigger.output.x' })).toEqual([{ raw: '{{trigger.output.x}}' }]);
    });

    it('placeholders typed by hand are read as placeholders, adjacent text merged', () => {
        expect(normalizePieces(['Hi {{trigger.output.customer.name}}', '!', '', { raw: '{{x}}' }, 'a', 'b'])).toEqual([
            'Hi ', { raw: '{{trigger.output.customer.name}}' }, '!', { raw: '{{x}}' }, 'ab',
        ]);
    });
});

describe('a template where the run takes plain text only: byte for byte', () => {
    const CASES = [
        'Make a short summary:',
        'Summarise {{steps.act_f9aaff0e.output.body}} please',
        '{{trigger.output.subject}} — {{steps.ai_1.output}}',
        'line one\n',
        'a\n\n\nb',
        '{{ steps.ai_1.output.total }}',
        '{{ not.a.ref }}',
        'a { b',
        'Rows: {{steps.kw.output.rows[*].id}}',
    ];
    for (const text of CASES) {
        it(JSON.stringify(text), () => {
            expect(edit(tokenizeText(text), 'approval', 'approval.details')).toBe(text);
            expect(edit(tokenizeText(text), 'form_page', 'form')).toBe(text);
        });
    }
});

describe('an edit where the run takes a compose', () => {
    it('lifts a legacy template to a compose with labelled parts', () => {
        const value = edit(tokenizeText('Beste {{trigger.output.customer.name}},\nUw producten: {{trigger.output.orders[*].lines[*].product}}'), 'notification', 'body');
        expect(value).toEqual({
            kind: 'compose',
            v: 1,
            parts: [
                'Beste ',
                { from: NAME, take: 'one', as: 'text', label: 'Name' },
                ',\nUw producten: ',
                { from: PRODUCTS, take: 'all', as: 'text', join: 'lines', label: 'Product' },
            ],
        });
    });

    it('a list in a one-line text is comma-separated', () => {
        const value = edit(tokenizeText('Over: {{steps.fetch.output.subjects[*]}}'), 'notification', 'title');
        // A `[*]` at the end does not lift (template.mjs): the text stays a template.
        expect(value).toBe('Over: {{steps.fetch.output.subjects[*]}}');
        const lifted = edit(tokenizeText('Voor {{trigger.output.orders[*].id}}'), 'notification', 'title') as ComposeBinding;
        expect(lifted.parts[1]).toMatchObject({ take: 'all', as: 'text', join: 'comma' });
    });

    it('one placeholder that does not lift keeps the whole text a template', () => {
        const text = 'Key {{secrets.apiKey}} for {{trigger.output.customer.name}}';
        expect(edit(tokenizeText(text), 'notification', 'body')).toBe(text);
    });

    it('text with no values stays a plain string', () => {
        expect(edit(['Hallo\nwereld'], 'notification', 'body')).toBe('Hallo\nwereld');
        expect(edit([], 'notification', 'body')).toBe('');
    });

    it('an AI step prompt stays a template, unless it already was a compose', () => {
        const text = 'Vat samen: {{trigger.output.customer.name}} en {{emails}}';
        expect(edit(tokenizeText(text), 'ai_step', 'prompt')).toBe(text);
        const part: PickPart = { from: NAME, take: 'one', as: 'text' };
        expect(edit(['Vat samen: ', { part }], 'ai_step', 'prompt', true)).toEqual({ kind: 'compose', v: 1, parts: ['Vat samen: ', part] });
    });

    it('a pick in a text that takes plain text only is written as its placeholder', () => {
        expect(edit(['Naam: ', { part: { from: NAME, take: 'one', as: 'text' } }], 'approval', 'approval.details'))
            .toBe('Naam: {{trigger.output.customer.name}}');
    });

    it('a fill_document value that is one value is a pick of it; with text around it a compose', () => {
        expect(edit(tokenizeText('{{trigger.output.orders[*].id}}'), 'fill_document', 'values.ids')).toEqual({
            kind: 'pick', v: 1, from: { root: 'trigger', path: ['orders', 'id'] }, take: 'all', as: 'native', label: 'ID',
        });
        const part = partForInsert({ path: 'trigger.output.customer.name' }, composeSite('fill_document', 'values.naam').slot, SAMPLE)!;
        expect(edit([{ part }], 'fill_document', 'values.naam')).toEqual({ kind: 'pick', v: 1, from: NAME, take: 'one', as: 'native', label: 'Name' });
        expect(edit(['Klant: ', { part }], 'fill_document', 'values.naam')).toMatchObject({ kind: 'compose' });
    });

    it('regression: blank text around the one value keeps it the value (the run trims it too)', () => {
        const part: PickPart = { from: PRODUCTS, take: 'all', as: 'text', join: 'lines', label: 'Product' };
        const native = { kind: 'pick', v: 1, from: PRODUCTS, take: 'all', as: 'native', label: 'Product' };
        // A pill and a space after it, or Enter before it: still the list itself.
        expect(edit([{ part }, ' '], 'fill_document', 'values.regels')).toEqual(native);
        expect(edit(['\n', { part }], 'fill_document', 'values.regels')).toEqual(native);
        expect(edit([' \n', { part }, '\n '], 'fill_document', 'values.regels')).toEqual(native);
        // A legacy ` {{x}} ` the person edits stays native, as the run read it.
        expect(edit(tokenizeText(' {{trigger.output.orders[*].lines[*].product}}\n'), 'fill_document', 'values.regels'))
            .toMatchObject({ kind: 'pick', from: PRODUCTS, take: 'all', as: 'native' });
        // Real text around it is a text; blank text elsewhere is not trimmed.
        expect(edit([' Regels: ', { part }], 'fill_document', 'values.regels')).toMatchObject({ kind: 'compose' });
        expect(edit([{ part }, ' '], 'notification', 'body')).toEqual({ kind: 'compose', v: 1, parts: [part, ' '] });
    });
});

describe('regression: a compose that cannot stay one is never stored as a template that reads less', () => {
    const NAME_PART: PickPart = { from: NAME, take: 'one', as: 'text', label: 'Name' };
    const PRODUCTS_PART: PickPart = { from: PRODUCTS, take: 'all', as: 'text', join: 'lines', label: 'Product' };

    it('a formula typed next to all of a list is not stored at all (null), so the list is not lost', () => {
        // `{{trigger.output.orders.lines.product}}` (the Source without its
        // `[*]`) reads nothing in the legacy walk: the orders would render ''.
        expect(edit(['Orders: ', { part: PRODUCTS_PART }, ' ', { raw: '{{secrets.token}}' }], 'notification', 'body', true)).toBeNull();
        expect(edit(['Orders: ', { part: PRODUCTS_PART }, ' {{ 1 + 1 }}'], 'notification', 'body', true)).toBeNull();
    });

    it('a formula next to single values is a template that reads every value the same way', () => {
        const value = edit(['Beste ', { part: NAME_PART }, ' {{secrets.token}}'], 'notification', 'body', true);
        expect(value).toBe('Beste {{trigger.output.customer.name}} {{secrets.token}}');
        expect(resolver.interpolateTemplate(value, SAMPLE)).toMatch(/^Beste Anna de Vries /);
    });

    it('legacyPlaceholderOf spells only what the legacy walk reads the same', () => {
        expect(legacyPlaceholderOf(NAME_PART)).toBe('{{trigger.output.customer.name}}');
        expect(legacyPlaceholderOf({ from: { root: 'steps', id: 'fetch', path: ['subjects'] }, take: 'one', as: 'native' }))
            .toBe('{{steps.fetch.output.subjects}}');
        expect(legacyPlaceholderOf(PRODUCTS_PART)).toBeNull();
        expect(legacyPlaceholderOf({ from: NAME, take: 'count', as: 'text' })).toBeNull();
        expect(legacyPlaceholderOf({ from: NAME, take: 'one', as: 'list' })).toBeNull();
        expect(legacyPlaceholderOf({ from: { root: 'run', path: ['firedAt'] }, take: 'one', as: 'text' })).toBeNull();
        expect(legacyPlaceholderOf({ from: { root: 'item', path: ['amount'] }, take: 'one', as: 'text' })).toBeNull();
    });
});

describe('partForInsert: a picked value as a part of this text', () => {
    const LINES = composeSite('notification', 'body').slot;

    it('all of a list, one per line, in a multi-line text', () => {
        expect(partForInsert({ path: 'trigger.output.orders[*].lines[*].product', source: PRODUCTS }, LINES, SAMPLE))
            .toEqual({ from: PRODUCTS, take: 'all', as: 'text', join: 'lines', label: 'Product' });
    });

    it('one value as it is', () => {
        expect(partForInsert({ source: NAME }, LINES, SAMPLE)).toEqual({ from: NAME, take: 'one', as: 'text', label: 'Name' });
    });

    it('without a sample a `[*]` in the path still says it is a list', () => {
        expect(partForInsert({ path: 'steps.fetch.output.items[*].sku' }, LINES, null))
            .toMatchObject({ from: { root: 'steps', id: 'fetch', path: ['items', 'sku'] }, take: 'all', join: 'lines' });
    });

    it('a path that reads no Source gives nothing', () => {
        expect(partForInsert({ path: 'secrets.apiKey' }, LINES, SAMPLE)).toBeNull();
        expect(partForInsert({}, LINES, SAMPLE)).toBeNull();
    });

    it('a text that takes plain text gets the placeholder of the path', () => {
        expect(placeholderForInsert({ path: 'trigger.output.orders[*].id' })).toBe('{{trigger.output.orders[*].id}}');
        expect(placeholderForInsert({ source: NAME })).toBe('{{trigger.output.customer.name}}');
        expect(placeholderForInsert({})).toBeNull();
    });

    it('withIntent changes how a value is used and keeps where it comes from', () => {
        const part: PickPart = { from: PRODUCTS, take: 'all', as: 'text', join: 'lines', label: 'Product' };
        expect(withIntent(part, { take: 'first', as: 'text' })).toEqual({ from: PRODUCTS, take: 'first', as: 'text', label: 'Product' });
    });
});

describe('regression: text mixed with a list rendered as raw JSON', () => {
    it('a list picked into a body reaches the run as readable text, one per line', () => {
        const slot = composeSite('notification', 'body').slot;
        const part = partForInsert({ source: PRODUCTS }, slot, SAMPLE)!;
        const body = edit(['Uw producten:\n', { part }], 'notification', 'body');
        const text = resolver.interpolateTemplate(body, SAMPLE);
        expect(text).toBe('Uw producten:\nBureaustoel\nLamp\nMuismat');
        expect(text).not.toMatch(/[[\]{}"]/);
    });

    it('a table picked into a body renders one row per line, never [object Object]', () => {
        const part = partForInsert({ source: { root: 'trigger', path: ['orders', 'lines'] } }, composeSite('notification', 'body').slot, SAMPLE)!;
        const text = resolver.interpolateTemplate(edit(['Regels:\n', { part }], 'notification', 'body'), SAMPLE);
        expect(text).toContain('Bureaustoel · 1');
        expect(text).not.toContain('[object Object]');
    });
});

describe('placeholders as pills', () => {
    it('a value, an input name or a formula', () => {
        expect(classifyPlaceholder('{{ trigger.output.customer.name }}')).toEqual({ kind: 'value', from: NAME, take: 'one' });
        expect(classifyPlaceholder('{{trigger.output.orders[*].id}}')).toMatchObject({ kind: 'value', take: 'all' });
        // An index reads differently in the two walks: shown as a value, never lifted.
        expect(classifyPlaceholder('{{trigger.output.orders[0].id}}')).toMatchObject({ kind: 'value' });
        expect(liftPlaceholder('{{trigger.output.orders[0].id}}', 'notification', 'body')).toBeNull();
        expect(classifyPlaceholder('{{emails}}')).toEqual({ kind: 'name', name: 'emails' });
        expect(classifyPlaceholder('{{secrets.apiKey}}')).toEqual({ kind: 'formula' });
    });

    it('partLabel names the key a value reads', () => {
        expect(partLabel({ root: 'steps', id: 's', path: ['replyText'] })).toBe('Reply text');
        expect(partLabel({ root: 'steps', id: 's', path: ['items', 0] })).toBe('Items');
        expect(partLabel({ root: 'steps', id: 's', path: [] })).toBeUndefined();
    });
});

describe('exampleOf: what the run makes of the field', () => {
    it('a compose renders lists as readable text', () => {
        const value = { kind: 'compose', v: 1, parts: ['Producten: ', { from: PRODUCTS, take: 'all', as: 'text', join: 'comma' }] };
        expect(exampleOf(value, SAMPLE)).toEqual({ text: 'Producten: Bureaustoel, Lamp, Muismat', list: null });
        expect(exampleOf(value, null)).toBeNull();
    });

    it('a template shows the JSON the run puts in, and names the list for the note', () => {
        const ex = exampleOf('Over: {{steps.fetch.output.subjects}}', SAMPLE)!;
        expect(ex.text).toBe('Over: ["Levering vertraagd","Factuur 2026-118"]');
        expect(ex.list?.joinExpr).toBe('join(steps.fetch.output.subjects, ", ")');
        expect(exampleOf('Over: {{steps.fetch.output.subjects}}', SAMPLE, 'markdown')!.text)
            .toBe('Over: \n\n- Levering vertraagd\n- Factuur 2026-118\n');
    });

    it('nothing to fill in, nothing to show', () => {
        expect(exampleOf('plain', SAMPLE)).toBeNull();
        expect(exampleOf('', SAMPLE)).toBeNull();
    });
});

describe('withNamedInputs: an ai_step prompt reads its own inputs by name', () => {
    it('fills in an input as the run does, next to the roots', () => {
        const inputs = { toon: { kind: 'literal', value: 'vriendelijke' }, wie: { kind: 'ref', path: 'trigger.output.customer.name' } };
        const scope = withNamedInputs(SAMPLE, inputs)!;
        expect(exampleOf('Een {{toon}} mail aan {{wie}} ({{trigger.output.customer.email}})', scope)!.text)
            .toBe('Een vriendelijke mail aan Anna de Vries (anna@voorbeeld.nl)');
    });

    it('an input cannot hide a root, and no inputs leave the sample as it is', () => {
        const scope = withNamedInputs(SAMPLE, { trigger: { kind: 'literal', value: 'x' } }) as typeof SAMPLE;
        expect(scope.trigger).toBe(SAMPLE.trigger);
        expect(withNamedInputs(SAMPLE, {})).toBe(SAMPLE);
        expect(withNamedInputs(null, { toon: { kind: 'literal', value: 'x' } })).toBeNull();
    });
});

describe('readablePlaceholder: the example text of an empty field', () => {
    it('names each value instead of showing its path', () => {
        expect(readablePlaceholder('From: {{trigger.output.from}}\nSubject: {{ trigger.output.subject }}')).toBe('From: ‹From›\nSubject: ‹Subject›');
        expect(readablePlaceholder('Budget exceeded by {{steps.calc.output.delta}}')).toBe('Budget exceeded by ‹Delta›');
        expect(readablePlaceholder('{{steps.rows.output.rows[*].name}} · {{loop.row.omzet}}')).toBe('‹Name› · ‹Omzet›');
        expect(readablePlaceholder('{{steps.save.output.imageUrl}}')).toBe('‹Image URL›');
    });

    it('leaves plain text alone', () => {
        expect(readablePlaceholder('Summarise this email.')).toBe('Summarise this email.');
        expect(readablePlaceholder('')).toBe('');
    });
});
