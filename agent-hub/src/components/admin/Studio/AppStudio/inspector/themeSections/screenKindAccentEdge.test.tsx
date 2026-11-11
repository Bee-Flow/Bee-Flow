import { within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect } from 'vitest';
import { renderThemePanel } from '../ThemePanel.testkit';

/** screen.kind and design.accentEdge: in the definition for a long time, now with a control. */

const DEF = {
    schemaVersion: 2,
    meta: { name: 'T', description: '', icon: null },
    theme: {},
    homeScreenId: 'scr_1',
    screens: [
        { id: 'scr_1', name: 'One', maxWidth: 'medium', showInNav: true, icon: null, sections: [] },
        { id: 'scr_2', name: 'Two', maxWidth: 'medium', showInNav: true, icon: null, kind: 'dashboard', sections: [] },
    ],
    actions: {},
};

const renderPanel = (screenId: string, definition: Record<string, unknown> = DEF) => renderThemePanel(definition, screenId);

describe('ThemePanel — screen kind', () => {
    it('makes the screen a dashboard, and Page removes the key again', async () => {
        const user = userEvent.setup();
        const one = renderPanel('scr_1');
        const block = () => within(one.getByTestId('screen-kind-settings'));
        expect(block().getByRole('radio', { name: 'Page' })).toBeChecked();
        await user.click(block().getByRole('radio', { name: 'Dashboard' }));
        expect(one.onCommit.mock.calls[0][0].screens[0].kind).toBe('dashboard');
        expect(one.onCommit.mock.calls[0][0].screens[1]).toBe(DEF.screens[1]);
        one.unmount();

        const two = renderPanel('scr_2');
        const block2 = within(two.getByTestId('screen-kind-settings'));
        expect(block2.getByRole('radio', { name: 'Dashboard' })).toBeChecked();
        await user.click(block2.getByRole('radio', { name: 'Page' }));
        expect(two.onCommit.mock.calls[0][0].screens[1].kind ?? null).toBeNull();
    });
});

describe('ThemePanel — accent edge', () => {
    it('sets accentEdge none as an own look, and picking the shown value changes nothing', async () => {
        const user = userEvent.setup();
        const { getByTestId, onCommit } = renderPanel('scr_1');
        const block = within(getByTestId('accent-edge-settings'));
        expect(block.getByRole('radio', { name: 'Bar' })).toBeChecked();
        await user.click(block.getByRole('radio', { name: 'Bar' }));
        expect(onCommit).not.toHaveBeenCalled();
        await user.click(block.getByRole('radio', { name: 'None' }));
        expect(onCommit.mock.calls[0][0].design).toEqual({ accentEdge: 'none', preset: 'custom' });
    });
});
