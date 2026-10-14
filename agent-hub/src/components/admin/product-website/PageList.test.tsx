import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import PageList from './PageList';

vi.mock('../../../hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));

afterEach(cleanup);

const pages = [
    { id: 'p1', title: 'Home', slug: 'home', isHomepage: true },
    { id: 'p2', title: 'About', slug: 'about' },
];

function renderList(overrides: Partial<Parameters<typeof PageList>[0]> = {}) {
    const props = {
        pages,
        activePageId: 'p1',
        onSelect: vi.fn(),
        onAdd: vi.fn(),
        onDuplicate: vi.fn(),
        onDelete: vi.fn(),
        onSetHomepage: vi.fn(),
        onRename: vi.fn(),
        onEditSlug: vi.fn(),
        onReorder: vi.fn(),
        ...overrides,
    };
    render(<PageList {...props} />);
    return props;
}

describe('PageList', () => {
    it('lists pages and selects one on click', async () => {
        const user = userEvent.setup();
        const props = renderList();
        expect(screen.getByText('/about')).toBeTruthy();
        await user.click(screen.getByText('About'));
        expect(props.onSelect).toHaveBeenCalledWith('p2');
    });

    it('adds a page with an auto-derived slug and blocks a duplicate slug', async () => {
        const user = userEvent.setup();
        const props = renderList({ templates: [{ id: 't1', name: 'Landing', blockCount: 1 }] });
        await user.click(screen.getByTitle('Add page'));
        expect(screen.getByText('1 block')).toBeTruthy();
        await user.type(screen.getByPlaceholderText('Page title'), 'About');
        const add = screen.getByText('Add page', { selector: 'button' }) as HTMLButtonElement;
        expect(add.disabled).toBe(true);
        await user.clear(screen.getByPlaceholderText('Page title'));
        await user.type(screen.getByPlaceholderText('Page title'), 'Pricing Plans');
        await user.click(screen.getByText('Landing'));
        await user.click(screen.getByText('Add page', { selector: 'button' }));
        expect(props.onAdd).toHaveBeenCalledWith({ title: 'Pricing Plans', slug: 'pricing-plans', templateId: 't1' });
    });

    it('renames a page from the row menu', async () => {
        const user = userEvent.setup();
        const props = renderList();
        await user.click(screen.getAllByTitle('Page actions')[1]);
        await user.click(screen.getByRole('button', { name: 'Rename page' }));
        const input = screen.getByDisplayValue('About');
        await user.clear(input);
        await user.type(input, 'Company{Enter}');
        expect(props.onRename).toHaveBeenCalledWith('p2', 'Company');
    });

    it('deletes a template after the inline confirm', async () => {
        const user = userEvent.setup();
        const onDeleteTemplate = vi.fn(async () => {});
        renderList({ templates: [{ id: 't1', name: 'Landing', blockCount: 3 }], onDeleteTemplate });
        await user.click(screen.getByTitle('Manage templates'));
        expect(screen.getByText('3 blocks')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Delete template "Landing"' }));
        await user.click(screen.getByRole('button', { name: 'Delete' }));
        await waitFor(() => expect(onDeleteTemplate).toHaveBeenCalledWith('t1'));
    });
});
