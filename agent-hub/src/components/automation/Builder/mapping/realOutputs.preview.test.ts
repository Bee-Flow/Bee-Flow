// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getPath } from '@shared/expr/path.mjs';
import { buildRealOutputMap } from './realOutputs';
import { computeUpstreamGroups as computeUpstreamGroupsJs } from './upstream';
import { eachField, type Field } from './upstream/fieldTree';

const computeUpstreamGroups = computeUpstreamGroupsJs as (...args: unknown[]) => Array<{ id: string; fields: Field[] }>;

/**
 * An output over the server's size cap is replaced by a sentinel. The
 * sentinel now carries a SHAPE-PRESERVING `preview` (every level kept, long
 * lists cut to their first items): the builder reads that as the step's real
 * output, so the deep fields of a big payload stay pickable. A sentinel
 * without one is still not data.
 */
const PREVIEW = { value: [{ id: 'm1', from: { emailAddress: { address: 'ada@example.com' } } }], '@odata.nextLink': 'https://x' };
const SENTINEL = { __truncated__: true, originalBytes: 2_400_000, headSample: '{"value":[', preview: PREVIEW, previewCut: { value: 500 } };
const BARE = { __truncated__: true, originalBytes: 2_400_000, headSample: '{"value":[' };

const DEF = {
    trigger: { id: 'trg', kind: 'manual' },
    steps: [
        { id: 'big', type: 'integration_action', tool: 'x' },
        { id: 'pin', type: 'integration_action', tool: 'x', pinnedOutput: SENTINEL },
        { id: 'bare', type: 'integration_action', tool: 'x' },
        { id: 'dst', type: 'notification', title: 't' },
    ],
    edges: [{ from: 'trg', to: 'big' }, { from: 'big', to: 'pin' }, { from: 'pin', to: 'bare' }, { from: 'bare', to: 'dst' }],
};

describe('a truncated output with a preview', () => {
    it('is read as the step real output, from a run row or a pin', () => {
        const map = buildRealOutputMap(DEF, [{ stepId: 'big', output: SENTINEL }, { stepId: 'bare', output: BARE }]);
        expect(map.get('big')).toBe(PREVIEW);
        expect(map.get('pin')).toBe(PREVIEW);
        expect(map.has('bare')).toBe(false);
    });

    it('keeps its deep fields pickable, with paths that resolve on the preview', () => {
        const map = buildRealOutputMap(DEF, [{ stepId: 'big', output: SENTINEL }]);
        const g = computeUpstreamGroups(DEF, 'dst', { apps: [], triggerOutputs: {} }, map).find((x: { id: string }) => x.id === 'big');
        const paths: string[] = [];
        eachField(g?.fields, f => paths.push(f.path));
        expect(paths).toContain('steps.big.output.value[*].from.emailAddress.address');
        expect(getPath({ steps: { big: { output: PREVIEW } } }, 'steps.big.output.value[*].from.emailAddress.address')).toEqual(['ada@example.com']);
    });
});
