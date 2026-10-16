import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import BackgroundVideo from './BackgroundVideo';
import { backgroundVideoLook, backgroundVideoSectionClass } from './backgroundVideo';

function stubEnvironment({ reduced = false, phone = false }: { reduced?: boolean; phone?: boolean } = {}) {
    vi.stubGlobal('matchMedia', (query: string) => ({
        matches: query.includes('reduced-motion') ? reduced : phone,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
    }));
    vi.stubGlobal('IntersectionObserver', class {
        observe() { /* never intersects in this test */ }
        disconnect() { /* nothing to release */ }
    });
}

const VIDEO = { src: 'cms/loop.mp4', poster: 'cms/poster.jpg', overlay: 'dark', overlayOpacity: 60 };

describe('BackgroundVideo', () => {
    beforeEach(() => stubEnvironment());
    afterEach(() => { vi.unstubAllGlobals(); });

    it('renders the poster as an image and mounts the loop only when motion is welcome', () => {
        const { container } = render(<BackgroundVideo video={VIDEO} />);
        expect(container.querySelector('img.bg-video-media')?.getAttribute('src')).toContain('poster.jpg');
        expect(container.querySelector('video')).not.toBeNull();
        expect(container.querySelector('video')?.hasAttribute('controls')).toBe(false);
        expect(container.querySelector('.bg-video')?.getAttribute('aria-hidden')).toBe('true');
    });

    it('falls back to the static poster with reduced motion', () => {
        stubEnvironment({ reduced: true });
        const { container } = render(<BackgroundVideo video={VIDEO} />);
        expect(container.querySelector('video')).toBeNull();
        expect(container.querySelector('img.bg-video-media')).not.toBeNull();
    });

    it('falls back to the static poster on a phone-width screen', () => {
        stubEnvironment({ phone: true });
        const { container } = render(<BackgroundVideo video={VIDEO} />);
        expect(container.querySelector('video')).toBeNull();
    });

    it('falls back to the static poster when the browser asks to save data', () => {
        vi.stubGlobal('navigator', { ...navigator, connection: { saveData: true } });
        const { container } = render(<BackgroundVideo video={VIDEO} />);
        expect(container.querySelector('video')).toBeNull();
    });

    it('renders nothing without any video fields', () => {
        const { container } = render(<BackgroundVideo video={{}} />);
        expect(container.firstChild).toBeNull();
    });
});

describe('backgroundVideoLook', () => {
    it('keeps only known choices and clamps the overlay strength', () => {
        const look = backgroundVideoLook({ fit: 'stretch', position: 'left', overlay: 'sparkle', overlayOpacity: 900 });
        expect(look).toMatchObject({ fit: 'cover', position: 'center', overlay: 'dark' });
        expect(look.overlayStyle.opacity).toBe(1);
    });

    it('takes a custom colour only when it is a plain colour value', () => {
        expect(backgroundVideoLook({ overlay: 'custom', overlayColor: '#112233' }).overlayStyle.background).toBe('#112233');
        expect(backgroundVideoLook({ overlay: 'custom', overlayColor: 'red; background: url(x)' }).overlayStyle.background).toBeUndefined();
    });

    it('marks the section for light text unless the overlay is light', () => {
        expect(backgroundVideoSectionClass({ src: 'a.mp4' })).toContain('on-dark');
        expect(backgroundVideoSectionClass({ src: 'a.mp4', overlay: 'light' })).not.toContain('on-dark');
        expect(backgroundVideoSectionClass({})).toBe('');
    });
});
