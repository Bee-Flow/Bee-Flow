// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { getPath } from '@shared/expr/path.mjs';
import { computeUpstreamGroups as computeUpstreamGroupsJs, collectArrayPaths as collectArrayPathsJs } from './index';
import { buildRealOutputMap, buildSampleRoot } from '../realOutputs';
import { loopListChoices } from '../loopLists';
import type { UpstreamGroup } from '../deepFields';

/**
 * The lists the Loop picker and the collection editors offer for a Code step
 * that runs once per item. Its output is the runner's forEach envelope
 * (execForEachStep: `{ iterations, succeeded, failed, results: [{ index,
 * item, output: { result, logs, httpCalls }, status }] }`), never a `result`
 * envelope of its own: `steps.code.output.result.results` resolves to nothing,
 * and `…output.logs` is the diagnostics list, not data.
 */
type Field = { key: string; path: string; sample: unknown };
const computeUpstreamGroups = computeUpstreamGroupsJs as (...args: unknown[]) => UpstreamGroup[];
const collectArrayPaths = collectArrayPathsJs as (...args: unknown[]) => Field[];

const CATALOG = { apps: [{ actions: [{ name: 'list_tool', outputSample: { items: [{ id: 1 }] } }] }], triggerOutputs: {} };

function def(code: object) {
    return {
        trigger: { id: 'trg', kind: 'manual' },
        steps: [
            { id: 'src', type: 'integration_action', tool: 'list_tool' },
            { id: 'code', type: 'code', ...code },
            { id: 'dst', type: 'notification', title: 'x' },
        ],
        edges: [{ from: 'trg', to: 'src' }, { from: 'src', to: 'code' }, { from: 'code', to: 'dst' }],
    };
}
const PER_ITEM = { forEach: { overRef: 'steps.src.output.items', itemVar: 'item' } };
const ENVELOPE = {
    iterations: 2, succeeded: 2, failed: 0,
    results: [
        { index: 0, item: { id: 1 }, output: { result: { rows: [{ a: 1 }] }, logs: ['hi'], httpCalls: 0 }, status: 'success' },
        { index: 1, item: { id: 2 }, output: { result: { rows: [{ a: 2 }] }, logs: [], httpCalls: 0 }, status: 'success' },
    ],
};

/** Every list offered for `code`, by both pickers. */
function offered(definition: object, runOutput?: unknown) {
    const real = runOutput === undefined ? null : buildRealOutputMap(definition, [{ stepId: 'code', output: runOutput }]);
    const groups = computeUpstreamGroups(definition, 'dst', CATALOG, real);
    const root = buildSampleRoot(groups);
    const lists = [...collectArrayPaths(groups, root), ...loopListChoices(groups, root)].map(f => f.path);
    return [...new Set(lists.filter(p => p.startsWith('steps.code.')))];
}

describe('lists of a Code step that runs once per item', () => {
    it('after a run: only lists the run produces, never `result.results` or the logs', () => {
        const lists = offered(def(PER_ITEM), ENVELOPE);
        const run = { steps: { code: { output: ENVELOPE } } };
        expect(lists).toContain('steps.code.output.results[*].output.result.rows');
        for (const p of lists) {
            expect(p, p).not.toMatch(/\.result\.results|logs/);
            expect(getPath(run, p), p).not.toBeUndefined();
        }
    });

    it('before a run: no `result.results` either', () => {
        const lists = offered(def(PER_ITEM));
        const run = { steps: { code: { output: ENVELOPE } } };
        for (const p of lists) {
            expect(p, p).not.toMatch(/\.result\.results|logs/);
            expect(getPath(run, p), p).not.toBeUndefined();
        }
    });

    it('a plain Code step still offers what its code returned, and never its logs', () => {
        const out = { result: { rows: [{ a: 1 }] }, logs: ['x'], httpCalls: 0 };
        expect(offered(def({}), out)).toContain('steps.code.output.result.rows');
        // The code returned nothing (JSON drops `result`): the logs are still not data.
        expect(offered(def({}), { logs: ['x'], httpCalls: 0 })).toEqual([]);
    });
});
