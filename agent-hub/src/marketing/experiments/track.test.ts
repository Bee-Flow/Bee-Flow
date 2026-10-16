import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { resetSent, startGoalTracking, trackView, trackWhenReady } from './track';

type W = Window & { umami?: { track: (n: string, d?: Record<string, string>) => void } };
const track = vi.fn();

beforeEach(() => { track.mockReset(); resetSent(); (window as W).umami = { track }; });
afterEach(() => { delete (window as W).umami; vi.useRealTimers(); document.body.innerHTML = ''; });

describe('experiment tracking', () => {
    it('sends the view once per experiment with only the name and the variant', () => {
        trackView('hero-title', 'b');
        trackView('hero-title', 'b');
        expect(track).toHaveBeenCalledTimes(1);
        expect(track).toHaveBeenCalledWith('ab_view', { experiment: 'hero-title', variant: 'b' });
    });

    it('waits for the tracker script and gives up quietly when it never loads', () => {
        vi.useFakeTimers();
        delete (window as W).umami;
        trackWhenReady('ab_view', { experiment: 'e', variant: 'a' });
        (window as W).umami = { track };
        vi.advanceTimersByTime(600);
        expect(track).toHaveBeenCalledTimes(1);
        delete (window as W).umami;
        trackWhenReady('ab_view', { experiment: 'e', variant: 'a' });
        vi.advanceTimersByTime(10_000);
        expect(track).toHaveBeenCalledTimes(1);
    });

    it('counts a click on a link inside an experiment block as the goal, once', () => {
        document.body.innerHTML = '<div data-cms-experiment="hero-title" data-cms-variant="b" data-cms-goal="signup"><a href="/x" id="go">Go</a></div><a href="/y" id="out">Out</a>';
        const stop = startGoalTracking();
        document.getElementById('out')!.click();
        expect(track).not.toHaveBeenCalled();
        document.getElementById('go')!.click();
        document.getElementById('go')!.click();
        expect(track).toHaveBeenCalledTimes(1);
        expect(track).toHaveBeenCalledWith('signup', { experiment: 'hero-title', variant: 'b' });
        stop();
    });

    it('does not count a plain button (tabs, tour, accordion) as the goal, but a submit button', () => {
        document.body.innerHTML = '<div data-cms-experiment="e" data-cms-variant="a" data-cms-goal="g"><button type="button" id="next">Next</button><div role="button" id="r">R</div><button type="submit" id="send">Send</button></div>';
        const stop = startGoalTracking();
        document.getElementById('next')!.click();
        document.getElementById('r')!.click();
        expect(track).not.toHaveBeenCalled();
        document.getElementById('send')!.click();
        expect(track).toHaveBeenCalledTimes(1);
        stop();
    });

    it('stops listening when the last experiment block unmounts', () => {
        document.body.innerHTML = '<div data-cms-experiment="e" data-cms-variant="a" data-cms-goal="g"><button id="b">B</button></div>';
        startGoalTracking()();
        document.getElementById('b')!.click();
        expect(track).not.toHaveBeenCalled();
    });
});
