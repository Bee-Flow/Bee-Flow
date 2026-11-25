import { render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import CoworkOrb from './CoworkOrb';
import { drawOrbFrame } from './coworkOrbFrame';

vi.mock('./coworkOrbFrame', () => ({ drawOrbFrame: vi.fn() }));
vi.mock('@/hooks/useReducedMotion', () => ({ useReducedMotion: vi.fn(() => false) }));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it('advances one scene through successive steps and keeps moving after completion unless reduced motion is enabled', () => {
    vi.stubGlobal('CanvasRenderingContext2D', class {});
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({} as CanvasRenderingContext2D);
    const frames = new Map<number, FrameRequestCallback>();
    let id = 0;
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { frames.set(++id, cb); return id; });
    vi.stubGlobal('cancelAnimationFrame', (key: number) => frames.delete(key));
    const frame = (now: number) => {
        const callbacks = [...frames.values()];
        frames.clear();
        callbacks.forEach(cb => cb(now));
    };
    const { rerender, unmount } = render(<CoworkOrb activity="Preparing" />);
    frame(0); frame(50);
    const lastTime = () => vi.mocked(drawOrbFrame).mock.lastCall![2];
    const first = lastTime();
    expect(first).toBeGreaterThan(0);
    const scheduled = [...frames.keys()];
    rerender(<CoworkOrb tone="executing" activity="Reading" />);
    expect([...frames.keys()]).toEqual(scheduled);
    expect(lastTime()).toBe(first);
    frame(80); frame(130);
    expect(lastTime()).toBeGreaterThan(first);
    rerender(<CoworkOrb tone="rest" />);
    const finished = lastTime();
    frame(140); frame(190);
    expect(lastTime()).toBeGreaterThan(finished);
    vi.mocked(useReducedMotion).mockReturnValue(true);
    rerender(<CoworkOrb tone="thinking" />);
    expect(frames.size).toBe(0);
    vi.mocked(useReducedMotion).mockReturnValue(false);
    rerender(<CoworkOrb tone="executing" />);
    expect(frames.size).toBe(1);
    unmount();
    expect(frames.size).toBe(0);
});
