import { act, cleanup, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import toast from '@/components/shared/Toast';
import { stub } from '@/test/mocks';
import { mount } from '@/appRuntimeHeadless';
import AppRenderer from '../AppRenderer';
import useActionRunner from '../useActionRunner';
import ClientTriggers from './ClientTriggers';
import { WatcherState } from './watcherState';
import type { AppDefinition } from '../../inspector/appDefinition';

/**
 * The client triggers of schema 3 in the browser: a screen's onOpen and timers, the app's
 * watchers, an event slot that lists several actions, and onClick on a tile. Only the live
 * run surface fires a trigger: the headless screenshot entry, the editor canvas and a bare
 * AppRenderer (the editor's preview) never do ("a screenshot must never fire an action").
 */

const toastAction = (message: string) => ({ kind: 'toast', message, tone: 'info' });

function app(extra: Record<string, unknown> = {}, nodes: unknown[] = []): AppDefinition {
    return stub<AppDefinition>({
        schemaVersion: 3,
        meta: { name: 'T', description: '', icon: 'LayoutGrid' },
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: 'scr_a',
        screens: [
            {
                id: 'scr_a', name: 'A', icon: null, showInNav: true, maxWidth: 'medium',
                events: { onOpen: 'act_open' }, timers: [{ id: 'tick', everySeconds: 5, actionId: 'act_tick' }],
                sections: [{ id: 'sec_a', style: { padding: 4, gap: 3, background: 'none' }, children: nodes }],
            },
            { id: 'scr_b', name: 'B', icon: null, showInNav: true, maxWidth: 'medium', sections: [{ id: 'sec_b', style: {}, children: [] }] },
        ],
        actions: { act_open: toastAction('opened'), act_tick: toastAction('tick'), act_watch: toastAction('changed') },
        watchers: [{ id: 'w', expr: 'vars.status', actionId: 'act_watch' }],
        ...extra,
    });
}

const card = { id: 'cmp_card', type: 'card', visible: true, props: { title: 'Open me' }, style: { span: 12 }, onClick: 'act_open', children: [
    { id: 'cmp_inner', type: 'button', visible: true, props: { label: 'Inner' }, style: {}, onClick: 'act_tick' },
] };

beforeEach(() => {
    vi.spyOn(toast, 'info').mockImplementation(() => 0);
    vi.spyOn(toast, 'error').mockImplementation(() => 0);
    vi.spyOn(toast, 'success').mockImplementation(() => 0);
});
afterEach(() => {
    cleanup();
    vi.useRealTimers();
    vi.restoreAllMocks();
});

interface HostProps { def: AppDefinition; screenId: string; params?: unknown; vars?: Record<string, unknown>; runAction: (slot: unknown) => unknown }
function Host({ def, screenId, params = {}, vars = {}, runAction }: HostProps) {
    return (
        <ClientTriggers definition={def} screenId={screenId} screenParams={params} runAction={runAction as never}
            actionState={{}} dataState={{}} vars={vars} forms={{}} currentUser={null} />
    );
}

describe('a screenshot, the editor and a bare renderer never fire a trigger', () => {
    it('the headless screenshot entry runs no onOpen, timer, watcher or tile click', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const container = document.createElement('div');
        document.body.appendChild(container);
        // Real timers for the mount (it waits two animation frames), fake ones for the minute after it.
        const { unmount } = await mount(container, { definition: app({}, [card]), screenId: 'scr_a' });
        vi.useFakeTimers();
        await act(async () => { vi.advanceTimersByTime(60_000); });
        (container.querySelector('[data-node-id="cmp_card"]') as HTMLElement).click();
        expect(toast.info).not.toHaveBeenCalled();
        expect(fetchSpy).not.toHaveBeenCalled();
        unmount();
        container.remove();
        vi.unstubAllGlobals();
    });

    it('AppRenderer in edit or run mode (the canvas and its preview) never calls runAction for a trigger', async () => {
        vi.useFakeTimers();
        for (const mode of ['edit', 'run'] as const) {
            const runAction = vi.fn();
            const { unmount } = render(<AppRenderer definition={app()} screenId="scr_a" mode={mode} runAction={runAction} />);
            await act(async () => { vi.advanceTimersByTime(30_000); });
            expect(runAction, mode).not.toHaveBeenCalled();
            unmount();
        }
    });
});

