// The three tabs of an item: the ARIA tabs pattern (one tab stop, arrow keys, Home/End), only the chosen panel is
// rendered, and the choice is remembered per item for the session, also when the storage refuses.
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import CoworkTabs from './CoworkTabs';
import type { CoworkTab } from './CoworkTabs';

const rendered: string[] = [];
const tab = (id: string, label: string): CoworkTab => ({
    id,
    label,
    render: () => { rendered.push(id); return <p>{`${label} panel`}</p>; },
});
const TABS = [tab('runs', 'Runs'), tab('plan', 'Plan'), tab('settings', 'Settings')];

beforeEach(() => { window.sessionStorage.clear(); rendered.length = 0; });
afterEach(() => { vi.restoreAllMocks(); });

describe('CoworkTabs', () => {
    it('opens on the first tab and renders only the chosen panel', () => {
        render(<CoworkTabs scope="w1" tabs={TABS} label="This work" />);
        expect(screen.getByRole('tablist', { name: 'This work' })).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');
        const panel = screen.getByRole('tabpanel');
        expect(panel).toHaveTextContent('Runs panel');
        expect(panel).toHaveAttribute('aria-labelledby', screen.getByRole('tab', { name: 'Runs' }).id);
        expect(new Set(rendered)).toEqual(new Set(['runs']));
    });

    it('has one tab stop, and the arrow keys, Home and End move to and choose a tab', async () => {
        render(<CoworkTabs scope="w1" tabs={TABS} label="This work" />);
        const user = userEvent.setup();
        expect(screen.getAllByRole('tab').map((el) => el.tabIndex)).toEqual([0, -1, -1]);
        await user.tab();
        expect(screen.getByRole('tab', { name: 'Runs' })).toHaveFocus();
        await user.keyboard('{ArrowRight}');
        expect(screen.getByRole('tab', { name: 'Plan' })).toHaveFocus();
        expect(screen.getByRole('tab', { name: 'Plan' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tabpanel')).toHaveTextContent('Plan panel');
        await user.keyboard('{End}');
        expect(screen.getByRole('tab', { name: 'Settings' })).toHaveFocus();
        await user.keyboard('{ArrowRight}');
        expect(screen.getByRole('tab', { name: 'Runs' })).toHaveFocus();
        await user.keyboard('{ArrowLeft}');
        expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
        await user.keyboard('{Home}');
        expect(screen.getByRole('tabpanel')).toHaveTextContent('Runs panel');
    });

    it('remembers the chosen tab per item', async () => {
        const { unmount } = render(<CoworkTabs scope="w1" tabs={TABS} label="This work" />);
        await userEvent.setup().click(screen.getByRole('tab', { name: 'Settings' }));
        unmount();

        render(<CoworkTabs scope="w1" tabs={TABS} label="This work" />);
        expect(screen.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tabpanel')).toHaveTextContent('Settings panel');
    });

    it('another item opens on its own choice, not the last one made', async () => {
        const { rerender } = render(<CoworkTabs scope="w1" tabs={TABS} label="This work" />);
        await userEvent.setup().click(screen.getByRole('tab', { name: 'Plan' }));
        rerender(<CoworkTabs scope="w2" tabs={TABS} label="This work" />);
        expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');
        rerender(<CoworkTabs scope="w1" tabs={TABS} label="This work" />);
        expect(screen.getByRole('tab', { name: 'Plan' })).toHaveAttribute('aria-selected', 'true');
    });

    it('a remembered tab that no longer exists falls back to the first', () => {
        window.sessionStorage.setItem('bee-flow.cowork.tab.w1', 'gone');
        render(<CoworkTabs scope="w1" tabs={TABS} label="This work" />);
        expect(screen.getByRole('tab', { name: 'Runs' })).toHaveAttribute('aria-selected', 'true');
    });

    it('still switches tabs when the storage refuses', async () => {
        vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
        render(<CoworkTabs scope="w1" tabs={TABS} label="This work" />);
        await userEvent.setup().click(screen.getByRole('tab', { name: 'Plan' }));
        expect(screen.getByRole('tabpanel')).toHaveTextContent('Plan panel');
    });
});
