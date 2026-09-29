import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';

/**
 * The forms directory at /app/forms — every form published in the
 * organisation, as a grid of tiles.
 *
 * Characterisation only (FRM-0): this pins what the page does TODAY, warts
 * included, so the redesign has something to break against. The header carries
 * no counters, the tile carries no address and no submission count, and every
 * string on the page is hard-coded English — all three are deliberate here and
 * all three are on the FRM list to change.
 */

const { api, recents } = vi.hoisted(() => ({
    // One stable object: FormsHomePage's loader is a useCallback keyed on
    // `api`, so a fresh literal per render would re-fire the effect forever.
    api: { listOrgForms: vi.fn() },
    recents: { rememberFormOpened: vi.fn() },
}));

vi.mock('../../hooks/useAutomationApi', () => ({ default: () => api }));
vi.mock('../../utils/formRecents', () => ({
    rememberFormOpened: (...args) => recents.rememberFormOpened(...args),
}));

const { default: FormsHomePage, formViewPath } = await import('./FormsHomePage');

/** One row as GET /api/automation/forms sends it (crud.js). */
const form = (over = {}) => ({
    id: 'a'.repeat(48),
    url: `/f/${'a'.repeat(48)}`,
    automationId: 'aut_1',
    triggerStepId: null,
    title: 'Offerte-controle',
    description: 'Stuur ons je offerte, wij kijken mee.',
    live: true,
    submissions: 28,
    lastSeenAt: '2026-09-01T10:00:00Z',
    createdAt: '2026-08-01T10:00:00Z',
    mine: true,
    ...over,
});

const serve = (forms) => { api.listOrgForms.mockResolvedValue({ forms }); };

