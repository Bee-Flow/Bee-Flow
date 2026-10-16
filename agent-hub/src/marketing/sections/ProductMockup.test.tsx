import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProductMockup from './ProductMockup';

const DATA = {
    enabled: true,
    prompt: 'Create a scenario that watches my inbox',
    tilt: 'left',
    steps: [{ role: 'user', text: 'Hello' }, { role: 'card', title: 'Done', text: 'Scenario ready' }],
};

describe('ProductMockup', () => {
    afterEach(() => { vi.unstubAllGlobals(); });

    it('shows the finished state at once with reduced motion', () => {
        vi.stubGlobal('matchMedia', () => ({ matches: true }));
        const { container } = render(<ProductMockup data={DATA} />);
        expect(screen.getAllByText(DATA.prompt).length).toBeGreaterThan(0);
        expect(container.querySelectorAll('.product-mockup-step[data-shown="true"]')).toHaveLength(2);
        expect(container.querySelector('.product-mockup-untyped')).toBeNull();
        expect(container.querySelector('.product-mockup-stage--tilt-left')).not.toBeNull();
        expect(container.querySelector('.product-mockup-caret')).toBeNull();
    });

    it('has every step and the whole prompt in the markup before the animation, only not shown yet', () => {
        vi.stubGlobal('matchMedia', () => ({ matches: false }));
        vi.stubGlobal('IntersectionObserver', class {
            observe() { /* never intersects */ }
            disconnect() { /* nothing */ }
        });
        const { container } = render(<ProductMockup data={DATA} />);
        // All steps are rendered (final size reserved, text readable), none shown yet.
        const steps = container.querySelectorAll('.product-mockup-step');
        expect(steps).toHaveLength(2);
        expect([...steps].map((el) => el.getAttribute('data-shown'))).toEqual(['false', 'false']);
        expect(steps[1].textContent).toContain('Scenario ready');
        expect(steps[1].hasAttribute('aria-hidden')).toBe(false);
        // The prompt box holds the full text from the start: what is not typed yet is invisible.
        expect(container.querySelector('.product-mockup-untyped')?.textContent).toBe(DATA.prompt);
        // The full prompt stays available to screen readers.
        expect(container.querySelector('.product-mockup-sr')?.textContent).toBe(DATA.prompt);
    });
});
