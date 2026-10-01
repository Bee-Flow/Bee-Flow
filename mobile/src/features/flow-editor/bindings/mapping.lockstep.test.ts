/**
 * DIFFERENTIAL lockstep for the smaller agent-hub `Builder/mapping/*` modules:
 * each port runs beside its original on the same inputs. When this fails the
 * web side changed — update the port, don't loosen the test.
 *
 * The ports of the web's list, mismatch, key-path, field-kind and preview
 * helpers are gone (the shared mapping core does that work on both sides,
 * held to the server by shared/mapping/corpus.test.ts), and with them their
 * blocks here.
 */

import * as bd from './boundPaths';
import * as ff from './filterFields';
import { isEmptyBinding, partitionInputs } from './partitionInputs';
import * as ro from './realOutputs';
import { CATALOG, chainDefinition } from './testing/fixture';
import { BUILDER, requireWeb } from './testing/web';
import type { VariableGroup } from './types';
import { computeUpstreamGroups } from './upstream';

const m = (name: string) => requireWeb(`${BUILDER}/mapping/${name}.js`);

describe('partitionInputs', () => {
    const web = m('partitionInputs');
    it('partitions the fixture schemas like the web', () => {
        for (const app of CATALOG.apps || []) {
            for (const action of app.actions || []) {
                const schema = action?.inputSchema;
                const req = new Set(schema?.required || []);
                for (const inputs of [{}, { maxResults: { kind: 'literal', value: 5 } }, null]) {
                    expect(partitionInputs(schema?.properties, req, inputs)).toStrictEqual(
                        web.partitionInputs?.(schema?.properties, req, inputs),
                    );
                }
            }
        }
        expect(partitionInputs(null, null)).toStrictEqual(web.partitionInputs?.(null, null));
        expect(partitionInputs({ a: {}, b: { 'x-advanced': true } }, new Set())).toStrictEqual(
            web.partitionInputs?.({ a: {}, b: { 'x-advanced': true } }, new Set()),
        );
    });

    it.each([null, undefined, 'x', 0, { kind: 'literal', value: '' }, { kind: 'literal', value: 0 }, { kind: 'ref' },
        { kind: 'ref', path: 'a' }, { kind: 'expr' }, { kind: 'template', value: 'x' }, { kind: 'other' }])('isEmptyBinding(%p)', (b) => {
        expect(isEmptyBinding(b)).toBe(web.isEmptyBinding?.(b));
    });
});

describe('filterFields / boundPaths', () => {
    const groups = computeUpstreamGroups(chainDefinition(), 'last', CATALOG);

    it.each(['', 'subj', 'RESULTS', 'steps.search', 'gmail', 'zzz', ' trigger '])('filter %p', (q) => {
        expect(ff.filterGroups(groups, q)).toStrictEqual(m('filterFields').filterGroups?.(groups, q));
        const fields = (groups[3] as VariableGroup).fields;
        expect(ff.filterFields(fields, q)).toStrictEqual(m('filterFields').filterFields?.(fields, q));
    });

    it('filters nothing out of nothing', () => {
        expect(ff.filterGroups(null, 'x')).toStrictEqual(m('filterFields').filterGroups?.(null, 'x'));
        expect(ff.filterFields(null, '')).toStrictEqual(m('filterFields').filterFields?.(null, ''));
    });

    it('bound paths and empty slots', () => {
        const web = m('boundPaths');
        const step = {
            id: 'x', label: 'steps.fake.output', position: { x: 1 },
            inputs: { a: { kind: 'ref', path: 'steps.s1.output.results[*].subject' }, b: { kind: 'template', value: 'Hi {{trigger.output.name}}' }, c: { kind: 'literal', value: ' ' }, d: '' },
            fields: { e: { kind: 'expr', value: 'loop.item.x + 1' }, f: { kind: 'ref' }, g: 3, h: { kind: 'other' } },
        };
        const used = bd.usedPathsIn(step);
        expect(used).toStrictEqual(web.usedPathsIn?.(step));
        expect(bd.usedPathsIn(null)).toStrictEqual(web.usedPathsIn?.(null));
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(bd.usedPathsIn(cyclic)).toStrictEqual(web.usedPathsIn?.(cyclic));
        for (const p of ['steps.s1.output.results', 'steps.s1.output', 'trigger.output.name', 'nope', '']) {
            expect(bd.pathInUse(p, used)).toBe(web.pathInUse?.(p, used));
        }
        const fields = (groups[3] as VariableGroup).fields;
        expect(bd.countInUse(fields, new Set(['steps.search.output.results[*].x']))).toBe(
            web.countInUse?.(fields, new Set(['steps.search.output.results[*].x'])),
        );
        expect(bd.countInUse(fields, null)).toBe(web.countInUse?.(fields, null));
        for (const opts of [undefined, { inputSchema: { required: ['a', 'z'] } }, { schemaKnown: false }]) {
            expect(bd.emptySlotsIn(step as never, opts)).toStrictEqual(web.emptySlotsIn?.(step, opts));
        }
        expect(bd.emptySlotsIn({ inputs: [] } as never)).toStrictEqual(web.emptySlotsIn?.({ inputs: [] }));
    });
});

describe('realOutputs', () => {
    const web = m('realOutputs');
    it('overlay, maps and sample roots', () => {
        const pairs: [unknown, unknown][] = [[{ a: 1, b: { c: 1 } }, { b: { d: 2 }, e: [1] }], [null, { a: 1 }], [{ a: 1 }, 'x'], [[1], { a: 1 }], [{ a: 1 }, null]];
        for (const [base, real] of pairs) expect(ro.deepOverlay(base, real)).toStrictEqual(web.deepOverlay?.(base, real));
        for (const v of [null, {}, { __truncated__: true }, { __truncated__: 1 }]) expect(ro.isTruncatedOutput(v)).toBe(web.isTruncatedOutput?.(v));
        expect(ro.buildRealOutputMap(null, [])).toStrictEqual(web.buildRealOutputMap?.(null, []));
        const groups = computeUpstreamGroups(chainDefinition(), 'last', CATALOG);
        const extra = [{ id: 'l', label: 'L', kind: 'loop', basePath: 'loop.row', sample: { a: 1 }, fields: [] },
            { id: 'l2', label: 'L', kind: 'loop', basePath: 'loop.', sample: null, fields: [] },
            { id: 't9', label: 'T', kind: 'trigger', basePath: 'trigger.output', sample: null, fields: [], hasRealData: true },
            { id: 't10', label: 'T', kind: 'trigger', basePath: 'trigger.output', sample: { late: 1 }, fields: [] }];
        expect(ro.buildSampleRoot([...groups, ...extra])).toStrictEqual(web.buildSampleRoot?.([...groups, ...extra]));
        expect(ro.buildSampleRoot(null)).toStrictEqual(web.buildSampleRoot?.(null));
    });
});