describe('the live run surface fires them', () => {
    it('onOpen runs once per visit: on the first screen, again after navigating back or with other params', async () => {
        const runAction = vi.fn();
        const def = app();
        const { rerender } = render(<Host def={def} screenId="scr_a" runAction={runAction} />);
        expect(runAction).toHaveBeenCalledTimes(1);
        expect(runAction).toHaveBeenLastCalledWith('act_open', {});
        rerender(<Host def={{ ...def }} screenId="scr_a" runAction={runAction} />);
        expect(runAction).toHaveBeenCalledTimes(1);
        rerender(<Host def={def} screenId="scr_b" runAction={runAction} />);
        rerender(<Host def={def} screenId="scr_a" runAction={runAction} />);
        expect(runAction).toHaveBeenCalledTimes(2);
        rerender(<Host def={def} screenId="scr_a" params={{ recordId: 'r2' }} runAction={runAction} />);
        expect(runAction).toHaveBeenCalledTimes(3);
    });

    it('a timer ticks while the screen is open, skips while the tab is hidden or its run is busy, stops when the screen closes', async () => {
        vi.useFakeTimers();
        let finish: () => void = () => {};
        const runAction = vi.fn((slot: unknown) => (slot === 'act_tick' ? new Promise<void>((r) => { finish = r; }) : undefined));
        const { rerender } = render(<Host def={app({ watchers: undefined })} screenId="scr_a" runAction={runAction} />);
        const ticks = () => runAction.mock.calls.filter(([s]) => s === 'act_tick').length;
        await act(async () => { vi.advanceTimersByTime(5_000); });
        expect(ticks()).toBe(1);
        await act(async () => { vi.advanceTimersByTime(10_000); });
        expect(ticks()).toBe(1); // still busy
        await act(async () => { finish(); await Promise.resolve(); });
        const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
        await act(async () => { vi.advanceTimersByTime(10_000); });
        expect(ticks()).toBe(1);
        visibility.mockReturnValue('visible');
        await act(async () => { vi.advanceTimersByTime(5_000); });
        expect(ticks()).toBe(2);
        await act(async () => { finish(); await Promise.resolve(); });
        rerender(<Host def={app({ watchers: undefined })} screenId="scr_b" runAction={runAction} />);
        await act(async () => { vi.advanceTimersByTime(30_000); });
        expect(ticks()).toBe(2);
    });

    it('a watcher runs once per change of its value, never for the first value', async () => {
        const runAction = vi.fn();
        const def = app({ screens: [{ id: 'scr_a', name: 'A', sections: [] }] });
        const { rerender } = render(<Host def={def} screenId="scr_a" vars={{ status: 'open' }} runAction={runAction} />);
        expect(runAction).not.toHaveBeenCalled();
        rerender(<Host def={def} screenId="scr_a" vars={{ status: 'open', other: 1 }} runAction={runAction} />);
        expect(runAction).not.toHaveBeenCalled();
        rerender(<Host def={def} screenId="scr_a" vars={{ status: 'closed' }} runAction={runAction} />);
        expect(runAction).toHaveBeenCalledTimes(1);
        expect(runAction).toHaveBeenLastCalledWith('act_watch', {});
    });

    it('debounceMs waits for quiet, and a watcher that runs too often is paused with a notice', async () => {
        vi.useFakeTimers();
        const runAction = vi.fn();
        const def = app({ screens: [{ id: 'scr_a', name: 'A', sections: [] }], watchers: [{ id: 'w', expr: 'vars.n', actionId: 'act_watch', debounceMs: 300 }] });
        const { rerender } = render(<Host def={def} screenId="scr_a" vars={{ n: 0 }} runAction={runAction} />);
        rerender(<Host def={def} screenId="scr_a" vars={{ n: 1 }} runAction={runAction} />);
        rerender(<Host def={def} screenId="scr_a" vars={{ n: 2 }} runAction={runAction} />);
        expect(runAction).not.toHaveBeenCalled();
        await act(async () => { vi.advanceTimersByTime(300); });
        expect(runAction).toHaveBeenCalledTimes(1);

        const fast = app({ screens: [{ id: 'scr_a', name: 'A', sections: [] }], watchers: [{ id: 'loop', expr: 'vars.n', actionId: 'act_watch' }] });
        const loop = vi.fn();
        const view = render(<Host def={fast} screenId="scr_a" vars={{ n: 0 }} runAction={loop} />);
        for (let n = 1; n <= 14; n++) view.rerender(<Host def={fast} screenId="scr_a" vars={{ n }} runAction={loop} />);
        expect(loop).toHaveBeenCalledTimes(10);
        expect(toast.error).toHaveBeenCalledTimes(1);
        expect(String(vi.mocked(toast.error).mock.calls[0][0])).toContain('loop');
    });

    it('WatcherState: undefined then a value is not a change, and the eleventh run in a minute is refused', () => {
        const s = new WatcherState();
        expect(s.observe(undefined)).toBe('baseline');
        expect(s.observe([1, 2])).toBe('baseline');
        expect(s.observe([1, 2])).toBe('same');
        expect(s.observe([1, 3])).toBe('changed');
        for (let i = 0; i < 10; i++) expect(s.allowRun(1000 + i)).toBe(true);
        expect(s.allowRun(2000)).toBe(false);
        expect(s.disabled).toBe(true);
        expect(s.allowRun(200_000)).toBe(false);
    });
});

