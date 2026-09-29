import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ThemePanel from './ThemePanel';

/**
 * The theme's two OPTIONAL colours — accent (buttons) and canvas (page
 * ground) — are "off" until the owner switches them on, and switching one off
 * commits null: that is what the canonicalizer reads as "drop the key", which
 * is how a theme that never chose stays byte-identical to before the colours
 * existed. A picker that committed a default instead would silently widen
 * every saved theme.
 */

const DEF = {
    schemaVersion: 2,
    meta: { name: 'T', description: '', icon: null },
    theme: { primary: '#0064B0' },
    homeScreenId: 'scr_1',
    screens: [{ id: 'scr_1', name: 'One', maxWidth: 'medium', refreshInterval: 0, showInNav: true, icon: null, sections: [] }],
    actions: {},
};

function renderPanel(definition = DEF) {
    const onCommit = vi.fn();
    const utils = render(<ThemePanel definition={definition} onCommit={onCommit} screenId="scr_1" />);
    return { onCommit, ...utils };
}

describe('ThemePanel — optional colours', () => {
    it('both switches are off for a theme that never chose, and no picker is shown', () => {
        const { getByLabelText, queryByLabelText } = renderPanel();
        expect(getByLabelText('Theme button colour: use a separate colour').checked).toBe(false);
        expect(getByLabelText('Theme page background: use a separate colour').checked).toBe(false);
        expect(queryByLabelText('Theme button colour')).toBeNull();
        expect(queryByLabelText('Theme page background')).toBeNull();
    });

    it('switching the button colour on starts from the PRIMARY, so nothing visibly changes until a colour is picked', () => {
        const { getByLabelText, onCommit } = renderPanel();
        fireEvent.click(getByLabelText('Theme button colour: use a separate colour'));
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit.mock.calls[0][0].theme.accent).toBe('#0064B0');
    });

    it('a set colour shows its picker; switching off commits null (the "drop the key" signal), not a default', () => {
        const def = { ...DEF, theme: { primary: '#0064B0', accent: '#008236', canvas: '#FFDA00' } };
        const { getByLabelText, onCommit } = renderPanel(def);
        expect(getByLabelText('Theme button colour: use a separate colour').checked).toBe(true);
        expect(getByLabelText('Theme page background: use a separate colour').checked).toBe(true);
        expect(getByLabelText('Theme button colour')).toBeTruthy();
        expect(getByLabelText('Theme page background')).toBeTruthy();

        fireEvent.click(getByLabelText('Theme page background: use a separate colour'));
        expect(onCommit).toHaveBeenCalledTimes(1);
        const next = onCommit.mock.calls[0][0];
        expect(next.theme.canvas).toBeNull();
        expect(next.theme.accent).toBe('#008236'); // the other one is untouched
    });
});
