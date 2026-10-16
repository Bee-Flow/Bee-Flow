import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LazyLoopVideo from './LazyLoopVideo';

type Callback = (entries: Array<Pick<IntersectionObserverEntry, 'isIntersecting'>>) => void;

describe('LazyLoopVideo', () => {
    let callback: Callback | undefined;
    let play: ReturnType<typeof vi.fn>;
    let pause: ReturnType<typeof vi.fn>;

    beforeEach(() => {
        callback = undefined;
        play = vi.fn(() => Promise.resolve());
        pause = vi.fn();
        vi.stubGlobal('IntersectionObserver', class {
            constructor(cb: Callback) { callback = cb; }
            observe() { /* the test drives the callback */ }
            disconnect() { /* nothing to release */ }
        });
        vi.stubGlobal('matchMedia', () => ({ matches: false }));
        Object.defineProperty(HTMLMediaElement.prototype, 'play', { configurable: true, value: play });
        Object.defineProperty(HTMLMediaElement.prototype, 'pause', { configurable: true, value: pause });
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('fetches nothing until it scrolls into view', () => {
        const { container } = render(<LazyLoopVideo src="/clip.mp4" />);
        const video = container.querySelector('video');
        expect(video?.getAttribute('src')).toBeNull();
        expect(video?.getAttribute('preload')).toBe('none');
        expect(video?.hasAttribute('autoplay')).toBe(false);
        expect(play).not.toHaveBeenCalled();
    });

    it('attaches the source and plays when visible, pauses when it leaves', () => {
        const { container } = render(<LazyLoopVideo src="/clip.mp4" />);
        const video = container.querySelector('video');
        callback?.([{ isIntersecting: true }]);
        expect(video?.getAttribute('src')).toBe('/clip.mp4');
        expect(play).toHaveBeenCalledTimes(1);
        callback?.([{ isIntersecting: false }]);
        expect(pause).toHaveBeenCalledTimes(1);
    });

    it('with reduced motion it does not autoplay and offers controls', () => {
        vi.stubGlobal('matchMedia', () => ({ matches: true }));
        const { container } = render(<LazyLoopVideo src="/clip.mp4" />);
        const video = container.querySelector('video');
        expect(play).not.toHaveBeenCalled();
        expect(video?.hasAttribute('controls')).toBe(true);
        expect(video?.getAttribute('preload')).toBe('metadata');
        expect(video?.getAttribute('src')).toBe('/clip.mp4');
    });
});
