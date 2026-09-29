import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { BuilderConfirmProvider } from '../../BuilderConfirmContext';

/**
 * Publishing and sharing a form, from the author's side.
 *
 * Characterisation only (FRM-0). Two things worth writing down before the
 * redesign moves them:
 *
 *   1. The builder shows NO address. `SHOW_PUBLIC_LINK_IN_BUILDER` is false, so
 *      the panel that mints, copies and rotates the link is exported, working
 *      and unmounted. Publishing happens anyway — the server mints the page
 *      whenever a form trigger is saved (crud.js's ensureFormPages) — so a form
 *      is live without the author ever seeing where it lives.
 *   2. The panel itself still behaves exactly as it did, and stays under test
 *      here so flipping the flag back is a one-line change rather than a
 *      rediscovery.
 */

const { api } = vi.hoisted(() => ({
    api: {
        listFormPages: vi.fn(),
        createFormPage: vi.fn(),
        rotateFormPage: vi.fn(),
    },
}));
vi.mock('../../../../../hooks/useAutomationApi', () => ({ default: () => api }));

const {
    default: FormTriggerFields,
    FormTriggerUrlPanel,
    SHOW_PUBLIC_LINK_IN_BUILDER,
} = await import('./FormTriggerFields');

const PAGE = { id: 'tok1', url: 'https://app.test/f/tok1', submissions: 0, triggerStepId: null };

/** A routine whose SAVED definition already carries this form trigger. */
const automation = (over = {}) => ({
    id: 'aut_1',
    definition: { trigger: { id: 'trg', type: 'trigger', kind: 'form', form: {} }, steps: [], edges: [] },
    ...over,
});

function renderPanel({ auto = automation(), stepId = 'trg', confirm = vi.fn(async () => true) } = {}) {
    const utils = render(
        <BuilderConfirmProvider value={confirm}>
            <FormTriggerUrlPanel automation={auto} stepId={stepId} />
        </BuilderConfirmProvider>,
    );
    return { ...utils, confirm };
}

describe('form trigger — the author\'s side of publishing', () => {
    beforeEach(() => {
        cleanup();
        api.listFormPages.mockReset().mockResolvedValue({ forms: [PAGE] });
        api.createFormPage.mockReset().mockResolvedValue({ form: PAGE });
        api.rotateFormPage.mockReset().mockResolvedValue({ form: { ...PAGE, id: 'tok2', url: 'https://app.test/f/tok2' } });
    });

    it('never shows the public address in the builder today', async () => {
        // wart: the form is published either way — the author just cannot see,
        // copy or rotate its address from here. FRM-11/FRM-12 decide where the
        // address lives and whether the "public link" wording is even true
        // (forms are signed-in only while PUBLIC_FORMS_ENABLED is false).
        expect(SHOW_PUBLIC_LINK_IN_BUILDER).toBe(false);
        render(<FormTriggerFields draft={{ form: { title: 'Get in touch', fields: [], theme: null } }} set={vi.fn()} automation={automation()} stepId="trg" />);

        expect(screen.queryByText('Public link')).toBeNull();
        expect(screen.queryByLabelText('Public form URL')).toBeNull();
        expect(api.listFormPages).not.toHaveBeenCalled();
    });

    it('offers to create the form when a trigger has just been switched to this kind', () => {
        const set = vi.fn();
        render(<FormTriggerFields draft={{}} set={set} automation={automation()} stepId="trg" />);

        expect(screen.getByText(/publishes a page for the colleagues it is shared with/)).toBeTruthy();
        fireEvent.click(screen.getByRole('button', { name: /Create the form/ }));

        const [key, declaration] = set.mock.calls[0];
        expect(key).toBe('form');
        // Already publishable: a title, three questions, a submit label and a
        // thank-you — refining is optional.
        expect(declaration.title).toBe('Get in touch');
        expect(declaration.fields.map(f => f.name)).toEqual(['name', 'email', 'message']);
        expect(declaration.theme.appearance).toBe('light');
    });

    it('writes nothing until the author asks for it — no declaration is seeded on render', () => {
        const set = vi.fn();
        render(<FormTriggerFields draft={{}} set={set} automation={automation()} stepId="trg" />);
        expect(set).not.toHaveBeenCalled();
    });
});

