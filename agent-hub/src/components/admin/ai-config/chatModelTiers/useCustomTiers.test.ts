// The global custom tiers. Pinned: the id follows the name, but a name that
// matches (or passes) another tier's never puts two tiers on one id, since
// every edit finds its tier by id.
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import useCustomTiers from './useCustomTiers';
import type { CustomTier } from './tierTypes';

const FAST = { id: 'custom:fast', label: 'Fast', modelId: 'm1' } as CustomTier;

function setup() {
    const view = renderHook(() => useCustomTiers(async () => true));
    act(() => { view.result.current.setCustomTiers([FAST]); });
    act(() => { view.result.current.addCustomTier(); });
    return view;
}
const typed = (view: ReturnType<typeof setup>, text: string) => {
    // One keystroke at a time, the way the name field calls it.
    for (let i = 1; i <= text.length; i += 1) {
        const tier = view.result.current.customTiers[1];
        act(() => { view.result.current.renameCustomTier(tier.id, text.slice(0, i)); });
    }
};

describe('useCustomTiers rename', () => {
    it('leaves the other tier alone when a name passes through it', () => {
        const view = setup();
        typed(view, 'Faster');
        expect(view.result.current.customTiers.map(t => [t.id, t.label])).toEqual([['custom:fast', 'Fast'], ['custom:faster', 'Faster']]);
        expect(view.result.current.expandedCustomId).toBe('custom:faster');
    });

    it('keeps two tiers of the same name on ids of their own', () => {
        const view = setup();
        typed(view, 'Fast');
        const [first, second] = view.result.current.customTiers;
        expect([first.label, second.label]).toEqual(['Fast', 'Fast']);
        expect(first.id).toBe('custom:fast');
        expect(second.id).not.toBe(first.id);
        // An edit of the second one reaches only the second one.
        act(() => { view.result.current.updateCustomTier(second.id, { modelId: 'm2' }); });
        expect(view.result.current.customTiers.map(t => t.modelId)).toEqual(['m1', 'm2']);
    });
});