describe('FormsHomePage — the organisation\'s forms', () => {
    beforeEach(() => {
        cleanup();
        api.listOrgForms.mockReset();
        recents.rememberFormOpened.mockReset();
    });

    it('shows a placeholder grid while the list is still being fetched', () => {
        api.listOrgForms.mockReturnValue(new Promise(() => {}));
        render(<FormsHomePage />);
        expect(screen.getByRole('status', { name: 'Loading forms' })).toBeTruthy();
        expect(screen.queryByText('No forms yet')).toBeNull();
    });

    it('lists one tile per published form, with its title and its intro text', async () => {
        serve([form(), form({ id: 'b'.repeat(48), title: 'Aanmelden nieuwsbrief', description: null })]);
        render(<FormsHomePage />);

        expect(await screen.findByText('Offerte-controle')).toBeTruthy();
        expect(screen.getByText('Stuur ons je offerte, wij kijken mee.')).toBeTruthy();
        expect(screen.getByText('Aanmelden nieuwsbrief')).toBeTruthy();
        expect(screen.getAllByRole('link')).toHaveLength(2);
    });

    it('a form shared with specific people that do not include this account is not a tile — the gate\'s verdict rides on the row', async () => {
        serve([
            form(),
            form({ id: 'b'.repeat(48), title: 'Only for Finance', canOpen: false, audience: { mode: 'restricted' } }),
            form({ id: 'c'.repeat(48), title: 'Shared with me', canOpen: true, audience: { mode: 'restricted' } }),
        ]);
        render(<FormsHomePage />);
        expect(await screen.findByText('Shared with me')).toBeTruthy();
        expect(screen.queryByText('Only for Finance')).toBeNull();
        expect(screen.getAllByRole('link')).toHaveLength(2);
    });

    it('points a tile at the in-app view, never at the form\'s own /f/<token> address', async () => {
        serve([form()]);
        const { container } = render(<FormsHomePage />);
        await screen.findByText('Offerte-controle');

        const link = screen.getByRole('link');
        expect(link.getAttribute('href')).toBe(`/app/forms/${'a'.repeat(48)}`);
        expect(formViewPath(form())).toBe(`/app/forms/${'a'.repeat(48)}`);
        // wart: the server sends `url: /f/<token>`, the sharable address, and
        // the directory drops it on the floor — copying the link is left to the
        // browser's address bar. FRM-11/FRM-12 decide whether the public
        // address comes back onto the card.
        expect(container.innerHTML).not.toContain('/f/');
    });

    it('shows nothing about the form but its name — no submission count on the card', async () => {
        serve([form({ submissions: 28 })]);
        const { container } = render(<FormsHomePage />);
        await screen.findByText('Offerte-controle');
        // A directory you scan, not a table you read (the file's own reasoning).
        // wart: FRM-06 wants the count back in the card footer.
        expect(container.textContent).not.toContain('28');
    });

    it('opens a form in this tab on a plain click, rather than reloading the workspace', async () => {
        serve([form()]);
        const onNavigate = vi.fn();
        render(<FormsHomePage onNavigate={onNavigate} />);
        await screen.findByText('Offerte-controle');

        const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
        fireEvent(screen.getByRole('link'), click);

        expect(onNavigate).toHaveBeenCalledWith(`forms/${'a'.repeat(48)}`);
        expect(click.defaultPrevented).toBe(true);
    });

    it('leaves a ctrl-click to the browser, so a form can be opened in a new tab', async () => {
        serve([form()]);
        const onNavigate = vi.fn();
        render(<FormsHomePage onNavigate={onNavigate} />);
        await screen.findByText('Offerte-controle');

        const click = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ctrlKey: true });
        fireEvent(screen.getByRole('link'), click);

        expect(onNavigate).not.toHaveBeenCalled();
        expect(click.defaultPrevented).toBe(false);
    });

    it('remembers the open so the sidebar can offer this form again — modifier click included', async () => {
        serve([form()]);
        render(<FormsHomePage onNavigate={vi.fn()} />);
        await screen.findByText('Offerte-controle');

        fireEvent.click(screen.getByRole('link'), { ctrlKey: true });
        expect(recents.rememberFormOpened).toHaveBeenCalledWith('a'.repeat(48));
    });

    it('warns on the tile when the routine behind a form is paused or still a draft', async () => {
        serve([form({ id: 'live', title: 'Live form' }), form({ id: 'dead', title: 'Paused form', live: false })]);
        render(<FormsHomePage />);
        await screen.findByText('Live form');

        const pills = screen.getAllByText('Not live — the routine is paused or still a draft');
        expect(pills).toHaveLength(1);
        // Only the broken half is labelled: a working form gets no "Live" pill.
        // wart: FRM-02 wants a status pill on both — Live (green) and Draft
        // (grey) — and every string here is hard-coded English (FRM-16).
        expect(pills[0].closest('a').getAttribute('href')).toBe('/app/forms/dead');
    });

    it('tells an organisation with no forms how one gets here', async () => {
        serve([]);
        render(<FormsHomePage />);
        expect(await screen.findByText('No forms yet')).toBeTruthy();
        expect(screen.getByText(/the colleagues it is shared with can fill in/)).toBeTruthy();
        expect(screen.queryAllByRole('link')).toHaveLength(0);
    });

    it('treats a response without a forms array as an empty directory rather than crashing', async () => {
        api.listOrgForms.mockResolvedValue({});
        render(<FormsHomePage />);
        expect(await screen.findByText('No forms yet')).toBeTruthy();
    });

    it('says what went wrong and asks again when Retry is pressed', async () => {
        api.listOrgForms.mockRejectedValueOnce(new Error('Forms are not available'));
        render(<FormsHomePage />);

        const banner = await screen.findByRole('alert');
        expect(banner.textContent).toContain('Forms are not available');
        expect(screen.queryByText('No forms yet')).toBeNull();

        serve([form()]);
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

        expect(await screen.findByText('Offerte-controle')).toBeTruthy();
        expect(screen.queryByRole('alert')).toBeNull();
        expect(api.listOrgForms).toHaveBeenCalledTimes(2);
    });

    it('falls back to a generic line when the failure carries no message', async () => {
        api.listOrgForms.mockRejectedValue(new Error(''));
        render(<FormsHomePage />);
        await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('Could not load the forms.'));
    });

    it('heads the page with the word Forms and nothing else — no counts, no build button', async () => {
        serve([form(), form({ id: 'b' })]);
        render(<FormsHomePage />);
        await screen.findAllByText('Offerte-controle');

        expect(screen.getByRole('heading', { name: 'Forms' })).toBeTruthy();
        // wart: FRM-01 wants "6 formulieren · 41 inzendingen deze week" here and
        // FRM-14 a button to build one; today the header is a title and a line.
        expect(screen.queryByRole('button', { name: /new|build|create/i })).toBeNull();
    });
});
