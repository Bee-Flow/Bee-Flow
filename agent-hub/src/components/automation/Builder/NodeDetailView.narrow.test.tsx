import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ComponentType } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// NDV fetches the tool catalog on mount: stub the API.
const { api } = vi.hoisted(() => ({
    api: { getCatalog: vi.fn().mockResolvedValue({ apps: [], triggerOutputs: {} }) },
}));
vi.mock('../../../hooks/useAutomationApi', () => ({ default: () => api }));

import { aiStepProps, renderInQueryClient as render } from './ndv/ndvTestProps';
import NodeDetailViewJs from './NodeDetailView';

const NodeDetailView = NodeDetailViewJs as unknown as ComponentType<Record<string, unknown>>;

/**
 * jsdom does no layout, so the drawer's own width comes from a stubbed
 * ResizeObserver: every observed element reports `width`.
 */
let width = 0;
const observers: Array<{ cb: ResizeObserverCallback; el: Element | null }> = [];
class FakeResizeObserver {
    cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) { this.cb = cb; observers.push({ cb, el: null }); }
    observe(el: Element) {
        const o = observers.find(x => x.cb === this.cb);
        if (o) o.el = el;
        this.cb([{ contentRect: { width } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
    unobserve() { /* nothing to undo */ }
    disconnect() { /* nothing to undo */ }
}
const resizeTo = (w: number) => {
    width = w;
    act(() => {
        for (const o of observers) if (o.el) o.cb([{ contentRect: { width } } as unknown as ResizeObserverEntry], {} as ResizeObserver);
    });
};

describe('NodeDetailView — the drawer fits its columns to its own width', () => {
    beforeEach(() => {
        cleanup();
        observers.length = 0;
        try { localStorage.clear(); } catch { /* ignore */ }
        vi.stubGlobal('ResizeObserver', FakeResizeObserver);
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('on a laptop shows the settings with ONE side column, and the toggles switch which', async () => {
        const user = userEvent.setup();
        width = 1280;
        render(<NodeDetailView {...aiStepProps()} />);
        expect(screen.getByTestId('ndv-col-input')).toBeTruthy();
        expect(screen.queryByTestId('ndv-col-output')).toBeNull();

        await user.click(screen.getByRole('button', { name: 'Show output' }));
        expect(screen.getByTestId('ndv-col-output')).toBeTruthy();
        expect(screen.queryByTestId('ndv-col-input')).toBeNull();

        // Hiding the one on screen does not bring the other back.
        await user.click(screen.getByRole('button', { name: 'Hide output' }));
        expect(screen.queryByTestId('ndv-col-output')).toBeNull();
        expect(screen.queryByTestId('ndv-col-input')).toBeNull();
        expect(screen.getByTestId('ndv-col-params')).toBeTruthy();
    });

    it('turns to Continues on when Test step is pressed, where the answer lands', async () => {
        const user = userEvent.setup();
        width = 1280;
        const onExecuteStep = vi.fn();
        render(<NodeDetailView {...aiStepProps({ onExecuteStep })} />);
        await user.click(screen.getAllByRole('button', { name: /Test step/ })[0]);
        expect(onExecuteStep).toHaveBeenCalledWith('s1');
        expect(screen.getByTestId('ndv-col-output')).toBeTruthy();
    });

    it('brings both side columns back when the drawer gets the room', async () => {
        width = 1280;
        render(<NodeDetailView {...aiStepProps()} />);
        expect(screen.queryByTestId('ndv-col-output')).toBeNull();
        resizeTo(1920);
        expect(screen.getByTestId('ndv-col-input')).toBeTruthy();
        expect(screen.getByTestId('ndv-col-output')).toBeTruthy();
    });
});
