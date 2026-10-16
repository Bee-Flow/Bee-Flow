import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TourPill, { hasTour, pillText } from './TourPill';

const TOUR = { src: 'cms/tour.mp4', poster: 'cms/p.jpg', captionsSrc: 'cms/tour.vtt', captionsLang: 'nl', label: 'Watch product tour', duration: '4 minutes' };

describe('TourPill', () => {
    beforeEach(() => {
        vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('shows label and duration, and opens a player with captions and no autoplay', async () => {
        render(<TourPill tour={TOUR} />);
        const pill = screen.getByRole('button', { name: /Watch product tour · 4 minutes/ });
        expect(document.querySelector('video')).toBeNull();
        await userEvent.click(pill);
        const dialog = await screen.findByRole('dialog');
        // Focus moves into the dialog, onto its close button.
        expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close' }));
        const video = dialog.querySelector('video');
        expect(video?.hasAttribute('autoplay')).toBe(false);
        expect(video?.hasAttribute('controls')).toBe(true);
        expect(video?.querySelector('track')?.getAttribute('srclang')).toBe('nl');
    });

    it('closes with Escape and unmounts the video', async () => {
        render(<TourPill tour={TOUR} />);
        await userEvent.click(screen.getByRole('button'));
        await screen.findByRole('dialog');
        await userEvent.keyboard('{Escape}');
        expect(screen.queryByRole('dialog')).toBeNull();
        expect(document.querySelector('video')).toBeNull();
    });

    it('renders nothing without a tour file or when disabled', () => {
        const { container } = render(<TourPill tour={{ label: 'x' }} />);
        expect(container.firstChild).toBeNull();
        expect(hasTour({ ...TOUR, enabled: false })).toBe(false);
    });

    it('falls back to a default label', () => {
        expect(pillText({ src: 'a.mp4' })).toBe('Watch product tour');
    });
});
