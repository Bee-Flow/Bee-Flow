import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import AppShell from '../AppShell';
import { navModel } from './navModel';
import { shellOptions } from './shellOptions';

/**
 * A screen gated with visibleToRoles is gated together with its nav entry: a viewer whose role
 * may not open it never sees it offered in the tabs, the sidebar, the rail, the mega bar or the
 * mobile drawer, a group left without screens disappears, and a nav.items link to it goes too.
 * The owner (no previewRole, or 'owner') still sees every entry.
 */

const scr = (id: string, name: string, extra = {}) => ({ id, name, icon: null, showInNav: true, sections: [], ...extra });

const MANAGERS = { visibleToRoles: ['manager'] };

const DEF = {
    schemaVersion: 3,
    meta: { name: 'Role nav', description: '', icon: 'LayoutGrid' },
    theme: { primary: '#0F766E', appearance: 'auto' },
    homeScreenId: 'scr_home01',
    roles: [{ key: 'member', label: 'Member' }, { key: 'manager', label: 'Manager' }],
    screens: [
        scr('scr_home01', 'Home'),
        scr('scr_team01', 'Team'),
        scr('scr_rep001', 'Report', MANAGERS),
        scr('scr_ldg001', 'Ledger', MANAGERS),
    ],
};

const navOf = (style: string) => ({
    style,
    groups: [
        { id: 'nvg_work01', label: 'Work', icon: null, screens: ['scr_team01'] },
        { id: 'nvg_rep001', label: 'Reports', icon: null, screens: ['scr_rep001'] },
    ],
    items: [{ id: 'nvi_rep001', label: 'Open report', icon: null, screenId: 'scr_rep001' }],
});

function renderAs(style: string, previewRole: string | null) {
    return render(
        <AppShell definition={{ ...DEF, nav: navOf(style) } as never} screenId="scr_home01" onNavigate={() => {}} previewRole={previewRole}>
            <div>content</div>
        </AppShell>,
    );
}

const RESTRICTED = ['Report', 'Ledger', 'Reports', 'Open report'];

beforeEach(() => {
    window.localStorage.clear();
});

describe('nav entries follow the screen role gate', () => {
    for (const style of ['tabs', 'sidebar', 'rail', 'mega']) {
        it(`${style}: a member sees no entry, group or link for a manager-only screen`, () => {
            renderAs(style, 'member');
            const nav = screen.getAllByRole('navigation', { name: 'App screens' })[0];
            // The mega bar shows a group as its trigger; Team sits in the closed Work panel.
            expect(nav.textContent).toContain(style === 'mega' ? 'Work' : 'Team');
            for (const label of RESTRICTED) {
                expect(screen.queryAllByText(label, { exact: true })).toHaveLength(0);
            }
        });

        it(`${style}: a manager and the owner still see them`, () => {
            for (const role of ['manager', null, 'owner']) {
                const { container, unmount } = renderAs(style, role);
                // The mega bar keeps grouped screens in a closed panel: its trigger is what shows.
                const expected = style === 'mega' ? ['Ledger', 'Reports'] : ['Ledger', 'Report'];
                for (const label of expected) expect(container.textContent).toContain(label);
                unmount();
            }
        });
    }

    it('the mobile drawer leaves the restricted screens and their empty group out', async () => {
        const user = userEvent.setup();
        const { container } = renderAs('sidebar', 'member');
        await user.click(container.querySelector('button[aria-haspopup="dialog"]')!);
        const drawer = screen.getByRole('dialog', { name: 'App screens' });
        expect(within(drawer).getByRole('button', { name: 'Team' })).toBeInTheDocument();
        for (const label of RESTRICTED) {
            expect(within(drawer).queryByText(label, { exact: true })).toBeNull();
        }
    });
});

describe('navModel and shellOptions with a role', () => {
    const def = { ...DEF, nav: navOf('sidebar') };

    it('drop gated screens, the group they empty, and the items that point at them', () => {
        const model = navModel(def, 'member');
        expect(model.flat.map((s) => s.id)).toEqual(['scr_home01', 'scr_team01']);
        expect(model.groups.map((g) => g.label)).toEqual(['Work']);
        expect(shellOptions(def, 'member').items).toEqual([]);
    });

    it('keep everything without a role (the owner, the editor outside "View as")', () => {
        expect(navModel(def).flat.map((s) => s.id)).toEqual(['scr_home01', 'scr_ldg001', 'scr_team01', 'scr_rep001']);
        expect(navModel(def, 'owner').groups.map((g) => g.label)).toEqual(['Work', 'Reports']);
        expect(shellOptions(def).items.map((i) => i.label)).toEqual(['Open report']);
    });
});
