import { act, render } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ReactFrame, { FRAME_SANDBOX, MAX_FRAME_HEIGHT, type ReactFrameProps } from './ReactFrame';

const BASE: ReactFrameProps = {
    runtime: 'window.__bfReactMount = function () {};',
    compiled: 'module.exports.default = function () { return null; };',
    css: '',
    theme: ':root{--bf-primary:#F5A623;}',
    props: { title: 'Hello' },
    mode: 'public',
    minHeight: 240,
    title: 'React component',
};

function setup(over: Partial<ReactFrameProps> = {}) {
    const utils = render(<ReactFrame {...BASE} {...over} />);
    const frame = utils.container.querySelector('iframe') as HTMLIFrameElement;
    return { ...utils, frame };
}

function post(data: unknown, source: MessageEventSource | null) {
    act(() => {
        window.dispatchEvent(new MessageEvent('message', { data, source }));
    });
}

describe('ReactFrame', () => {
    it('is sandboxed without same-origin, marked for screenshots, lazy, titled and starts at minHeight', () => {
        const { frame } = setup();
        expect(frame.getAttribute('sandbox')).toBe(FRAME_SANDBOX);
        expect(FRAME_SANDBOX).not.toContain('allow-same-origin');
        expect(frame.getAttribute('data-cms-frame')).toBe('react');
        expect(frame.getAttribute('loading')).toBe('lazy');
        expect(frame.getAttribute('title')).toBe('React component');
        expect(frame.getAttribute('height')).toBe('240');
        expect(frame.getAttribute('srcdoc')).toContain('"title":"Hello"');
    });

    it('takes the height its own frame reports, and ignores every other window', () => {
        const { frame } = setup();
        post({ type: 'bf-react-resize', height: 512.2 }, frame.contentWindow);
        expect(frame.getAttribute('height')).toBe('513');

        post({ type: 'bf-react-resize', height: 9 }, window);
        post({ type: 'bf-react-resize', height: 9 }, null);
        expect(frame.getAttribute('height')).toBe('513');

        post({ type: 'bf-react-resize', height: 10 ** 9 }, frame.contentWindow);
        expect(frame.getAttribute('height')).toBe(String(MAX_FRAME_HEIGHT));
        post({ type: 'bf-react-resize', height: 'x' }, frame.contentWindow);
        expect(frame.getAttribute('height')).toBe(String(MAX_FRAME_HEIGHT));
        post({ type: 'bf-react-resize', height: 0 }, frame.contentWindow);
        expect(frame.getAttribute('height')).toBe('0');
    });

    it('keeps two frames apart: each listens to its own window only', () => {
        const utils = render(<><ReactFrame {...BASE} /><ReactFrame {...BASE} /></>);
        const [a, b] = Array.from(utils.container.querySelectorAll('iframe'));
        post({ type: 'bf-react-resize', height: 300 }, b.contentWindow);
        expect(a.getAttribute('height')).toBe('240');
        expect(b.getAttribute('height')).toBe('300');
    });

    it('posts new props into the running frame and leaves the document alone', () => {
        const { frame, rerender } = setup();
        const before = frame.getAttribute('srcdoc');
        const win = frame.contentWindow as Window;
        const spy = vi.spyOn(win, 'postMessage');
        rerender(<ReactFrame {...BASE} props={{ title: 'Changed' }} />);
        expect(frame.getAttribute('srcdoc')).toBe(before);
        expect(spy).toHaveBeenCalledWith({ type: 'bf-react-props', props: { title: 'Changed' } }, '*');

        spy.mockClear();
        rerender(<ReactFrame {...BASE} props={{ title: 'Changed' }} />);
        expect(spy).not.toHaveBeenCalled(); // same values, new object: nothing to send
    });

    it('rebuilds the document when the code, the css or the theme change, with the props of that moment', () => {
        const { frame, rerender } = setup();
        rerender(<ReactFrame {...BASE} props={{ title: 'Later' }} />);
        const first = frame.getAttribute('srcdoc');
        expect(first).toContain('"title":"Hello"');

        rerender(<ReactFrame {...BASE} props={{ title: 'Later' }} compiled="module.exports.default = function () { return 1; };" />);
        expect(frame.getAttribute('srcdoc')).not.toBe(first);
        expect(frame.getAttribute('srcdoc')).toContain('"title":"Later"');

        const second = frame.getAttribute('srcdoc');
        rerender(<ReactFrame {...BASE} props={{ title: 'Later' }} compiled="module.exports.default = function () { return 1; };" theme=":root{--bf-primary:#000;}" />);
        expect(frame.getAttribute('srcdoc')).not.toBe(second);
        expect(frame.getAttribute('srcdoc')).toContain('--bf-primary:#000;');
    });

    it('holds its space without a document while the runtime loads', () => {
        const { frame } = setup({ runtime: null });
        expect(frame.hasAttribute('srcdoc')).toBe(false);
        expect(frame.getAttribute('height')).toBe('240');
    });
});
