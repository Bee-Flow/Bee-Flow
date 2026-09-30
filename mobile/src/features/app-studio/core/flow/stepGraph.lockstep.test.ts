/**
 * Differential lockstep: core/flow/stepGraph against the web's
 * flow/stepGraph.js. Every action in the fixtures (plus hand-made trees) goes
 * through both codecs; Msg labels are rendered to English before comparing.
 */

import * as port from './stepGraph';
import { english } from '../testing/english';
import { allFixtures } from '../testing/fixtures';
import { loadWeb } from '../testing/loadWeb';

type AnyFn = (...args: unknown[]) => unknown;
const web = loadWeb<Record<string, unknown>>('flow/stepGraph.js');

function both(name: string, ...args: unknown[]): unknown {
    const w = (web[name] as AnyFn)(...args);
    const p = ((port as unknown as Record<string, AnyFn>)[name] as AnyFn)(...args);
    expect(english(p)).toEqual(w);
    return p;
}

const EXTRA = [
    null,
    { kind: 'toast', message: 'bare' },
    { kind: 'sequence' },
    {
        kind: 'sequence',
        steps: [
            { kind: 'switch', expr: 'x', cases: [{ value: 'Paid', steps: [{ kind: 'toast', id: 'mine' }] }, { value: 0, steps: [] }, { steps: [{ kind: 'loop', steps: [{ kind: 'refresh' }] }] }], default: [{ kind: 'navigate' }] },
            'junk',
            { kind: 'condition', then: [{ kind: 'condition', then: [], else: [{ kind: 'toast' }] }], else: null },
        ],
    },
];

const actions = [...Object.values(allFixtures()).flatMap((def) => Object.values(def.actions || {})), ...EXTRA];

describe('stepGraph agrees with the web', () => {
    it.each(actions.map((a, i) => [i, a]))('action %i round-trips identically', (_i, action) => {
        const tagged = both('withStepIds', action) as Parameters<typeof port.stepsToGraph>[0];
        both('stepsToGraph', action);
        const graph = both('stepsToGraph', tagged) as ReturnType<typeof port.stepsToGraph>;
        const wGraph = (web.stepsToGraph as AnyFn)(tagged) as { nodes: unknown[]; edges: unknown[] };
        // graphToSteps reads steps back from the nodes; feed each side its own.
        const w = (web.graphToSteps as AnyFn)(wGraph.nodes, wGraph.edges);
        const p = port.graphToSteps(graph.nodes, graph.edges);
        expect(p).toEqual(w);
        // Reversed edges and a dropped edge exercise the stable sort.
        const reversed = graph.edges.map((e) => ({ ...e, from: e.to, to: e.from }));
        expect(port.graphToSteps(graph.nodes, reversed)).toEqual((web.graphToSteps as AnyFn)(wGraph.nodes, reversed));
        expect(port.graphToSteps(graph.nodes, graph.edges.slice(1))).toEqual(
            (web.graphToSteps as AnyFn)(wGraph.nodes, graph.edges.slice(1)),
        );
        both('stripStepIds', p);
        for (const a of graph.nodes) {
            for (const b of graph.nodes.slice(0, 6)) {
                both('canConnect', a.id, b.id, graph.edges, graph.nodes);
                both('canConnect', a.id, b.id, [], graph.nodes);
                both('createsCycle', a.id, b.id, graph.edges);
                both('sameScope', a.id, b.id);
            }
        }
    });

    it('agrees on the small helpers', () => {
        for (const step of [null, 'x', { kind: 'loop' }, { kind: 'switch', cases: [{ value: '' }, { value: 'A' }, null] }, { kind: 'condition' }]) {
            both('scopesOf', step);
        }
        for (const id of ['a', 'a/b', 'a/then/c', '', 42]) both('parseId', id);
        both('makeId', '', 'x');
        both('makeId', 'p', 'x');
        both('orderScope', ['a', 'b', 'c'], [{ from: 'c', to: 'a' }, { from: 'a', to: 'b' }, { from: 'b', to: 'c' }], ['b', 'a']);
        both('orderScope', ['a', 'b', 'c'], [{ from: 'c', to: 'a' }, { from: 'c', to: 'a' }, { from: 'x', to: 'a' }], ['c']);
        expect(port.SEP).toBe(web.SEP);
        expect(port.ENTRY_SUFFIX).toBe(web.ENTRY_SUFFIX);
        expect([...port.CONTAINER_KINDS]).toEqual([...(web.CONTAINER_KINDS as Set<string>)]);
        expect(Object.keys(web).filter((k) => !(k in port))).toEqual([]);
    });
});
