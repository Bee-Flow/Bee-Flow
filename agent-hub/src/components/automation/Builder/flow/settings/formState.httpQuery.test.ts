import { describe, expect, it } from 'vitest';
import { buildPatch as buildPatchJs, extractFormState as extractFormStateJs } from './formState';

// formState.js is untyped JavaScript, so its return values infer as `{}`.
type Shape = Record<string, unknown>;
const extractFormState = (s: Shape) => extractFormStateJs(s) as Shape;
const buildPatch = (s: Shape, d: Shape) => buildPatchJs(s, d) as Shape;

describe('http_request query in the form state', () => {
    const step = { id: 'h', type: 'http_request', url: 'https://x.example/a', method: 'GET' };
    it('loads query into the draft, null when absent', () => {
        expect(extractFormState(step).query).toBeNull();
        const q = { mode: 'json', json: '{"a":1}' };
        expect(extractFormState({ ...step, query: q }).query).toEqual(q);
    });
    it('saves query, and leaves it out when off', () => {
        const q = { mode: 'fields', items: [{ key: 'a', value: '1' }] };
        expect(buildPatch(step, { ...extractFormState(step), query: q }).query).toEqual(q);
        expect(buildPatch({ ...step, query: q }, { ...extractFormState(step), query: null }).query).toBeUndefined();
    });
});
