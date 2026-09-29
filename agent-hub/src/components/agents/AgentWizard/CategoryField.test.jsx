/**
 * BFSF-272 — CategoryField manage popover.
 *
 * Pins: the manage popover lists categories with rename/delete; rename calls
 * onRename and shows inline errors; the guided in-use delete flow offers
 * unassign vs merge and fires the right onDelete call; duplicate create
 * (existed:true) shows the "already exists — selected it" hint instead of an
 * alert(); the manage button hides when there are no categories.
 *
 * Run: cd agent-hub && npx vitest run src/components/admin/AgentWizard/CategoryField.test.jsx
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import CategoryField from './CategoryField';

const t = (key, fallback, params) => {
    let s = fallback || key;
    for (const [k, v] of Object.entries(params || {})) s = s.replace(`{${k}}`, v);
    return s;
};

const CATS = [
    { id: 'sales', name: 'Sales' },
    { id: 'marketing', name: 'Marketing' },
];

function renderField(overrides = {}) {
    const props = {
        t,
        value: null,
        categories: CATS,
        onChange: vi.fn(),
        onCreate: vi.fn(async () => ({ ok: true, category: { id: 'x', name: 'X' } })),
        onRename: vi.fn(async () => ({ ok: true })),
        onDelete: vi.fn(async () => ({ ok: true })),
        ...overrides,
    };
    const utils = render(<CategoryField {...props} />);
    return { ...utils, props };
}

const openManage = () => fireEvent.click(screen.getByTitle('Manage categories'));

describe('CategoryField — manage popover (BFSF-272)', () => {
    it('manage button opens a popover listing every category; hidden without categories', () => {
        const { unmount } = renderField();
        openManage();
        expect(screen.getAllByText('Sales').length).toBeGreaterThan(0);
        expect(screen.getAllByText('Marketing').length).toBeGreaterThan(0);
        unmount();

        renderField({ categories: [] });
        expect(screen.queryByTitle('Manage categories')).toBeNull();
    });

    it('inline rename calls onRename; a server error surfaces inline', async () => {
        const onRename = vi.fn(async () => ({ ok: false, error: 'A category named "Marketing" already exists' }));
        renderField({ onRename });
        openManage();

        fireEvent.click(screen.getAllByTitle('Rename')[0]);
        const input = screen.getByDisplayValue('Sales');
        fireEvent.change(input, { target: { value: 'Marketing' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(onRename).toHaveBeenCalledWith('sales', 'Marketing');
            expect(screen.getByText(/already exists/)).toBeTruthy();
        });
    });

    it('delete on an in-use category walks the guided flow: unassign', async () => {
        const onDelete = vi.fn()
            .mockResolvedValueOnce({ ok: false, code: 'category_in_use', count: 3 })
            .mockResolvedValueOnce({ ok: true });
        renderField({ onDelete });
        openManage();

        fireEvent.click(screen.getAllByTitle('Delete')[0]);
        fireEvent.click(screen.getByText('Delete', { selector: 'button' })); // ConfirmDialog confirm

        // 409 → guided step appears with the live count.
        await waitFor(() => expect(screen.getByText(/In use by 3 agent/)).toBeTruthy());

        // Default choice = unassign; confirm.
        const guidedDelete = screen.getAllByText('Delete').at(-1);
        fireEvent.click(guidedDelete);
        await waitFor(() => {
            expect(onDelete).toHaveBeenNthCalledWith(1, 'sales');
            expect(onDelete).toHaveBeenNthCalledWith(2, 'sales', 'none');
        });
    });

    it('duplicate create shows the "already exists — selected it" hint (no alert)', async () => {
        const onCreate = vi.fn(async () => ({ ok: true, existed: true, category: CATS[0] }));
        renderField({ onCreate });

        fireEvent.click(screen.getByTitle('New category'));
        const input = screen.getByPlaceholderText('New category name');
        fireEvent.change(input, { target: { value: 'sales' } });
        fireEvent.keyDown(input, { key: 'Enter' });

        await waitFor(() => {
            expect(onCreate).toHaveBeenCalledWith('sales');
            expect(screen.getByText(/already exists — selected it/)).toBeTruthy();
        });
    });
});

// ── A3 deel B: dezelfde component op chipformaat ────────────────────
//
// `variant="tag"` is een SKIN, geen tweede component. Deze tests pinnen dat
// vast: hetzelfde native <select> (dus hetzelfde toetsenbord, dezelfde
// schermlezer, dezelfde mobiele kiezer), dezelfde aanmaak- en beheerpaden.
describe('CategoryField — variant="tag" (A3)', () => {
    it('blijft één native select, met een naam nu de kop erboven weg is', () => {
        renderField({ variant: 'tag', value: 'sales' });
        const select = screen.getByTestId('agent-category-select');
        expect(select.tagName).toBe('SELECT');
        // De chip heeft geen ruimte voor een zichtbaar label, dus de naam moet
        // ergens anders vandaan komen — anders heet dit veld voor een
        // schermlezer niets.
        expect(select.getAttribute('aria-label')).toBe('Category');
        expect(select.value).toBe('sales');
    });

    it('kan nog steeds een categorie aanmaken en beheren', async () => {
        const onCreate = vi.fn(async () => ({ ok: true, category: { id: 'x', name: 'X' } }));
        renderField({ variant: 'tag', onCreate });

        fireEvent.click(screen.getByTitle('New category'));
        const input = screen.getByPlaceholderText('New category name');
        fireEvent.change(input, { target: { value: 'Support' } });
        fireEvent.keyDown(input, { key: 'Enter' });
        await waitFor(() => expect(onCreate).toHaveBeenCalledWith('Support'));

        openManage();
        expect(screen.getAllByText('Sales').length).toBeGreaterThan(0);
    });

    it('geeft een keuze door aan de ouder, net als de volle variant', () => {
        const onChange = vi.fn();
        renderField({ variant: 'tag', onChange });
        fireEvent.change(screen.getByTestId('agent-category-select'), { target: { value: 'marketing' } });
        expect(onChange).toHaveBeenCalledWith('marketing');
    });
});
