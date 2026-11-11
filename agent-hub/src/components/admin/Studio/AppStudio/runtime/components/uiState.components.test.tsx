import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import AppRenderer from '../AppRenderer';
import { closeAppModal, openAppModal } from './AppModal';
import { getUiSnapshot, resetUiStateForTests, setUiState } from '../uiState';
import { tabIndexOf } from './tabsUiState';
import { selectionFromValue } from './grid/useGridUiSelection';
import type { AppDefinition, AppNode } from '../../inspector/appDefinition';

/**
 * The `ui` scope root (runtime/uiState.ts) as the components lift into it: a tabs
 * group publishes its active tab and a set_ui value switches it, a modal publishes
 * whether it is open, and a formula elsewhere on the screen follows both. In edit
 * mode nothing is published, so the canvas behaves exactly as before.
 */

function defWith(children: unknown[]): AppDefinition {
    return {
        schemaVersion: 3,
        meta: { name: 'T', description: '', icon: 'LayoutGrid' },
        theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'auto' },
        homeScreenId: 'scr_t',
        screens: [{
            id: 'scr_t', name: 'T', icon: null, showInNav: true, maxWidth: 'medium',
            sections: [{ id: 'sec_t', style: { padding: 4, gap: 3, background: 'none' }, children: children as AppNode[] }],
        }],
        actions: {},
    } as unknown as AppDefinition;
}

const tabs = {
    id: 'cmp_tabs', type: 'tabs', visible: true, props: {}, style: { span: 12, gap: 3, padding: 0 },
    children: [
        { id: 'cmp_taba', type: 'tab', visible: true, props: { label: 'First', icon: null }, style: { gap: 3, padding: 0 }, children: [] },
        { id: 'cmp_tabb', type: 'tab', visible: true, props: { label: 'Second', icon: null }, style: { gap: 3, padding: 0 }, children: [] },
    ],
};
const modal = { id: 'cmp_modal', type: 'modal', visible: true, props: { title: 'Details', showTrigger: false }, style: { gap: 3 }, children: [] };
const probe = { id: 'cmp_probe', type: 'text', visible: true, props: { text: '-' }, computed: { text: "ui.tabs.cmp_tabs.active + '/' + ui.modals.cmp_modal.open" }, style: { span: 12 } };

afterEach(() => { resetUiStateForTests(); });

describe('ui state lifted from the components', () => {
    it('a formula follows the active tab and the modal, and set_ui switches the tab', async () => {
        render(<AppRenderer definition={defWith([tabs, modal, probe])} screenId="scr_t" mode="run" />);
        expect(screen.getByText('cmp_taba/false')).toBeTruthy();

        await act(async () => { setUiState('cmp_tabs', 'activeTab', 'cmp_tabb'); });
        expect(screen.getByText('cmp_tabb/false')).toBeTruthy();
        expect(screen.getByRole('tab', { name: 'Second' }).getAttribute('aria-selected')).toBe('true');

        await act(async () => { setUiState('cmp_tabs', 'activeTab', 0); });
        expect(screen.getByText('cmp_taba/false')).toBeTruthy();

        await act(async () => { openAppModal('cmp_modal'); });
        expect(screen.getByText('cmp_taba/true')).toBeTruthy();
        await act(async () => { closeAppModal('cmp_modal'); });
        expect(screen.getByText('cmp_taba/false')).toBeTruthy();
    });

    it('a click on a tab is published too', async () => {
        const user = userEvent.setup();
        render(<AppRenderer definition={defWith([tabs, probe])} screenId="scr_t" mode="run" />);
        await user.click(screen.getByRole('tab', { name: 'Second' }));
        expect(getUiSnapshot().tabs.cmp_tabs).toEqual({ active: 'cmp_tabb' });
    });

    it('a value set before the tabs mount is taken when they appear', async () => {
        setUiState('cmp_tabs', 'activeTab', 'cmp_tabb');
        render(<AppRenderer definition={defWith([tabs])} screenId="scr_t" mode="run" />);
        expect(screen.getByRole('tab', { name: 'Second' }).getAttribute('aria-selected')).toBe('true');
    });

    it('unmounting forgets what the component published', () => {
        const { unmount } = render(<AppRenderer definition={defWith([tabs])} screenId="scr_t" mode="run" />);
        expect(getUiSnapshot().tabs.cmp_tabs).toEqual({ active: 'cmp_taba' });
        unmount();
        expect(getUiSnapshot().tabs).toEqual({});
    });

    it('a selectable grid publishes its selected rows and set_ui selects them; a plain grid publishes nothing', async () => {
        const user = userEvent.setup();
        const rows = [{ id: 1, name: 'Zoe' }, { id: 2, name: 'Amy' }, { id: 3, name: 'Max' }];
        const grid = (id: string, selectable: string) => ({
            id, type: 'data_grid', visible: true, style: { span: 12 },
            props: { source: { kind: 'static', value: rows }, columns: [{ key: 'name', label: 'Name', format: 'text' }], pageSize: 25, selectable, searchable: false, rowActions: [], emptyText: 'None.' },
        });
        render(<AppRenderer definition={defWith([grid('cmp_grid', 'multi'), grid('cmp_plain', 'none')])} screenId="scr_t" mode="run" />);
        expect(getUiSnapshot().selection).toEqual({ cmp_grid: [] });

        await user.click(screen.getAllByLabelText('Select row')[1]);
        expect(getUiSnapshot().selection.cmp_grid).toEqual([rows[1]]);

        await act(async () => { setUiState('cmp_grid', 'selection', [1, { id: 3 }]); });
        expect(getUiSnapshot().selection.cmp_grid).toEqual([rows[0], rows[2]]);
        await act(async () => { setUiState('cmp_grid', 'selection', null); });
        expect(getUiSnapshot().selection.cmp_grid).toEqual([]);
    });

    it('edit mode publishes nothing', () => {
        render(<AppRenderer definition={defWith([tabs, modal])} screenId="scr_t" mode="edit" />);
        expect(getUiSnapshot()).toEqual({ tabs: {}, modals: {}, selection: {} });
    });
});

describe('the values a set_ui step may carry', () => {
    const list = [{ id: 'a' }, { id: 'b' }];

    it('a tab by id or by 0-based position; anything else names no tab', () => {
        expect(tabIndexOf(list, 'b')).toBe(1);
        expect(tabIndexOf(list, 0)).toBe(0);
        for (const v of [2, -1, 1.5, 'zz', '', null, undefined, true]) expect(tabIndexOf(list, v)).toBe(-1);
    });

    it('a selection by row id, ids, or rows; single keeps the first; empty clears', () => {
        expect(selectionFromValue('r1', true)).toEqual({ r1: true });
        expect(selectionFromValue(['r1', 7, { id: 'r3' }, { _id: 'r4' }, null, {}], true)).toEqual({ r1: true, 7: true, r3: true, r4: true });
        expect(selectionFromValue(['r1', 'r2'], false)).toEqual({ r1: true });
        for (const v of [null, undefined, '', []]) expect(selectionFromValue(v, true)).toEqual({});
    });
});