describe('FormTriggerUrlPanel — the link, when it is shown at all', () => {
    beforeEach(() => {
        cleanup();
        api.listFormPages.mockReset().mockResolvedValue({ forms: [PAGE] });
        api.createFormPage.mockReset().mockResolvedValue({ form: PAGE });
        api.rotateFormPage.mockReset().mockResolvedValue({ form: { ...PAGE, id: 'tok2', url: 'https://app.test/f/tok2' } });
    });

    it('waits for the routine to save rather than asking about a node the server has not seen', () => {
        renderPanel({ auto: automation({ definition: { trigger: { id: 'trg', kind: 'webhook' }, steps: [], edges: [] } }) });
        expect(screen.getByText('Waiting for the routine to save…')).toBeTruthy();
        expect(api.listFormPages).not.toHaveBeenCalled();
    });

    it('shows the address the routine already has, read-only, without minting a second one', async () => {
        renderPanel();
        const input = await screen.findByLabelText('Public form URL');
        expect(input.value).toBe('https://app.test/f/tok1');
        expect(input.readOnly).toBe(true);
        expect(api.createFormPage).not.toHaveBeenCalled();
    });

    it('mints one on first open when the routine has no page yet', async () => {
        api.listFormPages.mockResolvedValue({ forms: [] });
        renderPanel();
        await waitFor(() => expect(api.createFormPage).toHaveBeenCalledWith('aut_1'));
        expect((await screen.findByLabelText('Public form URL')).value).toBe('https://app.test/f/tok1');
    });

    it('copies the address and says so', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
        renderPanel();
        await screen.findByLabelText('Public form URL');

        fireEvent.click(screen.getByRole('button', { name: 'Copy the link' }));
        await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://app.test/f/tok1'));
    });

    it('tells the author to copy by hand when the clipboard refuses', async () => {
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
            configurable: true,
        });
        renderPanel();
        await screen.findByLabelText('Public form URL');
        fireEvent.click(screen.getByRole('button', { name: 'Copy the link' }));
        expect(await screen.findByText(/Select the text to copy it manually/)).toBeTruthy();
    });

    it('asks before rotating, because rotating is publishing a different address', async () => {
        const confirm = vi.fn(async () => true);
        renderPanel({ confirm });
        await screen.findByLabelText('Public form URL');

        fireEvent.click(screen.getByRole('button', { name: 'Create a new link' }));
        await waitFor(() => expect(api.rotateFormPage).toHaveBeenCalledWith('aut_1', 'tok1'));

        const asked = confirm.mock.calls[0][0];
        expect(asked.destructive).toBe(true);
        expect(asked.description).toContain('stops working immediately');
        await waitFor(() => expect(screen.getByLabelText('Public form URL').value).toBe('https://app.test/f/tok2'));
    });

    it('keeps the old address when the author backs out', async () => {
        renderPanel({ confirm: vi.fn(async () => false) });
        await screen.findByLabelText('Public form URL');

        fireEvent.click(screen.getByRole('button', { name: 'Create a new link' }));
        await waitFor(() => expect(api.rotateFormPage).not.toHaveBeenCalled());
        expect(screen.getByLabelText('Public form URL').value).toBe('https://app.test/f/tok1');
    });

    it('says the link only works while the routine is active, and counts submissions once there are any', async () => {
        api.listFormPages.mockResolvedValue({ forms: [{ ...PAGE, submissions: 1 }] });
        renderPanel();
        expect(await screen.findByText(/only works while the routine is active\. 1 submission so far\./)).toBeTruthy();
    });

    it('leaves the count off a form nobody has filled in', async () => {
        renderPanel();
        await screen.findByLabelText('Public form URL');
        expect(screen.queryByText(/submission/)).toBeNull();
    });

    it('shows what went wrong instead of an empty panel', async () => {
        api.listFormPages.mockRejectedValue(new Error('Not your routine'));
        api.createFormPage.mockRejectedValue(new Error('Not your routine'));
        renderPanel();
        expect(await screen.findByText('Not your routine')).toBeTruthy();
        expect(screen.getByText('Generate the link')).toBeTruthy();
    });
});
