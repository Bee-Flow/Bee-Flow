import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import CardCarousel from './CardCarousel';

const DATA = {
    enabled: true,
    title: 'Models',
    cards: [
        { title: 'One', body: 'First card', gradient: 'mix' },
        { title: 'Two', body: 'Second card', linkLabel: 'Read more', link: { href: '/two' } },
    ],
};

describe('CardCarousel', () => {
    it('renders every card as text with ghost numerals hidden from assistive tech', () => {
        const { container } = render(<CardCarousel data={DATA} />);
        expect(screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent)).toEqual(['One', 'Two']);
        expect(container.querySelector('.card-carousel-numeral')?.getAttribute('aria-hidden')).toBe('true');
        expect(container.querySelector('.card-carousel-card--mix')).not.toBeNull();
        expect(screen.getByRole('link', { name: 'Read more' }).getAttribute('href')).toBe('/two');
    });

    it('scrolls one card with the arrow keys and the buttons', async () => {
        const scrollBy = vi.fn();
        Element.prototype.scrollBy = scrollBy;
        render(<CardCarousel data={DATA} />);
        const region = screen.getByRole('region');
        region.focus();
        await userEvent.keyboard('{ArrowRight}');
        expect(scrollBy).toHaveBeenCalledTimes(1);
        expect(scrollBy.mock.calls[0][0].left).toBeGreaterThan(0);
        await userEvent.keyboard('{ArrowLeft}');
        expect(scrollBy.mock.calls[1][0].left).toBeLessThan(0);
        expect(screen.getByRole('button', { name: 'Previous' })).toBeTruthy();
    });

    it('can switch the gradient animation off', () => {
        const { container } = render(<CardCarousel data={{ ...DATA, animated: false }} />);
        expect(container.querySelector('.card-carousel-block--animated')).toBeNull();
    });
});
