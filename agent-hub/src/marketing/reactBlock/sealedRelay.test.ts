import { describe, expect, it, vi } from 'vitest';
import { installRelay } from './sealedRelay';

type Listener = (e: { source: unknown; data: unknown }) => void;

function setup() {
    let listener: Listener = () => undefined;
    const parent = { postMessage: vi.fn() };
    const inner = { postMessage: vi.fn() };
    const win = { parent, addEventListener: (_type: 'message', fn: Listener) => { listener = fn; } };
    installRelay(win, { contentWindow: inner });
    return { parent, inner, send: (source: unknown, data: unknown) => listener({ source, data }) };
}

describe('installRelay (the outer frame of a sealed block)', () => {
    it('passes props from the app page to the inner frame, rebuilt', () => {
        const { parent, inner, send } = setup();
        send(parent, { type: 'bf-react-props', props: { who: 'Ada' }, extra: 'dropped' });
        expect(inner.postMessage).toHaveBeenCalledWith({ type: 'bf-react-props', props: { who: 'Ada' } }, '*');
    });

    it('passes a height and an event from the inner frame to the app page, rebuilt and capped', () => {
        const { parent, inner, send } = setup();
        send(inner, { type: 'bf-react-resize', height: 99999.2, extra: 1 });
        send(inner, { type: 'bf-react-event', event: 'pick', value: { id: 3 }, extra: 1 });
        expect(parent.postMessage.mock.calls).toEqual([
            [{ type: 'bf-react-resize', height: 20000 }, '*'],
            [{ type: 'bf-react-event', event: 'pick', value: { id: 3 } }, '*'],
        ]);
    });

    it('drops every other type, and any message from the wrong side', () => {
        const { parent, inner, send } = setup();
        send(inner, { type: 'bf-react-props', props: {} });
        send(inner, { type: 'bf-react-error', message: 'x' });
        send(inner, { type: 'bf-react-resize', height: -1 });
        send(inner, { type: 'bf-react-event', event: '' });
        send(inner, { type: 'bf-react-event', event: 'x'.repeat(41) });
        send(parent, { type: 'bf-react-event', event: 'pick' });
        send(parent, { type: 'bf-react-resize', height: 10 });
        send({}, { type: 'bf-react-props', props: {} });
        send({}, { type: 'bf-react-event', event: 'pick' });
        send(inner, 'bf-react-event');
        expect(parent.postMessage).not.toHaveBeenCalled();
        expect(inner.postMessage).not.toHaveBeenCalled();
    });

    it('is self-contained: its source text runs on its own (it is written into the outer document)', () => {
        const relay = new Function(`return (${String(installRelay)});`)() as typeof installRelay;
        let listener: Listener = () => undefined;
        const parent = { postMessage: vi.fn() };
        const inner = { postMessage: vi.fn() };
        relay({ parent, addEventListener: (_t, fn) => { listener = fn; } }, { contentWindow: inner });
        listener({ source: inner, data: { type: 'bf-react-resize', height: 5 } });
        expect(parent.postMessage).toHaveBeenCalledWith({ type: 'bf-react-resize', height: 5 }, '*');
    });
});
