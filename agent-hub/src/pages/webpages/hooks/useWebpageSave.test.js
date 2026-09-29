import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import useWebpageSave, { useWebpageChatPersistence } from './useWebpageSave';

/**
 * useWebpageSave / useWebpageChatPersistence — unit pins for the rules the
 * page-level characterisation (pages/WebpagesPage.test.jsx) can only observe
 * from the outside: the page-guard inside persist(), the timer re-check, the
 * re-queue of failed extras, and the "nothing dirty → no request" no-op.
 */

function deferred() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

async function flush(ms = 0) {
    await act(async () => {
        if (ms > 0) await vi.advanceTimersByTimeAsync(ms);
        for (let i = 0; i < 10; i++) await Promise.resolve();
    });
}

let api;
let calls;

beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    calls = [];
    api = vi.fn(async (path, opts = {}) => {
        calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
        return {};
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

function mountSave(overrides = {}) {
    const extraContentsRef = { current: { 'extra.css': { isText: true, content: 'a{}' }, 'pic.png': { isText: false } } };
    const onSaved = vi.fn();
    const initialProps = {
        webpageId: 'A', html: '<h1>A</h1>', css: '', js: '',
        extraContentsRef, api, onSaved, ...overrides,
    };
    const hook = renderHook((props) => useWebpageSave(props), { initialProps });
    // Keep the last props so successive setContent calls compose.
    let last = initialProps;
    const rerenderWith = (patch) => { last = { ...last, ...patch }; hook.rerender(last); };
    return { ...hook, extraContentsRef, onSaved, setContent: rerenderWith };
}

describe('useWebpageSave', () => {
    it('treats the mounted content as saved: no request on mount, persist() is a no-op when clean', async () => {
        const h = mountSave();
        await flush(3000);
        expect(api).not.toHaveBeenCalled();
        await act(async () => { await h.result.current.persist(); });
        expect(api).not.toHaveBeenCalled();
        expect(h.result.current.saveState).toBe('idle');
        expect(h.onSaved).not.toHaveBeenCalled();
    });

    it('debounces content changes into one PUT with the full snapshot and clears the dirty slot', async () => {
        const h = mountSave();
        act(() => { h.result.current.markPrimaryDirty('html'); });
        h.setContent({ html: '<h1>1</h1>' });
        h.setContent({ html: '<h1>2</h1>', css: 'b{}' });
        expect(h.result.current.dirtyFiles).toEqual({ html: true });

        await flush(1400);
        expect(api).not.toHaveBeenCalled();
        await flush(200);
        expect(calls).toEqual([{ path: '/A', method: 'PUT', body: { html: '<h1>2</h1>', css: 'b{}', js: '' } }]);
        expect(h.result.current.saveState).toBe('saved');
        expect(h.result.current.lastSavedAt).toBeInstanceOf(Date);
        expect(h.result.current.dirtyFiles).toEqual({});
        expect(h.onSaved).toHaveBeenCalledWith('A');

        // Baseline moved: the same content is clean now.
        await act(async () => { await h.result.current.persist(); });
        expect(api).toHaveBeenCalledTimes(1);
    });

    it('unmount cancels the pending debounce; flushNow before unmount saves it', async () => {
        const h = mountSave();
        h.setContent({ html: '<h1>lost</h1>' });
        h.unmount();
        await flush(3000);
        expect(api).not.toHaveBeenCalled();

        const h2 = mountSave();
        h2.setContent({ html: '<h1>kept</h1>' });
        await act(async () => { await h2.result.current.flushNow(); });
        h2.unmount();
        await flush(3000);
        expect(calls).toEqual([{ path: '/A', method: 'PUT', body: { html: '<h1>kept</h1>', css: '', js: '' } }]);
    });

    it('a save that lands after the page was left still reports onSaved but touches no state', async () => {
        const gate = deferred();
        api.mockImplementationOnce(async (path, opts) => {
            calls.push({ path, method: opts.method, body: JSON.parse(opts.body) });
            await gate.promise;
            return {};
        });
        const h = mountSave();
        act(() => { h.result.current.markPrimaryDirty('html'); });
        h.setContent({ html: '<h1>late</h1>' });
        let flushed;
        act(() => { flushed = h.result.current.flushNow(); });
        expect(h.result.current.saveState).toBe('saving');
        h.unmount();

        gate.resolve();
        await act(async () => { await flushed; });
        expect(calls).toHaveLength(1);
        expect(h.onSaved).toHaveBeenCalledWith('A');
    });

    it('PUTs dirty extras per path, drops non-text ones silently, re-queues a failed one and retries it', async () => {
        let failExtra = true;
        api.mockImplementation(async (path, opts = {}) => {
            calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
            if (path === '/A/files' && failExtra) throw new Error('boom');
            return {};
        });
        const h = mountSave();
        act(() => {
            h.result.current.markExtraDirty('extra.css');
            h.result.current.markExtraDirty('pic.png');
        });
        expect(h.result.current.dirtyFiles).toEqual({ 'extra:extra.css': true, 'extra:pic.png': true });
        await flush(1600);

        expect(calls).toEqual([{ path: '/A/files', method: 'PUT', body: { path: 'extra.css', content: 'a{}' } }]);
        expect(h.result.current.saveState).toBe('error');
        // The binary path had nothing to save → clean; the failed text path stays dirty.
        expect(h.result.current.dirtyFiles).toEqual({ 'extra:extra.css': true });
        expect(h.onSaved).not.toHaveBeenCalled();

        failExtra = false;
        act(() => { h.result.current.scheduleSave(); });
        await flush(1600);
        expect(calls).toHaveLength(2);
        expect(calls[1]).toEqual({ path: '/A/files', method: 'PUT', body: { path: 'extra.css', content: 'a{}' } });
        expect(h.result.current.saveState).toBe('saved');
        expect(h.result.current.dirtyFiles).toEqual({});
        expect(h.onSaved).toHaveBeenCalledTimes(1);
    });

    it('a failed primary save keeps its slots dirty, still saves the extras and reports error', async () => {
        api.mockImplementation(async (path, opts = {}) => {
            calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
            if (path === '/A') throw new Error('primary down');
            return {};
        });
        const h = mountSave();
        act(() => {
            h.result.current.markPrimaryDirty('html');
            h.result.current.markExtraDirty('extra.css');
        });
        h.setContent({ html: '<h1>x</h1>' });
        await flush(1600);

        expect(calls.map(c => c.path)).toEqual(['/A', '/A/files']);
        expect(h.result.current.saveState).toBe('error');
        expect(h.result.current.dirtyFiles).toEqual({ html: true });
        expect(h.onSaved).not.toHaveBeenCalled();

        // The primary is retried on the next persist because the baseline never moved.
        api.mockImplementation(async (path, opts = {}) => {
            calls.push({ path, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : undefined });
            return {};
        });
        await act(async () => { await h.result.current.flushNow(); });
        expect(calls[2]).toEqual({ path: '/A', method: 'PUT', body: { html: '<h1>x</h1>', css: '', js: '' } });
        expect(h.result.current.saveState).toBe('saved');
        expect(h.result.current.dirtyFiles).toEqual({});
    });

    it('a changed webpageId drops the previous page\'s dirty queue instead of writing it to the new page', async () => {
        // The editor is keyed on the id, so this never happens today — the pin
        // is that if a later refactor drops that key, page A's dirty extra is
        // NOT PUT to /B/files.
        const h = mountSave();
        act(() => {
            h.result.current.markPrimaryDirty('html');
            h.result.current.markExtraDirty('extra.css');
        });
        h.setContent({ html: '<h1>A edited</h1>' });
        expect(h.result.current.dirtyFiles).toEqual({ html: true, 'extra:extra.css': true });

        // Same instance, different page (its own already-saved content).
        h.setContent({ webpageId: 'B', html: '<h1>B</h1>', css: '', js: '' });
        await flush(3000);

        expect(api).not.toHaveBeenCalled();
        expect(h.result.current.dirtyFiles).toEqual({});
        expect(h.result.current.saveState).toBe('idle');
        expect(h.result.current.lastSavedAt).toBeNull();

        // B's own edits still save — against B's baseline, to B's id.
        h.setContent({ html: '<h1>B edited</h1>' });
        await flush(1600);
        expect(calls).toEqual([{ path: '/B', method: 'PUT', body: { html: '<h1>B edited</h1>', css: '', js: '' } }]);
    });

    it('acceptServerSnapshot re-baselines and swallows the content effect it triggers', async () => {
        const h = mountSave();
        act(() => { h.result.current.acceptServerSnapshot({ html: '<p>restored</p>' }); });
        h.setContent({ html: '<p>restored</p>' });
        await flush(3000);
        expect(api).not.toHaveBeenCalled();

        // A real edit afterwards is saved against the restored baseline.
        h.setContent({ html: '<p>restored2</p>' });
        await flush(1600);
        expect(calls).toEqual([{ path: '/A', method: 'PUT', body: { html: '<p>restored2</p>', css: '', js: '' } }]);
    });
});

describe('useWebpageChatPersistence', () => {
    function mountChat(initial) {
        let last = { webpageId: 'A', chatMessages: [], chatLoading: false, api, ...initial };
        const hook = renderHook((props) => useWebpageChatPersistence(props), { initialProps: last });
        const update = (patch) => { last = { ...last, ...patch }; hook.rerender(last); };
        return { ...hook, update };
    }

    it('does not PUT a hydrated history, waits for the stream to settle, then saves once', async () => {
        const persisted = [{ id: 'm1', role: 'user', content: 'hi' }];
        const h = mountChat();
        act(() => { h.result.current.markSaved(persisted); });
        h.update({ chatMessages: persisted });
        await flush(2000);
        expect(api).not.toHaveBeenCalled();

        const next = [...persisted, { id: 'm2', role: 'user', content: 'more' }];
        h.update({ chatMessages: next, chatLoading: true });
        await flush(2000);
        expect(api).not.toHaveBeenCalled();

        h.update({ chatLoading: false });
        await flush(700);
        expect(api).not.toHaveBeenCalled();
        await flush(200);
        expect(calls).toEqual([{ path: '/A/chat', method: 'PUT', body: { messages: next } }]);

        // Same content again → nothing.
        h.update({ chatMessages: [...next] });
        await flush(2000);
        expect(calls).toHaveLength(1);
    });

    it('clearOnServer is one DELETE and the empty chat that follows is not PUT', async () => {
        const h = mountChat({ chatMessages: [{ id: 'm1', role: 'user', content: 'hi' }] });
        act(() => { h.result.current.markSaved([{ id: 'm1', role: 'user', content: 'hi' }]); });
        await act(async () => { await h.result.current.clearOnServer(); });
        h.update({ chatMessages: [] });
        await flush(2000);
        expect(calls).toEqual([{ path: '/A/chat', method: 'DELETE', body: undefined }]);
    });

    it('unmount cancels a pending chat save', async () => {
        const h = mountChat();
        h.update({ chatMessages: [{ id: 'm1', role: 'user', content: 'hi' }] });
        h.unmount();
        await flush(2000);
        expect(api).not.toHaveBeenCalled();
    });
});