describe('several actions per event, and a click on a tile', () => {
    it('runAction with a list runs the actions in order and stops at the first that fails', async () => {
        const def = stub<Parameters<typeof useActionRunner>[1]>({
            actions: { a: toastAction('first'), bad: { kind: 'no_such_kind' }, c: toastAction('third') },
        });
        const { result } = renderHook(() => useActionRunner('app1', def));
        await act(async () => { await result.current.runAction(['a', 'c']); });
        expect(vi.mocked(toast.info).mock.calls.map((c) => c[0])).toEqual(['first', 'third']);
        vi.mocked(toast.info).mockClear();
        await act(async () => { await result.current.runAction(['a', 'bad', 'c']); });
        expect(vi.mocked(toast.info).mock.calls.map((c) => c[0])).toEqual(['first']);
    });

    it('a card with onClick is a button in run mode; a click on a button inside it runs only that button', async () => {
        const user = userEvent.setup();
        const runAction = vi.fn();
        render(<AppRenderer definition={app({}, [card])} screenId="scr_a" mode="run" runAction={runAction} />);
        const cell = document.querySelector('[data-node-id="cmp_card"]') as HTMLElement;
        expect(cell.getAttribute('role')).toBe('button');
        await user.click(within(cell).getAllByText('Open me')[0]);
        expect(runAction).toHaveBeenLastCalledWith('act_open', {});
        await user.click(screen.getByRole('button', { name: 'Inner' }));
        expect(runAction).toHaveBeenLastCalledWith('act_tick', {});
        expect(runAction).toHaveBeenCalledTimes(2);
        cell.focus();
        await user.keyboard('{Enter}');
        expect(runAction).toHaveBeenCalledTimes(3);
    });

    it('in edit mode, or without onClick, a tile is not a control', () => {
        const runAction = vi.fn();
        render(<AppRenderer definition={app({}, [card])} screenId="scr_a" mode="edit" runAction={runAction} />);
        expect(document.querySelector('[data-node-id="cmp_card"]')?.getAttribute('role')).toBeNull();
        cleanup();
        const plain = { ...card, onClick: undefined, id: 'cmp_plain' };
        render(<AppRenderer definition={app({}, [plain])} screenId="scr_a" mode="run" runAction={runAction} />);
        expect(document.querySelector('[data-node-id="cmp_plain"]')?.getAttribute('role')).toBeNull();
        expect(document.querySelector('[data-node-id="cmp_plain"]')?.hasAttribute('tabindex')).toBe(false);
    });
});
