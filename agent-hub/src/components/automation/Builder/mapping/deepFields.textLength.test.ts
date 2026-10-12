// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getPath } from '@shared/expr/path.mjs';
import { autoMapInputs as autoMapInputsJs } from './autoMapInputs';
import { deepValueFields, listSources, mergeElementSamples, walkDeep } from './deepFields';
import { buildRealOutputMap } from './realOutputs';
import { computeUpstreamGroups as computeUpstreamGroupsJs } from './upstream';

/**
 * `.length` of a string is the string's length at run time (path.mjs
 * stepInto), never a `length` key of the JSON the text encodes. Auto-map and
 * the list pickers read data through walkDeep, so they must not offer such a
 * key either: auto-map used to bind `body.length` (previewed 120, ran as 28).
 */
type Patch = Record<string, { kind: string; path: string }>;
const autoMapInputs = (...a: Parameters<typeof autoMapInputsJs>) => autoMapInputsJs(...a) as Patch;
// The JS module's `= null` default reads as the parameter's whole type in TS.
const computeUpstreamGroups = computeUpstreamGroupsJs as (...args: unknown[]) => Parameters<typeof autoMapInputsJs>[2];

const BODY = '{"length": 120, "width": 40}';

describe('a `length` key inside JSON text', () => {
    it('is not offered as a value; every offered path previews what the run reads', () => {
        const root = { x: BODY };
        const fields = deepValueFields(BODY, 'x');
        expect(fields.map(f => f.path)).toEqual(['x.width']);
        for (const f of fields) expect(getPath(root, f.path)).toEqual(f.value);
        // The run reads the text's own length there, not 120.
        expect(getPath(root, 'x.length')).toBe(BODY.length);
    });

    it('is not offered under a list of JSON-text rows either, and the merged element has no such key', () => {
        const rows = ['{"length":5,"name":"a"}', '{"length":7,"name":"b"}'];
        const seen: string[] = [];
        walkDeep({ rows }, 'r', n => seen.push(n.path));
        expect(seen).toContain('r.rows[*].name');
        expect(seen).not.toContain('r.rows[*].length');
        expect(mergeElementSamples(rows)).toEqual({ name: 'a' });
        expect(listSources({ rows }, 'r').find(s => s.path === 'r.rows')?.element).toEqual({ name: 'a' });
    });

    it('a real record keeps its `length` key: only text hides it', () => {
        const fields = deepValueFields({ length: 120, width: 40 }, 'x');
        expect(fields.map(f => f.path)).toEqual(['x.length', 'x.width']);
        // Text one level down: the record's own key stays, the text's is hidden.
        const nested = deepValueFields({ length: 3, meta: '{"length":9,"unit":"cm"}' }, 'x').map(f => f.path);
        expect(nested).toContain('x.length');
        expect(nested).toContain('x.meta.unit');
        expect(nested).not.toContain('x.meta.length');
    });

    it('auto-map binds only what the run resolves to the previewed value', () => {
        const def = {
            trigger: { id: 'trg', kind: 'manual' },
            steps: [
                { id: 'http', type: 'http_request', url: 'https://x', method: 'GET' },
                { id: 'dst', type: 'integration_action', tool: 'unknown', inputs: {} },
            ],
            edges: [{ from: 'trg', to: 'http' }, { from: 'http', to: 'dst' }],
        };
        const output = { status: 200, body: BODY };
        const real = buildRealOutputMap(def, [{ stepId: 'http', output }]);
        const groups = computeUpstreamGroups(def, 'dst', { apps: [] }, real);
        const patch = autoMapInputs({ properties: { length: { type: 'number' }, width: { type: 'number' } } }, {}, groups);
        expect(patch.width?.path).toBe('steps.http.output.body.width');
        expect(patch.length?.path).not.toBe('steps.http.output.body.length');
        const root = { steps: { http: { output } } };
        expect(getPath(root, patch.width.path)).toBe(40);
    });
});
