import { act } from '@testing-library/react';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { loadReactRuntime } from '@/marketing/reactBlock/loadRuntime';
import { SEALED_FRAME_CSP, SEALED_OUTER_CSP } from '@/marketing/reactBlock/frameDoc';
import { renderScreen } from '@/test/appScreenRender';

// The frame's runtime text is its own chunk; loaded first, the block draws on the first render.
beforeAll(async () => { await loadReactRuntime(); }, 60_000);

const ACTION = 'act_pick000001';
const BLOCK = {
    source: 'export default function X() { return null; }',
    compiled: 'module.exports.default = function () { return null; };',
    inputs: { who: { kind: 'static', value: 'Ada' } },
    events: { pick: ACTION },
};
const node = (block: unknown = BLOCK) => ({ id: 'cmp_rb0000001', type: 'react_block', visible: true, style: { span: 12 }, props: { block } });
const ACTIONS = { [ACTION]: { kind: 'toast', message: 'picked' } };

const frameOf = (container: HTMLElement) => container.querySelector('iframe') as HTMLIFrameElement;

/** A message as the frame would post it: from its own window, unless `source` says otherwise. */
async function fromFrame(frame: HTMLIFrameElement, data: unknown, source: Window | null = frame.contentWindow) {
    await act(async () => { window.dispatchEvent(new MessageEvent('message', { data, source })); });
}

describe('AppReactBlock', () => {
    it('draws a sealed frame in an outer frame: scripts only, each policy first in its head, and no app data in either document', () => {
        const { container } = renderScreen([node()], {}, ACTIONS);
        const frame = frameOf(container);
        expect(frame.getAttribute('sandbox')).toBe('allow-scripts');
        expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
        const srcdoc = frame.getAttribute('srcdoc') || '';
        expect(srcdoc.startsWith(`<!DOCTYPE html><html><head><meta http-equiv="Content-Security-Policy" content="${SEALED_OUTER_CSP}">`)).toBe(true);
        const inner = new DOMParser().parseFromString(srcdoc, 'text/html').getElementById('bf-inner') as HTMLIFrameElement;
        expect(inner.getAttribute('sandbox')).toBe('allow-scripts');
        const innerDoc = inner.getAttribute('srcdoc') || '';
        expect(innerDoc.startsWith(`<!DOCTYPE html><html lang="en"><head><meta http-equiv="Content-Security-Policy" content="${SEALED_FRAME_CSP}">`)).toBe(true);
        expect(srcdoc).not.toContain('Ada');
        expect(innerDoc).toContain('--bf-primary:');
        expect(container.querySelector('.bfa-react_block__root')).not.toBeNull();
    });

    it('hands the frame its resolved inputs by postMessage once it has loaded', async () => {
        const { container } = renderScreen([node()], {}, ACTIONS);
        const frame = frameOf(container);
        const post = vi.spyOn(frame.contentWindow as Window, 'postMessage');
        await act(async () => { frame.dispatchEvent(new Event('load')); });
        expect(post).toHaveBeenCalledWith({ type: 'bf-react-props', props: { who: 'Ada' } }, '*');
    });

    it('runs the wired action for a declared event from its own frame, and nothing else', async () => {
        const runAction = vi.fn();
        const { container } = renderScreen([node()], { runAction }, ACTIONS);
        const frame = frameOf(container);

        await fromFrame(frame, { type: 'bf-react-event', event: 'pick', value: { id: 7 } });
        expect(runAction).toHaveBeenCalledTimes(1);
        expect(runAction.mock.calls[0][0]).toBe(ACTION);
        expect(runAction.mock.calls[0][1]).toMatchObject({ value: { id: 7 } });

        await fromFrame(frame, { type: 'bf-react-event', event: 'delete', value: 1 });
        await fromFrame(frame, { type: 'bf-react-event', event: 'pick', value: 'x'.repeat(20_000) });
        await fromFrame(frame, { type: 'bf-react-event', event: 'pick', value: 1 }, window);
        await fromFrame(frame, { type: 'bf-react-event', event: 'pick', value: 1 }, null);
        expect(runAction).toHaveBeenCalledTimes(1);
    });

    it('runs nothing in the editor, and says what is missing there', async () => {
        const runAction = vi.fn();
        const { container } = renderScreen([node()], { runAction, mode: 'edit' }, ACTIONS);
        await fromFrame(frameOf(container), { type: 'bf-react-event', event: 'pick', value: 1 });
        expect(runAction).not.toHaveBeenCalled();

        const pending = renderScreen([node({ source: 'export default 1', compileError: 'component.tsx:1:1: broken\nmore' })], { mode: 'edit' }, ACTIONS);
        expect(pending.container.querySelector('iframe')).toBeNull();
        expect(pending.container.querySelector('[data-app-react-block="not-compiled"]')?.textContent).toContain('component.tsx:1:1: broken');

        const empty = renderScreen([node({})], { mode: 'edit' }, ACTIONS);
        expect(empty.container.querySelector('[data-app-react-block="empty"]')).not.toBeNull();
    });

    it('draws nothing for a viewer when the block does not compile', () => {
        const { container } = renderScreen([node({ source: 'x' })], {}, ACTIONS);
        expect(container.querySelector('iframe')).toBeNull();
        expect(container.querySelector('[data-app-react-block]')).toBeNull();
    });
});
