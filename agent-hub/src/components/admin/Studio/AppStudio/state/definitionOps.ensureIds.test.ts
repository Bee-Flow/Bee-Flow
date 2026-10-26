// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { ensureIds } from './definitionOps';

/**
 * ensureIds rewrites an `actionResult` binding when the action it names was
 * given a new id. A node can hold several such bindings; every one of them has
 * to follow, not only the first.
 */
describe('ensureIds: actionResult bindings follow a renamed action', () => {
    const def = {
        homeScreenId: 'scr_home01',
        screens: [{
            id: 'scr_home01',
            name: 'Home',
            sections: [{
                id: 'sec_main01',
                children: [{
                    id: 'cmp_table1',
                    type: 'table',
                    props: {
                        title: 'static text',
                        source: { kind: 'actionResult', actionId: 'Fetch Rows', path: 'rows' },
                        fallback: { kind: 'actionResult', actionId: 'Fetch Rows', path: 'other' },
                        keep: { kind: 'actionResult', actionId: 'act_stable1' },
                        n: 3,
                        nothing: null,
                    },
                }, {
                    id: 'cmp_plain01',
                    type: 'text',
                    props: { text: 'hi' },
                }],
            }],
        }],
        actions: {
            'Fetch Rows': { kind: 'run_automation', automationId: 'a1' },
            act_stable1: { kind: 'run_automation', automationId: 'a2' },
        },
    };

    it('rewrites every binding on the node and leaves the others alone', () => {
        const { def: out, changed } = ensureIds(def);
        expect(changed).toBe(true);
        const [newId] = Object.keys(out.actions!).filter((k) => k !== 'act_stable1');
        expect(newId).toMatch(/^act_[a-z0-9]{4,12}$/);
        const node = out.screens![0].sections![0].children![0];
        expect(node.props!.source).toEqual({ kind: 'actionResult', actionId: newId, path: 'rows' });
        expect(node.props!.fallback).toEqual({ kind: 'actionResult', actionId: newId, path: 'other' });
        expect(node.props!.keep).toEqual({ kind: 'actionResult', actionId: 'act_stable1' });
        expect(node.props!.title).toBe('static text');
        expect(node.props!.n).toBe(3);
        expect(node.props!.nothing).toBeNull();
        // The untouched sibling keeps its identity (structural sharing).
        expect(out.screens![0].sections![0].children![1]).toBe(def.screens[0].sections[0].children[1]);
        // The input is not mutated.
        expect(def.screens[0].sections[0].children[0].props.source!.actionId).toBe('Fetch Rows');
    });

    it('rewrites the event wiring of a node that carries no binding', () => {
        const wired = {
            ...def,
            screens: [{
                id: 'scr_home01',
                sections: [{ id: 'sec_main01', children: [{ id: 'cmp_btn0001', type: 'button', onClick: 'Fetch Rows', props: {} }] }],
            }],
        };
        const { def: out } = ensureIds(wired);
        const [newId] = Object.keys(out.actions!).filter((k) => k !== 'act_stable1');
        expect(out.screens![0].sections![0].children![0].onClick).toBe(newId);
    });
});
