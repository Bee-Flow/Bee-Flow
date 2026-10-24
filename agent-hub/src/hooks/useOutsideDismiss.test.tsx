import React, { useEffect, useRef } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, fireEvent } from '@testing-library/react';
import useOutsideDismiss from './useOutsideDismiss';

type Props = { enabled: boolean; escape: boolean; onDismiss: () => void };

// The hand-written pattern this hook replaces (mousedown on document, bubble
// phase, `ref && !ref.contains(target)`, optional Escape on document). Running
// both side by side proves the hook dismisses on exactly the same events.
function Legacy({ enabled, escape, onDismiss }: Props) {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        if (!enabled) return undefined;
        const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onDismiss(); };
        const onKey = (e: KeyboardEvent) => { if (escape && e.key === 'Escape') onDismiss(); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
            document.removeEventListener('mousedown', onDown);
            document.removeEventListener('keydown', onKey);
        };
    }, [enabled, escape, onDismiss]);
    return <div ref={ref}><button data-testid="inside">in</button></div>;
}

function Hooked({ enabled, escape, onDismiss }: Props) {
    const ref = useRef<HTMLDivElement>(null);
    useOutsideDismiss(ref, onDismiss, { enabled, escape });
    return <div ref={ref}><button data-testid="inside">in</button></div>;
}

function HookedSync({ enabled, escape, onDismiss }: Props) {
    const ref = useRef<HTMLDivElement>(null);
    useOutsideDismiss(ref, onDismiss, { enabled, escape, defer: false });
    return <div ref={ref}><button data-testid="inside">in</button></div>;
}

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 5)); });

describe.each([
    ['legacy', Legacy],
    ['useOutsideDismiss', Hooked],
    ['useOutsideDismiss (defer: false)', HookedSync],
] as const)('%s', (_name, Impl) => {
    let outside: HTMLElement;
    beforeEach(() => {
        outside = document.createElement('div');
        document.body.appendChild(outside);
    });
    afterEach(() => { outside.remove(); });

    it('dismisses on a mousedown outside, not inside', async () => {
        const onDismiss = vi.fn();
        const { getByTestId } = render(<Impl enabled escape onDismiss={onDismiss} />);
        await flush();
        fireEvent.mouseDown(getByTestId('inside'));
        expect(onDismiss).not.toHaveBeenCalled();
        fireEvent.mouseDown(outside);
        expect(onDismiss).toHaveBeenCalledTimes(1);
        fireEvent.mouseDown(document.body);
        expect(onDismiss).toHaveBeenCalledTimes(2);
    });

    it('ignores click, pointerdown and mouseup', async () => {
        const onDismiss = vi.fn();
        render(<Impl enabled escape onDismiss={onDismiss} />);
        await flush();
        // A bare click event on purpose: user.click would also fire mousedown, which dismisses.
        fireEvent.click(outside);
        fireEvent.pointerDown(outside);
        fireEvent.mouseUp(outside);
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('dismisses on Escape only, and only when escape is on', async () => {
        const on = vi.fn();
        const off = vi.fn();
        render(<><Impl enabled escape onDismiss={on} /><Impl enabled escape={false} onDismiss={off} /></>);
        await flush();
        fireEvent.keyDown(document, { key: 'Enter' });
        expect(on).not.toHaveBeenCalled();
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(on).toHaveBeenCalledTimes(1);
        expect(off).not.toHaveBeenCalled();
    });

    it('does nothing while disabled and stops after being disabled', async () => {
        const onDismiss = vi.fn();
        const { rerender } = render(<Impl enabled={false} escape onDismiss={onDismiss} />);
        await flush();
        fireEvent.mouseDown(outside);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onDismiss).not.toHaveBeenCalled();
        rerender(<Impl enabled escape onDismiss={onDismiss} />);
        await flush();
        fireEvent.mouseDown(outside);
        expect(onDismiss).toHaveBeenCalledTimes(1);
        rerender(<Impl enabled={false} escape onDismiss={onDismiss} />);
        await flush();
        fireEvent.mouseDown(outside);
        expect(onDismiss).toHaveBeenCalledTimes(1);
    });

    it('stops listening on unmount', async () => {
        const onDismiss = vi.fn();
        const { unmount } = render(<Impl enabled escape onDismiss={onDismiss} />);
        await flush();
        unmount();
        fireEvent.mouseDown(outside);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it('calls the latest callback', async () => {
        const first = vi.fn();
        const second = vi.fn();
        const { rerender } = render(<Impl enabled escape onDismiss={first} />);
        await flush();
        rerender(<Impl enabled escape onDismiss={second} />);
        await flush();
        fireEvent.mouseDown(outside);
        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });
});

describe.each([
    ['legacy', Legacy],
    ['useOutsideDismiss (defer: false)', HookedSync],
] as const)('%s attaches synchronously', (_name, Impl) => {
    it('dismisses on a mousedown and an Escape in the very tick that enabled it', () => {
        const onDismiss = vi.fn();
        const outside = document.createElement('div');
        document.body.appendChild(outside);
        const { rerender } = render(<Impl enabled={false} escape onDismiss={onDismiss} />);
        rerender(<Impl enabled escape onDismiss={onDismiss} />);
        fireEvent.mouseDown(outside);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(onDismiss).toHaveBeenCalledTimes(2);
        outside.remove();
    });
});

describe('useOutsideDismiss attach timing', () => {
    it('ignores a mousedown in the same tick as opening (the hook defers on purpose)', async () => {
        const onDismiss = vi.fn();
        const outside = document.createElement('div');
        document.body.appendChild(outside);
        const { rerender } = render(<Hooked enabled={false} escape onDismiss={onDismiss} />);
        rerender(<Hooked enabled escape onDismiss={onDismiss} />);
        fireEvent.mouseDown(outside);
        expect(onDismiss).not.toHaveBeenCalled();
        await flush();
        fireEvent.mouseDown(outside);
        expect(onDismiss).toHaveBeenCalledTimes(1);
        outside.remove();
    });
});
