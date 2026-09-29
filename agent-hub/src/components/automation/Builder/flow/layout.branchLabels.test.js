import { describe, it, expect } from 'vitest';
import { buildLayout } from './layout';

/**
 * Who names a branch: the port, or the line?
 *
 * The four brancher nodes each draw a NAMED port per outgoing branch — a
 * condition's "match"/"otherwise", a guard's "personal data"/"clean", a
 * switch's case names, a loop's "Done"/"On error". `layout.js` was also
 * stamping that same name onto the edge as `kind`, so every branch carried two
 * labels a few pixels apart and a switch with three outputs read as a mess.
 *
 * `labelledAtPort` is how the edge learns to stand down. It must be set only
 * where a port really carries the name — the cases below are the ones where it
 * does not, and where dropping the edge's chip would leave the branch unnamed.
 */
const layoutOf = (def) => buildLayout(def, { runByStep: new Map(), issuesByStep: new Map() });
const edgeTo = (def, to) => layoutOf(def).edges.find(e => e.target === to);

const trigger = { id: 'trg', type: 'trigger', kind: 'manual' };
const tail = (id) => ({ id, type: 'set' });

describe('labelledAtPort', () => {
    it('is set for a condition — the node prints match / otherwise itself', () => {
        const def = {
            trigger,
            steps: [{ id: 'c', type: 'condition' }, tail('yes'), tail('no')],
            edges: [
                { from: 'trg', to: 'c' },
                { from: 'c', to: 'yes', label: 'then' },
                { from: 'c', to: 'no', label: 'else' },
            ],
        };
        expect(edgeTo(def, 'yes').data.labelledAtPort).toBe(true);
        expect(edgeTo(def, 'no').data.labelledAtPort).toBe(true);
    });

    it('is set for a guard, whose ports say personal data / clean', () => {
        const def = {
            trigger,
            steps: [{ id: 'g', type: 'guard' }, tail('found'), tail('clean')],
            edges: [
                { from: 'trg', to: 'g' },
                { from: 'g', to: 'found', label: 'then' },
                { from: 'g', to: 'clean', label: 'else' },
            ],
        };
        expect(edgeTo(def, 'found').data.labelledAtPort).toBe(true);
        expect(edgeTo(def, 'clean').data.labelledAtPort).toBe(true);
    });

    it('is set for a switch case that still exists, and for its otherwise', () => {
        const def = {
            trigger,
            steps: [
                { id: 's', type: 'switch', cases: [{ name: 'zelf' }, { name: 'zoeken' }] },
                tail('a'), tail('b'), tail('rest'),
            ],
            edges: [
                { from: 'trg', to: 's' },
                { from: 's', to: 'a', caseName: 'zelf' },
                { from: 's', to: 'b', caseName: 'zoeken' },
                { from: 's', to: 'rest', caseName: 'default' },
            ],
        };
        expect(edgeTo(def, 'a').data.labelledAtPort).toBe(true);
        expect(edgeTo(def, 'b').data.labelledAtPort).toBe(true);
        expect(edgeTo(def, 'rest').data.labelledAtPort).toBe(true);
    });

    it('is NOT set for a switch case the author has since deleted', () => {
        // SwitchNode draws handles only for cases that still exist, so this
        // edge has no port chip behind it — its own is the last label it has.
        const def = {
            trigger,
            steps: [{ id: 's', type: 'switch', cases: [{ name: 'zelf' }] }, tail('ghost')],
            edges: [
                { from: 'trg', to: 's' },
                { from: 's', to: 'ghost', caseName: 'verwijderd' },
            ],
        };
        expect(edgeTo(def, 'ghost').data.labelledAtPort).toBe(false);
        expect(edgeTo(def, 'ghost').data.kind).toBe('verwijderd');
    });

    it('is set for a loop, which owns a Done and an On error port', () => {
        const def = {
            trigger,
            steps: [{ id: 'l', type: 'loop' }, tail('after'), tail('boom')],
            edges: [
                { from: 'trg', to: 'l' },
                { from: 'l', to: 'after' },
                { from: 'l', to: 'boom', label: 'on_error' },
            ],
        };
        expect(edgeTo(def, 'boom').data.labelledAtPort).toBe(true);
    });

    it('is NOT set for an on_error out of an ordinary step — it has no port of its own', () => {
        const def = {
            trigger,
            steps: [{ id: 'a', type: 'ai_step' }, tail('boom')],
            edges: [
                { from: 'trg', to: 'a' },
                { from: 'a', to: 'boom', label: 'on_error' },
            ],
        };
        const edge = edgeTo(def, 'boom');
        expect(edge.data.labelledAtPort).toBe(false);
        expect(edge.data.kind).toBe('on_error');
    });

    it('is NOT set for an unrouted edge — that chip is a warning, not a name', () => {
        // An unlabelled line out of a brancher: the runtime never follows it,
        // and there is no port it belongs to. Suppressing its chip would hide
        // the only thing saying so.
        const def = {
            trigger,
            steps: [{ id: 'c', type: 'condition' }, tail('nowhere')],
            edges: [
                { from: 'trg', to: 'c' },
                { from: 'c', to: 'nowhere' },
            ],
        };
        const edge = edgeTo(def, 'nowhere');
        expect(edge.data.kind).toBe('unrouted');
        expect(edge.data.labelledAtPort).toBe(false);
    });

    it('is NOT set for a plain step-to-step connection', () => {
        const def = {
            trigger,
            steps: [tail('a'), tail('b')],
            edges: [{ from: 'trg', to: 'a' }, { from: 'a', to: 'b' }],
        };
        expect(edgeTo(def, 'b').data.labelledAtPort).toBe(false);
    });
});
