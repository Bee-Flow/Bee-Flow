import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import TourTeaser from './TourTeaser';

const TOUR = { src: 'cms/tour.mp4', poster: 'cms/p.jpg', label: 'Watch product tour', duration: '4 minutes', teaserSrc: 'cms/teaser.mp4' };

describe('TourTeaser', () => {
    beforeEach(() => {
        vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
    });
    afterEach(() => { vi.unstubAllGlobals(); });

    it('without a loop file it is only the pill', () => {
        const { container } = render(<TourTeaser tour={{ ...TOUR, teaserSrc: undefined }} />);
        expect(container.querySelector('figure')).toBeNull();
        expect(container.querySelector('.tour-pill')).not.toBeNull();
    });

    it('frames the loop and puts the pill in its corner, with no dimming layer', () => {
        const { container } = render(<TourTeaser tour={TOUR} />);
        const frame = container.querySelector('figure.tour-teaser-frame');
        expect(frame?.classList.contains('cms-frame')).toBe(true);
        expect(frame?.querySelector('.tour-teaser-corner .tour-pill')).not.toBeNull();
        expect(container.querySelector('.tour-teaser-below')).toBeNull();
    });

    it('teaserPill "below" puts the pill under the frame', () => {
        const { container } = render(<TourTeaser tour={{ ...TOUR, teaserPill: 'below' }} />);
        expect(container.querySelector('figure .tour-pill')).toBeNull();
        expect(container.querySelector('.tour-teaser-below .tour-pill')).not.toBeNull();
    });

    it('a click anywhere on the frame opens the player', async () => {
        const { container } = render(<TourTeaser tour={TOUR} />);
        const frame = container.querySelector('figure');
        expect(frame).not.toBeNull();
        if (frame) await userEvent.click(frame);
        expect(await screen.findByRole('dialog')).not.toBeNull();
    });

    it('the pill opens the player too', async () => {
        render(<TourTeaser tour={TOUR} />);
        await userEvent.click(screen.getByRole('button', { name: /Watch product tour · 4 minutes/ }));
        expect(await screen.findByRole('dialog')).not.toBeNull();
    });
});
