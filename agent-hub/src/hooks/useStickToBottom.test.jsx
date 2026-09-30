/**
 * The rule the builder panes live by: follow what is being built, unless the
 * person scrolled up to read something. jsdom has no layout, so the scroller
 * is faked — what is under test is the decision, not the pixels.
 */
import { act, render } from '@testing-library/react';
import React, { useRef } from 'react';
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import useStickToBottom from './useStickToBottom';

let resizeCb = null;
let mutateCb = null;
let observed = [];

beforeEach(() => {
    resizeCb = null;
    observed = [];
    mutateCb = null;
    vi.stubGlobal('ResizeObserver', class {
        constructor(cb) { resizeCb = cb; }
        observe(target) { observed.push(target); }
        disconnect() {}
    });
    vi.stubGlobal('MutationObserver', class {
        constructor(cb) { mutateCb = cb; }
        observe() {}
        disconnect() {}
    });
});
afterEach(() => vi.unstubAllGlobals());

/** A scroller whose geometry the test controls. */
function box(el, { scrollHeight, clientHeight, scrollTop }) {
    Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
    Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
    el.scrollTop = scrollTop;
}

function Harness({ onReady }) {
    const containerRef = useRef(null);
    const contentRef = useRef(null);
    const api = useStickToBottom({ containerRef, contentRef });
    React.useEffect(() => { onReady({ containerRef, api }); });
    return (
        <div ref={containerRef} onScroll={api.onScroll} data-testid="scroller">
            <div ref={contentRef}>content</div>
        </div>
    );
}

function mount() {
    let ctx = null;
    render(<Harness onReady={(v) => { ctx = v; }} />);
    return ctx;
}

describe('useStickToBottom', () => {
    it('follows content that grows while the reader is at the bottom', () => {
        const ctx = mount();
        const el = ctx.containerRef.current;
        box(el, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });   // at the bottom
        act(() => ctx.api.onScroll());
        box(el, { scrollHeight: 1400, clientHeight: 400, scrollTop: 600 });   // a build step lands
        act(() => resizeCb([]));
        expect(el.scrollTop).toBe(1400);
    });

    it('re-pins when the scroller itself shrinks (a composer grows beside it) while stuck', () => {
        const ctx = mount();
        const el = ctx.containerRef.current;
        expect(observed).toContain(el);
        box(el, { scrollHeight: 1000, clientHeight: 400, scrollTop: 600 });   // at the bottom
        act(() => ctx.api.onScroll());
        box(el, { scrollHeight: 1000, clientHeight: 300, scrollTop: 600 });   // viewport lost 100px
        act(() => resizeCb([]));
        expect(el.scrollTop).toBe(1000);
    });

    it('leaves the reader alone once they scroll up', () => {
        const ctx = mount();
        const el = ctx.containerRef.current;
        box(el, { scrollHeight: 1000, clientHeight: 400, scrollTop: 100 });   // scrolled up
        act(() => ctx.api.onScroll());
        expect(ctx.api.isStuck()).toBe(false);
        box(el, { scrollHeight: 1400, clientHeight: 400, scrollTop: 100 });
        act(() => resizeCb([]));
        expect(el.scrollTop).toBe(100);
    });

    it('a mutation that adds no height still moves the bottom', () => {
        const ctx = mount();
        const el = ctx.containerRef.current;
        box(el, { scrollHeight: 900, clientHeight: 400, scrollTop: 500 });
        act(() => ctx.api.onScroll());
        box(el, { scrollHeight: 980, clientHeight: 400, scrollTop: 500 });
        act(() => mutateCb([]));
        expect(el.scrollTop).toBe(980);
    });

    it('forceStick overrides a reader who had scrolled away — a new turn starts at the bottom', () => {
        const ctx = mount();
        const el = ctx.containerRef.current;
        box(el, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
        act(() => ctx.api.onScroll());
        expect(ctx.api.isStuck()).toBe(false);
        act(() => ctx.api.forceStick());
        expect(el.scrollTop).toBe(1000);
        expect(ctx.api.isStuck()).toBe(true);
    });

    it('keeps following after the pane swaps its empty state for the list', () => {
        // The App Studio pane renders EITHER an empty state OR the message
        // list, so the node a one-shot observer grabbed at mount unmounts on
        // the first message. Watching the container catches the swap.
        let ctx = null;
        function Swapper({ showList }) {
            const containerRef = useRef(null);
            const api = useStickToBottom({ containerRef });
            React.useEffect(() => { ctx = { containerRef, api }; });
            return (
                <div ref={containerRef} onScroll={api.onScroll}>
                    {showList ? <div data-testid="list">rows</div> : <div data-testid="empty">nothing yet</div>}
                </div>
            );
        }
        const { rerender } = render(<Swapper showList={false} />);
        const el = ctx.containerRef.current;
        box(el, { scrollHeight: 400, clientHeight: 400, scrollTop: 0 });
        act(() => ctx.api.onScroll());
        rerender(<Swapper showList />);
        box(el, { scrollHeight: 1200, clientHeight: 400, scrollTop: 0 });
        act(() => mutateCb([]));          // the swap itself is a mutation
        expect(el.scrollTop).toBe(1200);
    });

    it('counts a landing just short of the bottom as the bottom (48px of slack)', () => {
        const ctx = mount();
        const el = ctx.containerRef.current;
        box(el, { scrollHeight: 1000, clientHeight: 400, scrollTop: 570 });   // 30px short
        act(() => ctx.api.onScroll());
        expect(ctx.api.isStuck()).toBe(true);
        box(el, { scrollHeight: 1000, clientHeight: 400, scrollTop: 500 });   // 100px short
        act(() => ctx.api.onScroll());
        expect(ctx.api.isStuck()).toBe(false);
    });

    it('the scroll event its own scroll causes lands at the bottom, so it stays stuck', () => {
        const ctx = mount();
        const el = ctx.containerRef.current;
        box(el, { scrollHeight: 1000, clientHeight: 400, scrollTop: 0 });
        act(() => ctx.api.onScroll());
        expect(ctx.api.isStuck()).toBe(false);
        // forceStick scrolls to the bottom; the browser then fires `scroll`
        // from there, and reading THAT position must keep us stuck.
        act(() => { ctx.api.forceStick(); ctx.api.onScroll(); });
        expect(ctx.api.isStuck()).toBe(true);
    });
});
