import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { withQueryClient } from '@/test/queryWrapper';
import type { Starter } from '../documentQueries';

const STARTERS = vi.hoisted(() => [
    { id: 'invoice', name: 'Invoice', docType: 'invoice', settings: { contract: { parameters: [{ key: 'a' }, { key: 'b' }, { key: 'c' }] } } },
    { id: 'letter', name: 'Letter', docType: 'letter', settings: { contract: { parameters: [] } } },
    { id: 'proposal', name: 'Quote', docType: 'quote', settings: { contract: { parameters: [{ key: 'a' }] } } },
    { id: 'deck-review', name: 'Quarterly review', docType: 'presentation', settings: { contract: { parameters: [] } } },
]);

vi.mock('../documentQueries', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../documentQueries')>()),
    useStarters: () => ({ data: STARTERS, isPending: false, isError: false }),
}));

import StarterGallery from './StarterGallery';

const base = { open: true, busy: false, error: null, onClose: vi.fn() };
const groupHeadings = () => screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
const group = (name: string) => screen.getByRole('region', { name });

describe('StarterGallery: groups by purpose', () => {
    it('offers Write, Calculate, For customers and Present in the documents view', () => {
        render(withQueryClient(<StarterGallery {...base} notebooks spreadsheets onChoose={vi.fn()} />));
        expect(groupHeadings()).toEqual(['Write', 'Calculate', 'For customers', 'Present']);
        expect(within(group('Write')).getByRole('button', { name: /Page/ })).toBeInTheDocument();
        expect(within(group('Write')).getByRole('button', { name: /Notebook/ })).toBeInTheDocument();
        expect(within(group('Calculate')).getByRole('button', { name: /Spreadsheet/ })).toBeInTheDocument();
        const customers = within(group('For customers'));
        expect(customers.getByRole('button', { name: /Blank customer document/ })).toBeInTheDocument();
        expect(customers.getByRole('button', { name: /Invoice/ })).toBeInTheDocument();
        expect(customers.queryByRole('button', { name: /Quarterly review/ })).not.toBeInTheDocument();
        const present = within(group('Present'));
        expect(present.getByRole('button', { name: /Blank presentation/ })).toBeInTheDocument();
        expect(present.getByRole('button', { name: /Quarterly review/ })).toBeInTheDocument();
    });

    it('leaves out Calculate and the notebook when the reader may not make them', () => {
        render(withQueryClient(<StarterGallery {...base} onChoose={vi.fn()} />));
        expect(groupHeadings()).toEqual(['Write', 'For customers', 'Present']);
        expect(screen.queryByRole('button', { name: /Notebook/ })).not.toBeInTheDocument();
    });

    it('says what a spreadsheet and a customer document are for, without jargon', () => {
        render(withQueryClient(<StarterGallery {...base} spreadsheets onChoose={vi.fn()} />));
        const text = screen.getByTestId('document-gallery').textContent || '';
        expect(text).toContain('Rows, columns and formulas like =SUM(A1:A9). Apps and automations can read it.');
        expect(text).toContain('A laid-out document such as a quote or letter, with fields you fill in per customer.');
        expect(text).not.toMatch(/datatable|an automation can fill/i);
    });

    it('counts the fields only when a starter has some', () => {
        render(withQueryClient(<StarterGallery {...base} onChoose={vi.fn()} />));
        expect(screen.getByRole('button', { name: /Invoice/ })).toHaveTextContent('3 fields to fill in');
        expect(screen.getByRole('button', { name: /Quote/ })).toHaveTextContent('1 field to fill in');
        expect(screen.getByRole('button', { name: /Letter/ })).not.toHaveTextContent(/field/);
    });

    it('gives a page a plain page icon, not the notebook pen', () => {
        render(withQueryClient(<StarterGallery {...base} notebooks onChoose={vi.fn()} />));
        const page = screen.getByTestId('documents-new-page');
        const notebook = screen.getByTestId('documents-new-notebook');
        expect(page.querySelector('svg')?.getAttribute('class')).toMatch(/lucide-file-text/);
        expect(notebook.querySelector('svg')?.getAttribute('class')).not.toEqual(page.querySelector('svg')?.getAttribute('class'));
    });
});

describe('StarterGallery: templates and reusable sections', () => {
    it('offers only customer documents and presentations in the templates view, and says why', () => {
        render(withQueryClient(<StarterGallery {...base} view="template" notebooks spreadsheets onChoose={vi.fn()} />));
        expect(groupHeadings()).toEqual(['For customers', 'Present']);
        expect(screen.queryByTestId('documents-new-page')).not.toBeInTheDocument();
        expect(screen.queryByTestId('documents-new-notebook')).not.toBeInTheDocument();
        expect(screen.queryByTestId('documents-new-spreadsheet')).not.toBeInTheDocument();
        expect(screen.getByText('Pages, notebooks and spreadsheets are made in Documents.')).toBeInTheDocument();
    });

    it('never offers a presentation as a reusable section', () => {
        render(withQueryClient(<StarterGallery {...base} view="section" notebooks spreadsheets onChoose={vi.fn()} />));
        expect(groupHeadings()).toEqual(['For customers']);
        expect(screen.queryByRole('button', { name: /presentation/i })).not.toBeInTheDocument();
        expect(screen.getByText(/Pages, notebooks and spreadsheets are made in Documents/)).toBeInTheDocument();
    });
});

describe('StarterGallery: own templates', () => {
    it('lists them last and hands the chosen one back', async () => {
        const user = userEvent.setup();
        const onChoose = vi.fn();
        const template = { id: 't1', name: 'Quarterly report', docType: 'report' };
        render(withQueryClient(<StarterGallery {...base} templates={[template, { id: 't2', name: 'Pitch', docType: 'presentation' }]} onChoose={onChoose} />));
        expect(groupHeadings()).toEqual(['Write', 'For customers', 'Present', 'Your templates']);
        await user.click(screen.getByRole('button', { name: 'Quarterly report' }));
        expect(onChoose).toHaveBeenCalledWith({ type: 'template', template });
    });

    it('shows no section without templates, nor in the templates view', () => {
        const { unmount } = render(withQueryClient(<StarterGallery {...base} onChoose={vi.fn()} />));
        expect(screen.queryByText('Your templates')).not.toBeInTheDocument();
        unmount();
        render(withQueryClient(<StarterGallery {...base} view="template" templates={[{ id: 't1', name: 'Mine' }]} onChoose={vi.fn()} />));
        expect(screen.queryByText('Your templates')).not.toBeInTheDocument();
    });

    it('hands a starter back with its kind of choice', async () => {
        const user = userEvent.setup();
        const onChoose = vi.fn();
        render(withQueryClient(<StarterGallery {...base} onChoose={onChoose} />));
        await user.click(screen.getByRole('button', { name: /Quarterly review/ }));
        expect(onChoose).toHaveBeenCalledWith({ type: 'deck', starter: STARTERS[3] as unknown as Starter });
    });
});
