import { render, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import ThemePanel from './ThemePanel';
import { updateAiBrowsing } from '../state/definitionOps';

/**
 * AI browsing — the OWNER's switch.
 *
 * An `ai_browse` step drives a real headless browser as the app owner. The AI
 * that authors the app can add such a step, but it must never be able to switch
 * the capability on: `aiBrowsing` is absent from the builder tool schemas on
 * purpose, and the server validator refuses the step (`browse.not_enabled`)
 * until a human turns it on here.
 *
 * That makes this panel the only path to the key, which is exactly why it needs
 * a test: without it the feature ships unreachable, and the whole gate reads as
 * a bug rather than a design.
 */

const DEF = {
    schemaVersion: 2,
    meta: { name: 'T', description: '', icon: null },
    theme: {},
    homeScreenId: 'scr_1',
    screens: [{ id: 'scr_1', name: 'One', maxWidth: 'medium', refreshInterval: 0, showInNav: true, icon: null, sections: [] }],
    actions: {},
};

function renderPanel(definition = DEF) {
    const onCommit = vi.fn();
    const utils = render(<ThemePanel definition={definition} onCommit={onCommit} screenId="scr_1" />);
    return { onCommit, ...utils };
}

describe('updateAiBrowsing', () => {
    it('adds the key, merges patches, and leaves an untouched definition alone', () => {
        const on = updateAiBrowsing(DEF, { enabled: true });
        expect(on.aiBrowsing).toEqual({ enabled: true });

        const withDomains = updateAiBrowsing(on, { allowedDomains: ['nhs.uk'] });
        expect(withDomains.aiBrowsing).toEqual({ enabled: true, allowedDomains: ['nhs.uk'] });

        // A no-op patch must not produce a new object, or every render would
        // look like an edit and the undo stack would fill with nothing.
        expect(updateAiBrowsing(withDomains, { enabled: true })).toBe(withDomains);
    });

    it('null REMOVES the key so an app that never browsed is byte-identical to before', () => {
        const on = updateAiBrowsing(DEF, { enabled: true });
        const off = updateAiBrowsing(on, null);
        expect('aiBrowsing' in off).toBe(false);
        // Removing from a definition that never had it is a no-op.
        expect(updateAiBrowsing(DEF, null)).toBe(DEF);
    });
});

describe('ThemePanel — AI browsing settings', () => {
    it('offers the switch, off by default', () => {
        const { getByText, getByLabelText } = renderPanel();
        expect(getByText('AI browsing')).toBeTruthy();
        expect(getByLabelText(/Let this app browse the web/i).checked).toBe(false);
    });

    it('turning it on commits { enabled: true }', () => {
        const { onCommit, getByLabelText } = renderPanel();
        fireEvent.click(getByLabelText(/Let this app browse the web/i));
        expect(onCommit).toHaveBeenCalledTimes(1);
        expect(onCommit.mock.calls[0][0].aiBrowsing).toEqual({ enabled: true });
    });

    it('hides the domain list until browsing is on — an allow-list for nothing is noise', () => {
        const { queryByLabelText } = renderPanel();
        expect(queryByLabelText('Sites it may open')).toBeNull();

        const on = { ...DEF, aiBrowsing: { enabled: true } };
        const { getByLabelText } = renderPanel(on);
        expect(getByLabelText('Sites it may open')).toBeTruthy();
    });

    it('parses the domain list on blur: newlines or commas, lower-cased, blanks dropped', () => {
        const on = { ...DEF, aiBrowsing: { enabled: true } };
        const { onCommit, getByLabelText } = renderPanel(on);
        const box = getByLabelText('Sites it may open');
        fireEvent.change(box, { target: { value: 'NHS.uk\n\n who.int , cdc.gov\n' } });
        fireEvent.blur(box);
        expect(onCommit.mock.calls.at(-1)[0].aiBrowsing.allowedDomains)
            .toEqual(['nhs.uk', 'who.int', 'cdc.gov']);
    });

    it('shows the existing domains when the app already has some', () => {
        const on = { ...DEF, aiBrowsing: { enabled: true, allowedDomains: ['nhs.uk', 'who.int'] } };
        const { getByLabelText } = renderPanel(on);
        expect(getByLabelText('Sites it may open').value).toBe('nhs.uk\nwho.int');
    });

    it('says who may switch it on and who may take it away', () => {
        const { getByText } = renderPanel();
        // The two facts a viewer of this panel needs: the builder AI cannot
        // grant itself a browser, and the org keeps a kill switch.
        expect(getByText(/the app builder cannot/i)).toBeTruthy();
        expect(getByText(/Browse Web integration/i)).toBeTruthy();
    });
});
