// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { resolveBuildScreen, screenOfNode } from './buildScreenTarget';

const DEF = {
    screens: [
        { id: 'scr_a', name: 'Home', sections: [{ id: 'sec_a1', children: [{ id: 'cmp_card', type: 'card', children: [{ id: 'cmp_in', type: 'input_text' }] }] }] },
        { id: 'scr_b', name: 'Suppliers', sections: [{ id: 'sec_b1', children: [] }] },
    ],
    actions: { act_1: { kind: 'toast', message: 'x' } },
};

describe('screenOfNode', () => {
    it('a screen id is itself; a section and a nested component resolve to their screen; anything else is null', () => {
        expect(screenOfNode(DEF, 'scr_b')).toBe('scr_b');
        expect(screenOfNode(DEF, 'sec_b1')).toBe('scr_b');
        expect(screenOfNode(DEF, 'cmp_in')).toBe('scr_a');
        expect(screenOfNode(DEF, 'cmp_card')).toBe('scr_a');
        expect(screenOfNode(DEF, 'act_1')).toBeNull();
        expect(screenOfNode(DEF, 'nope')).toBeNull();
        expect(screenOfNode(null, 'scr_a')).toBeNull();
    });
});

describe('resolveBuildScreen', () => {
    it('the batch being typed wins — its parent names the screen before anything lands', () => {
        const r = resolveBuildScreen({
            definition: DEF,
            toolDraft: { name: 'app_add_components', parentId: 'sec_b1', items: [] },
            lastCall: { name: 'app_add_screen', added: [{ id: 'scr_a', type: 'screen' }] },
            reveal: { plan: { ids: ['cmp_in'], screens: [] } },
        });
        expect(r).toEqual({ id: 'scr_b', name: 'Suppliers', reason: 'typing' });
        // A container parent resolves through its screen too.
        expect(resolveBuildScreen({ definition: DEF, toolDraft: { parentId: 'cmp_card' } }).id).toBe('scr_a');
    });

    it('a screen the last call added is the chapter — once it exists in the definition; else the plan\'s new screens', () => {
        expect(resolveBuildScreen({ definition: DEF, lastCall: { name: 'app_add_screen', added: [{ id: 'scr_b', type: 'screen', label: 'Suppliers' }] } })).toEqual({ id: 'scr_b', name: 'Suppliers', reason: 'screen' });
        // Not in the definition yet (the tool_call arrived a chunk before its draft): nothing, not a guess.
        expect(resolveBuildScreen({ definition: DEF, lastCall: { added: [{ id: 'scr_new', type: 'screen' }] } })).toBeNull();
        expect(resolveBuildScreen({ definition: DEF, reveal: { plan: { ids: [], screens: ['scr_new', 'scr_b'] } } }).id).toBe('scr_b');
    });

    it('otherwise the first revealed id that sits on a screen — actions are skipped; nothing resolvable is null', () => {
        expect(resolveBuildScreen({ definition: DEF, reveal: { plan: { ids: ['act_1', 'cmp_in'], screens: [] } } })).toEqual({ id: 'scr_a', name: 'Home', reason: 'landed' });
        expect(resolveBuildScreen({ definition: DEF, reveal: { plan: { ids: ['act_1'], screens: [] } } })).toBeNull();
        expect(resolveBuildScreen({ definition: DEF, lastCall: { name: 'app_set_theme', added: [] } })).toBeNull();
        expect(resolveBuildScreen({ definition: null, toolDraft: { parentId: 'sec_b1' } })).toBeNull();
        expect(resolveBuildScreen()).toBeNull();
    });
});
