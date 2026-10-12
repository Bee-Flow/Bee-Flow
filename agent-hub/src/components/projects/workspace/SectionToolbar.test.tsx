import { render, screen, within } from '@testing-library/react';
import { BookOpen } from 'lucide-react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import SectionToolbar from './SectionToolbar';

vi.mock('../../../hooks/useTranslation', () => ({ default: () => ({ t: (_k: string, f: string) => f, locale: 'en' }) }));
const viewport = { isDesktop: true, isCompact: false, isMobile: false, width: 1920 };
vi.mock('../../../hooks/useViewport', () => ({ default: () => viewport, useViewport: () => viewport }));

describe('SectionToolbar', () => {
    afterEach(() => { viewport.isDesktop = true; });
    it('desktop: tile, title, count chip, primary and extras in the header; search below', () => {
        render(<SectionToolbar kind="document" title="Documents" count={3} search="" onSearch={() => {}} searchLabel="Search documents" primary={<button type="button">New</button>} extras={<button type="button">Add existing</button>} />);
        const header = screen.getByTestId('studio-section-header');
        expect(within(header).getByRole('heading', { name: 'Documents' })).toBeInTheDocument();
        expect(within(header).getByTestId('content-count')).toHaveTextContent('3');
        expect(within(header).getByRole('button', { name: 'New' })).toBeInTheDocument();
        expect(within(header).getByRole('button', { name: 'Add existing' })).toBeInTheDocument();
        expect(within(header).getByTestId('studio-section-kind')).toHaveAttribute('data-kind', 'document');
        expect(screen.getByRole('searchbox', { name: 'Search documents' })).toBeInTheDocument();
    });
    it('no chip while the count is unknown', () => {
        render(<SectionToolbar icon={BookOpen} title="Knowledge" count={null} />);
        expect(screen.queryByTestId('content-count')).toBeNull();
    });
    it('compact: the actions move below the header, primary first', () => {
        viewport.isDesktop = false;
        render(<SectionToolbar kind="meeting" title="Meetings" primary={<button type="button">Record</button>} extras={<button type="button">Add existing</button>} />);
        const header = screen.getByTestId('studio-section-header');
        expect(within(header).queryByRole('button', { name: 'Record' })).toBeNull();
        const buttons = screen.getAllByRole('button').map((b) => b.textContent);
        expect(buttons.indexOf('Record')).toBeLessThan(buttons.indexOf('Add existing'));
    });
});
