/**
 * "Flatten a list" through the phone's copy of the engine.
 *
 * FLATTEN_CASES in agent-hub/src/shared/expr/corpus.mjs is the contract the
 * server and the web assert against. Each case runs here through the vendored
 * flattenRows and through the web's own, so a green here is "the phone makes
 * the same rows as the run", not just "the same rows as the file says".
 */

import { flattenPlan, flattenRows, listNounKey, routeLevels } from './index';
import type { FlattenOutput, FlattenStepLike } from './index';

interface FlattenCase {
    name: string;
    root: unknown;
    step: FlattenStepLike;
    opts?: { limit?: number };
    expect: Record<string, unknown>;
}
interface Corpus {
    FLATTEN_CASES: FlattenCase[];
    FLATTEN_MAIL_STEP: FlattenStepLike & { id: string; parents: unknown[] };
    flattenMailRoot: () => unknown;
}
// eslint-disable-next-line @typescript-eslint/no-require-imports
const corpus = require('../../../../agent-hub/src/shared/expr/corpus.mjs') as Corpus;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const web = require('../../../../agent-hub/src/shared/expr/index.mjs') as { flattenRows: typeof flattenRows };

/** One corpus expectation against an output (`keys`, `first`, `last`, `rowN`, else the output key). */
function expected(out: FlattenOutput, key: string): unknown {
    if (key === 'keys') return Object.keys(out.items[0] ?? {});
    if (key === 'first') return out.items[0];
    if (key === 'last') return out.items[out.items.length - 1];
    if (key.startsWith('row')) return out.items[Number(key.slice(3))];
    return (out as unknown as Record<string, unknown>)[key];
}

describe('the flatten corpus', () => {
    it('is loaded, and is not empty', () => {
        expect(corpus.FLATTEN_CASES.length).toBeGreaterThan(8);
    });

    it.each(corpus.FLATTEN_CASES.map((c) => [c.name, c] as const))('%s', (_label, c) => {
        const out = flattenRows(c.root, c.step, c.opts);
        expect(out).not.toBeNull();
        for (const [key, want] of Object.entries(c.expect)) expect([key, expected(out as FlattenOutput, key)]).toEqual([key, want]);
        expect(out).toEqual(web.flattenRows(c.root, c.step, c.opts));
    });
});

describe('the helpers the flow editor reads', () => {
    const root = corpus.flattenMailRoot();
    const step = corpus.FLATTEN_MAIL_STEP;

    it('plans the mail table the same way the server does', () => {
        expect(flattenPlan(root, step.arrayRef as string).parents).toEqual(step.parents);
    });

    it('offers the attachments as the level inside the messages', () => {
        const levels = routeLevels('steps.g_read_many.output.messages', root);
        expect(levels.map((l) => [l.key, l.count, l.records])).toEqual([
            ['messages', 4, true],
            ['attachments', 64, true],
        ]);
    });

    it('names the rows of a filter after a flatten by the flatten', () => {
        const definition = { steps: [step, { id: 'f', type: 'filter', arrayRef: 'steps.mf_flatten.output.items' }] };
        expect(listNounKey(definition, 'steps.f.output.items')).toBe('attachments');
    });
});
