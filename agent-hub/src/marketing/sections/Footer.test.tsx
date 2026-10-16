import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Footer from './Footer';
import Header from './Header';
import type { FooterData } from './Footer.types';
import type { HeaderData } from './Header.types';

// One wrong-typed header/footer setting used to throw while rendering and
// blank every public page. The footer reads such a value as empty; anything
// that still throws hides only that part of the chrome.

vi.mock('../../utils/clientErrorReporter', () => ({ reportClientError: vi.fn(async () => undefined) }));

const wrongTypes = (patch: Record<string, unknown>): FooterData =>
    ({ enabled: true, copyright: 'Footer text', ...patch }) as FooterData;

describe('Footer with wrong-typed settings', () => {
    beforeEach(() => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    it('renders when columns is a string', () => {
        const { container } = render(<Footer data={wrongTypes({ columns: 'x' })} />);
        expect(container.textContent).toContain('Footer text');
        expect(container.querySelectorAll('.footer-col')).toHaveLength(0);
    });

    it('renders when a column links list and the socials are not arrays', () => {
        const { container } = render(
            <Footer data={wrongTypes({ columns: [{ heading: 'Col', links: 'nope' }], socials: 5 })} />,
        );
        expect(container.textContent).toContain('Col');
    });

    it('renders when accountability and brand are the wrong type', () => {
        const { container } = render(
            <Footer data={wrongTypes({ accountability: 'x', brand: 3 })} />,
        );
        expect(container.textContent).toContain('Footer text');
    });
});

describe('header and footer error boundary', () => {
    beforeEach(() => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
    });

    it('hides a header that throws instead of failing the page', () => {
        const bad = { enabled: true, logoText: 'T', ctas: 'x' } as unknown as HeaderData;
        const { container } = render(
            <div>
                <Header data={bad} />
                <main>page body</main>
            </div>,
        );
        expect(container.textContent).toContain('page body');
    });

    it('hides a footer that throws instead of failing the page', () => {
        const data = wrongTypes({ copyright: { toString: () => { throw new Error('boom'); } } });
        const { container } = render(
            <div>
                <Footer data={data} />
                <main>page body</main>
            </div>,
        );
        expect(container.textContent).toContain('page body');
    });
});

describe('SiteChromeGuard reset', () => {
    it('shows the part again once its data changes', () => {
        vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const bad = wrongTypes({ copyright: { toString: () => { throw new Error('boom'); } } });
        const { container, rerender } = render(<Footer data={bad} />);
        expect(container.textContent).not.toContain('Fixed text');
        rerender(<Footer data={wrongTypes({ copyright: 'Fixed text' })} />);
        expect(container.textContent).toContain('Fixed text');
    });
});
