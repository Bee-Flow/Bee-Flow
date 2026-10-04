import { describe, it, expect } from 'vitest';
import { templateRemediesFor, templateShapeAt, replaceLastToken, hasToken } from './templateRemedies';
// The runtime's own renderer: every token a choice writes must resolve there.
const bind = require('../../../../../../server/automation/bind');

const R = 'steps.code_1.output.result';
const SAMPLE = {
    steps: {
        code_1: {
            output: {
                result: {
                    text: 'Hello world',
                    number: 42,
                    tags: ['red', 'green', 'blue'],
                    lines: [{ sku: 'A1', qty: 2, price: 9.95 }, { sku: 'B2', qty: 1, price: 24.5 }],
                    customer: { name: 'Acme BV', 'content-type': 'x', address: { city: 'Utrecht' } },
                },
            },
        },
    },
};
const ids = (r: ReturnType<typeof templateRemediesFor>) => (r ? r.choices.map(c => c.id) : null);
/** What the run writes for a choice's token. */
const run = (token: string) => bind.interpolateTemplate(token, SAMPLE);

describe('templateShapeAt', () => {
    it('asks nothing for one value', () => {
        expect(templateShapeAt(`${R}.text`, SAMPLE)).toBeNull();
        expect(templateShapeAt(`${R}.number`, SAMPLE)).toBeNull();
        expect(templateRemediesFor(`${R}.text`, SAMPLE)).toBeNull();
    });

    it('tells a list, a table and a group apart', () => {
        expect(templateShapeAt(`${R}.tags`, SAMPLE)).toBe('list');
        expect(templateShapeAt(`${R}.lines`, SAMPLE)).toBe('table');
        expect(templateShapeAt(`${R}.customer`, SAMPLE)).toBe('group');
    });
});

describe('a list of values in a text', () => {
    it('offers all / first / how many, and a run per item only when the step can take one', () => {
        expect(ids(templateRemediesFor(`${R}.tags`, SAMPLE))).toEqual(['all', 'first', 'count']);
        expect(ids(templateRemediesFor(`${R}.tags`, SAMPLE, { allowForEach: true }))).toEqual(['all', 'first', 'count', 'foreach']);
    });

    it('every token is something the runtime resolves, to what the preview says', () => {
        const r = templateRemediesFor(`${R}.tags`, SAMPLE, { allowForEach: true })!;
        const by = Object.fromEntries(r.choices.map(c => [c.id, c]));
        expect(run(by.all.token)).toBe('red, green, blue');
        expect(run(by.first.token)).toBe('red');
        expect(run(by.count.token)).toBe('3');
        for (const c of r.choices.filter(x => x.id !== 'foreach')) expect(run(c.token)).toBe(c.preview);
    });

    it('a run per item puts a forEach on the step and the item in the text', () => {
        const fe = templateRemediesFor(`${R}.tags`, SAMPLE, { allowForEach: true })!.choices.find(c => c.id === 'foreach')!;
        expect(fe.forEach?.overRef).toBe(`${R}.tags`);
        expect(fe.token).toBe(`{{loop.${fe.forEach?.itemVar}}}`);
        expect(fe.preview).toBe('red');
    });
});

describe('a table in a text', () => {
    it('offers a run per row first, then single columns, the row count and the raw table', () => {
        const r = templateRemediesFor(`${R}.lines`, SAMPLE, { allowForEach: true })!;
        expect(r.choices.map(c => c.id)).toEqual(['foreach', 'column:sku', 'column:qty', 'column:price', 'count', 'whole']);
        expect(r.currentId).toBe('whole');
    });

    it('a column reads as a comma list of that field, in the run too', () => {
        const col = templateRemediesFor(`${R}.lines`, SAMPLE)!.choices.find(c => c.id === 'column:sku')!;
        expect(col.token).toBe(`{{${R}.lines[*].sku}}`);
        expect(run(col.token)).toBe('A1, B2');
        expect(col.preview).toBe('A1, B2');
    });

    it('the row count is a number', () => {
        const c = templateRemediesFor(`${R}.lines`, SAMPLE)!.choices.find(x => x.id === 'count')!;
        expect(run(c.token)).toBe('2');
    });
});

describe('a group in a text', () => {
    it('offers its fields, quoting keys the path syntax cannot carry bare', () => {
        const r = templateRemediesFor(`${R}.customer`, SAMPLE)!;
        expect(r.choices.map(c => c.id)).toEqual(['field:name', 'field:content-type', 'field:address', 'whole']);
        const ct = r.choices.find(c => c.id === 'field:content-type')!;
        expect(run(ct.token)).toBe('x');
        expect(run(r.choices[0].token)).toBe('Acme BV');
    });
});

describe('a column picked directly', () => {
    it('gets only "all" and "for each": [0] and .length would apply per row', () => {
        expect(ids(templateRemediesFor(`${R}.lines[*].sku`, SAMPLE, { allowForEach: true }))).toEqual(['all', 'foreach']);
    });
});

describe('replaceLastToken', () => {
    it('replaces the occurrence just inserted, not an earlier one', () => {
        const p = `${R}.tags`;
        expect(replaceLastToken(`A {{${p}}} B {{${p}}}`, p, '{{x}}')).toBe(`A {{${p}}} B {{x}}`);
    });

    it('tolerates spaces inside the braces and leaves text without the token alone', () => {
        expect(replaceLastToken('Hi {{ a.b }}!', 'a.b', '{{c}}')).toBe('Hi {{c}}!');
        expect(replaceLastToken('Hi there', 'a.b', '{{c}}')).toBe('Hi there');
    });
});

describe('hasToken', () => {
    it('finds the token with or without spaces, and not a longer path', () => {
        expect(hasToken('a {{ x.y }} b', 'x.y')).toBe(true);
        expect(hasToken('a {{x.y.z}} b', 'x.y')).toBe(false);
        expect(hasToken('', 'x.y')).toBe(false);
    });
});
