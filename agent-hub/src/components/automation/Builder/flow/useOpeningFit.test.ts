import { renderHook } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactFlowState } from '@xyflow/react';
import { describe, expect, it, vi } from 'vitest';
import { selectMeasuredIds, useOpeningFit } from './useOpeningFit';

/**
 * A builder opened by navigation mounts on a placeholder and hydrates the real
 * definition a moment later (the Step builder: trigger + return, then the
 * block's three cards). React Flow's one mount fit framed the placeholder at
 * 200%, with the real cards off screen. The opening fit frames each new set of
 * cards once they are all measured, until the person does anything, and never
 * while something else owns the camera.
 */

type Lookup = Pick<ReactFlowState, 'nodeLookup'>;
const lookup = (nodes: Array<{ id: string; w?: number; h?: number; hidden?: boolean }>): Lookup => ({
    nodeLookup: new Map(nodes.map(n => [n.id, { id: n.id, hidden: n.hidden, measured: { width: n.w, height: n.h } }])) as unknown as Lookup['nodeLookup'],
});

describe('selectMeasuredIds', () => {
    it('is the visible ids once every one is measured, null before', () => {
        expect(selectMeasuredIds(lookup([]))).toBeNull();
        expect(selectMeasuredIds(lookup([{ id: 'trg', w: 240, h: 72 }, { id: 'find' }]))).toBeNull();
        expect(selectMeasuredIds(lookup([{ id: 'out', w: 240, h: 72 }, { id: 'trg', w: 240, h: 72 }, { id: 'x', hidden: true }])))
            .toBe('out\ntrg');
    });
});

describe('useOpeningFit', () => {
    const mount = (enabled = true) => {
        const fit = vi.fn();
        const hook = renderHook(
            ({ measuredKey, on }: { measuredKey: string | null; on: boolean }) => useOpeningFit({ measuredKey, fit, enabled: on }),
            { initialProps: { measuredKey: null as string | null, on: enabled } },
        );
        return { fit, rerender: (measuredKey: string | null, on = enabled) => hook.rerender({ measuredKey, on }) };
    };

    it('frames the placeholder, then the hydrated cards once they are measured, and nothing twice', () => {
        const { fit, rerender } = mount();
        rerender('out\ntrg');
        expect(fit).toHaveBeenCalledTimes(1);
        expect(fit).toHaveBeenLastCalledWith({ duration: 0 });
        rerender(null); // the new card is not measured yet
        rerender('find\nout\ntrg');
        expect(fit).toHaveBeenCalledTimes(2);
        rerender('find\nout\ntrg');
        expect(fit).toHaveBeenCalledTimes(2);
    });

    it('stops at the first thing the person does', async () => {
        const user = userEvent.setup();
        const { fit, rerender } = mount();
        rerender('trg');
        expect(fit).toHaveBeenCalledTimes(1);
        await user.click(document.body);
        rerender('a\ntrg');
        expect(fit).toHaveBeenCalledTimes(1);
    });

    it('never moves a camera something else owns, and a build that ends does not re-fit its result', () => {
        const { fit, rerender } = mount(false);
        rerender('trg', false);
        rerender('a\ntrg', false);
        rerender('a\ntrg', true);
        rerender('a\nb\ntrg', true);
        expect(fit).not.toHaveBeenCalled();
    });
});
