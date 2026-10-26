import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CreatePageContext, LinkField, RepeatableList, resolveCmsAssetUrl } from '../fields';
import type { CmsLink } from '../fields';

vi.mock('@/hooks/useTranslation', () => import('@/test/useTranslationParamsMock'));

afterEach(cleanup);

describe('field kit', () => {
    it('resolves bare CMS asset keys to the asset route', () => {
        expect(resolveCmsAssetUrl('cms/a b/x.png')).toBe('/api/cms/asset/cms/a%20b/x.png');
        expect(resolveCmsAssetUrl('https://x/y.png')).toBe('https://x/y.png');
        expect(resolveCmsAssetUrl(null)).toBe('');
    });

    it('RepeatableList collapses existing rows, expands a new one, and reorders', async () => {
        const user = userEvent.setup();
        function Harness() {
            const [items, setItems] = useState([{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]);
            return (
                <RepeatableList
                    items={items}
                    onChange={setItems}
                    collapsible
                    itemLabel={(it) => it.name}
                    makeNew={() => ({ id: 'c', name: 'Gamma' })}
                    renderItem={(it) => <span>body:{it.name}</span>}
                />
            );
        }
        render(<Harness />);
        expect(screen.queryByText('body:Alpha')).toBeNull();
        await user.click(screen.getByRole('button', { name: '+ Add item' }));
        expect(screen.getByText('body:Gamma')).toBeTruthy();
        await user.click(screen.getByRole('button', { name: 'Move item 2 up' }));
        const labels = screen.getAllByText(/^(Alpha|Beta|Gamma)$/).map(el => el.textContent);
        expect(labels).toEqual(['Beta', 'Alpha', 'Gamma']);
    });

    it('LinkField flags a dangling page and creates a page inline through the context', async () => {
        const user = userEvent.setup();
        const onChange = vi.fn();
        const createPage = vi.fn(async () => ({ id: 'p9', slug: 'pricing', title: 'Pricing' }));
        const pages = [{ id: 'p1', slug: 'home', title: 'Home', isHomepage: true }];
        const link: CmsLink = { kind: 'page', pageId: 'gone' };
        render(
            <CreatePageContext.Provider value={createPage}>
                <LinkField value={link} onChange={onChange} pages={pages} />
            </CreatePageContext.Provider>,
        );
        expect(screen.getByText('This link points to a page that no longer exists. Pick another page above.')).toBeTruthy();
        await user.selectOptions(screen.getAllByRole('combobox')[1], '__cms_new_page__');
        await user.type(screen.getByPlaceholderText('e.g. Pricing'), 'Pricing Plans');
        expect((screen.getByPlaceholderText('auto') as HTMLInputElement).value).toBe('pricing-plans');
        await user.click(screen.getByRole('button', { name: 'Create page' }));
        await waitFor(() => expect(onChange).toHaveBeenCalledWith({ kind: 'page', pageId: 'p9' }));
        expect(createPage).toHaveBeenCalledWith({ title: 'Pricing Plans', slug: 'pricing-plans' });
    });
});
