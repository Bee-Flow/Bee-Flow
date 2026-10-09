import { describe, expect, it } from 'vitest';
import { mergeMovedQuery, parseJsonWithBindings, previewUrl, queryPairs, splitQueryFromUrl, type HttpQuery } from './httpQueryLib';

const OWNER = 'builder%5B0%5D%5BorderByDesc%5D=created_at&builder%5B1%5D%5Bwith%5D%5B0%5D=categories&builder%5B2%5D%5Bpaginate%5D=5';
const OWNER_JSON = '{"builder":[{"orderByDesc":"created_at"},{"with":["categories"]},{"paginate":5}]}';

describe('previewUrl', () => {
    it('serialises the owner example exactly like the runtime', () => {
        expect(previewUrl('https://x.example/api/tickets', { mode: 'json', json: OWNER_JSON })).toBe(`https://x.example/api/tickets?${OWNER}`);
    });

    it('keeps bindings readable and bare ones typed as values', () => {
        const q: HttpQuery = { mode: 'json', json: '{"paginate":{{steps.a.output.n}},"t":"{{trigger.output.t}}"}' };
        expect(previewUrl('https://x.example/a', q)).toBe('https://x.example/a?paginate={{steps.a.output.n}}&t={{trigger.output.t}}');
    });

    it('renders every array format', () => {
        const json = '{"a":["x","y"]}';
        expect(previewUrl('https://h/a', { mode: 'json', json, arrayFormat: 'brackets' })).toBe('https://h/a?a%5B%5D=x&a%5B%5D=y');
        expect(previewUrl('https://h/a', { mode: 'json', json, arrayFormat: 'repeat' })).toBe('https://h/a?a=x&a=y');
        expect(previewUrl('https://h/a', { mode: 'json', json, arrayFormat: 'comma' })).toBe('https://h/a?a=x%2Cy');
        expect(previewUrl('https://h/a', { mode: 'json', json })).toBe('https://h/a?a%5B0%5D=x&a%5B1%5D=y');
    });

    it('merges with the URL query, the step winning, and drops empty values', () => {
        const q: HttpQuery = { mode: 'fields', items: [{ key: 'page', value: '2' }, { key: 'empty', value: '' }, { key: '', value: 'x' }] };
        expect(previewUrl('https://h/a?page=1&keep=1#top', q)).toBe('https://h/a?keep=1&page=2#top');
    });

    it('leaves the URL alone with no parameters', () => {
        expect(previewUrl('https://h/a?k=1', { mode: 'fields', items: [] })).toBe('https://h/a?k=1');
        expect(previewUrl('https://h/a', null)).toBe('https://h/a');
    });
});

describe('queryPairs', () => {
    it('reports invalid JSON and non-objects without throwing', () => {
        expect(queryPairs({ mode: 'json', json: '{oops' }).error).toBe('json');
        expect(queryPairs({ mode: 'json', json: '[1]' }).error).toBe('not_object');
        expect(queryPairs({ mode: 'json', json: '' })).toEqual({ pairs: [], error: null });
    });
});

describe('splitQueryFromUrl / mergeMovedQuery', () => {
    it('turns bracket keys back into nested JSON and round-trips through the preview', () => {
        const split = splitQueryFromUrl(`https://x.example/api/tickets?${OWNER}&page=1`)!;
        expect(split.url).toBe('https://x.example/api/tickets');
        expect(JSON.parse(split.query.json!)).toEqual({
            builder: [{ orderByDesc: 'created_at' }, { with: ['categories'] }, { paginate: '5' }], page: '1',
        });
        expect(previewUrl(split.url, split.query)).toBe(`https://x.example/api/tickets?${OWNER}&page=1`);
    });

    it('returns null without a query', () => {
        expect(splitQueryFromUrl('https://x.example/a')).toBeNull();
        expect(splitQueryFromUrl('https://x.example/a?')).toBeNull();
    });

    it('merges into existing rows and JSON, and refuses JSON holding bindings', () => {
        const moved = splitQueryFromUrl('https://h/a?x=1&y=2')!.query;
        const rows = mergeMovedQuery({ mode: 'fields', items: [{ key: 'x', value: 'mine' }] }, moved)!;
        expect(rows.items).toEqual([{ key: 'y', value: '2' }, { key: 'x', value: 'mine' }]);
        const json = mergeMovedQuery({ mode: 'json', json: '{"x":"mine"}' }, moved)!;
        expect(JSON.parse(json.json!)).toEqual({ x: 'mine', y: '2' });
        expect(mergeMovedQuery({ mode: 'json', json: '{"x":{{steps.a.output.n}}}' }, moved)).toBeNull();
        expect(mergeMovedQuery(null, moved)).toBe(moved);
    });
});

describe('parseJsonWithBindings', () => {
    it('is null for broken JSON', () => {
        expect(parseJsonWithBindings('{"a":')).toBeNull();
    });
});
