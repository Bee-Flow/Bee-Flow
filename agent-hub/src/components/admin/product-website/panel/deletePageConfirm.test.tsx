/**
 * Run: cd agent-hub && npx vitest run src/components/admin/product-website/panel/deletePageConfirm.test.tsx --maxWorkers=2
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import useConfirm from '../../../shared/useConfirm';
import { askDeletePage, redirectTargets } from './deletePageConfirm';
import type { DeleteChoice } from './deletePageConfirm';
import type { CmsPageIndexEntry } from './cmsPanelTypes';

const pages: CmsPageIndexEntry[] = [
    { id: 'home', slug: '', title: 'Home', isHomepage: true },
    { id: 'a', slug: 'about', title: 'About' },
    { id: 'b', slug: 'old-pricing', title: 'Old pricing' },
    { id: 'nf', slug: '404', title: 'Not found', isNotFound: true },
];

describe('redirectTargets', () => {
    it('lists the other pages by address, the homepage as /, and never the deleted or the 404 page', () => {
        expect(redirectTargets(pages, 'b')).toEqual([
            { value: '/', label: 'Home' },
            { value: '/about', label: 'About' },
        ]);
    });
});

function Harness({ page, onDone }: { page: CmsPageIndexEntry; onDone: (c: DeleteChoice) => void }) {
    const { confirm, confirmDialog } = useConfirm();
    return (
        <>
            <button type="button" onClick={async () => onDone(await askDeletePage(confirm, page, pages, { title: 'Delete it?', confirmLabel: 'Delete page' }))}>ask</button>
            {confirmDialog}
        </>
    );
}

describe('askDeletePage', () => {
    it('deletes without a redirect unless one is picked', async () => {
        const user = userEvent.setup();
        const out: DeleteChoice[] = [];
        render(<Harness page={pages[2]} onDone={c => out.push(c)} />);
        await user.click(screen.getByRole('button', { name: 'ask' }));
        await user.click(screen.getByRole('button', { name: 'Delete page' }));
        expect(out).toEqual([{ confirmed: true, redirectTo: '' }]);
    });

    it('returns the picked page address as the redirect target', async () => {
        const user = userEvent.setup();
        const out: DeleteChoice[] = [];
        render(<Harness page={pages[2]} onDone={c => out.push(c)} />);
        await user.click(screen.getByRole('button', { name: 'ask' }));
        await user.selectOptions(screen.getByRole('combobox'), '/about');
        await user.click(screen.getByRole('button', { name: 'Delete page' }));
        expect(out).toEqual([{ confirmed: true, redirectTo: '/about' }]);
    });

    it('a cancelled dialog carries no redirect', async () => {
        const user = userEvent.setup();
        const out: DeleteChoice[] = [];
        render(<Harness page={pages[2]} onDone={c => out.push(c)} />);
        await user.click(screen.getByRole('button', { name: 'ask' }));
        await user.selectOptions(screen.getByRole('combobox'), '/about');
        await user.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(out).toEqual([{ confirmed: false, redirectTo: '' }]);
    });

    it('offers no choice for the homepage (it has no old address to redirect)', async () => {
        const user = userEvent.setup();
        render(<Harness page={pages[0]} onDone={() => {}} />);
        await user.click(screen.getByRole('button', { name: 'ask' }));
        expect(screen.queryByRole('combobox')).toBeNull();
    });
});
