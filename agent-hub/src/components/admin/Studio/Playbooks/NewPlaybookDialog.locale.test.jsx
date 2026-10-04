import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NewPlaybookDialog from './NewPlaybookDialog';
import { playbooksApi } from './playbooksApi';

/**
 * The demo is built in the language the person is LOOKING AT.
 *
 * Measured 2026-09-14 on the Nextcloud-embedded app: the screen was English
 * (no Dutch catalogue in that deployment, so every t() fell through to the
 * English defaults) while `locale` was 'nl' — the browser's language, from an
 * origin where no choice was ever stored. The dialog sent that 'nl', and the
 * AI wrote a Dutch playbook under an English screen. It follows
 * `resolvedLocale` now.
 *
 * There is NO language control in the dialog (owner, 2026-09-16): the demo
 * speaks Bee Flow's language, set once in the user's settings. These tests
 * pin that the dialog reads the screen and nothing else.
 */
vi.mock('./playbooksApi', () => {
    const playbooksApi = { recipes: vi.fn(), composeRecipe: vi.fn(), create: vi.fn(), list: vi.fn(), get: vi.fn(), patch: vi.fn(), runPhase: vi.fn(), skipPhase: vi.fn(), retryPhase: vi.fn(), remove: vi.fn() };
    return { playbooksApi, default: playbooksApi };
});
vi.mock('../Datatables/datatablesApi', () => ({ datatablesApi: { list: vi.fn(async () => ({ datatables: [] })) } }));
vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn(async () => ({ ok: true, json: async () => [] })) }));

// `strings` is the SERVER catalogue for `locale` — the real readingLocale is
// used (not a stub), so these tests exercise the same rule the app does.
const language = { locale: 'nl', strings: {} };
// Everything this dialog needs translated before it counts as "in Dutch".
const NL_DIALOG = Object.freeze({
    'playbooks.new.title': 'Nieuw playbook',
    'playbooks.new.describe_label': 'Wat moet dit playbook bouwen?',
    'playbooks.phase.table': 'Tabel',
});
vi.mock('../../../../hooks/useTranslation', async (importOriginal) => ({
    readingLocale: (await importOriginal()).readingLocale,
    default: () => ({
        // The same resolution order as the real fallback: the caller's English
        // sentence, with {placeholders} filled in.
        t: (key, fallbackOrParams, paramsArg) => {
            const en = typeof fallbackOrParams === 'string' ? fallbackOrParams : key;
            const params = typeof fallbackOrParams === 'string' ? paramsArg : fallbackOrParams;
            return params ? Object.entries(params).reduce((out, [k, v]) => out.replace(`{${k}}`, String(v)), en) : en;
        },
        ...language,
        resolvedLocale: language.locale,
        setLocale: () => {},
        isLoading: false,
    }),
}));

const BUILTIN = {
    id: 'invoice_tracker', title: 'Invoice tracker', description: 'Read invoices.', source: 'builtin',
    table: { fields: [{ key: 'date', name: 'Date', type: 'date' }] },
    inputs: [{ key: 'folderPath', label: 'Nextcloud folder with the invoices', kind: 'folder', default: '/Invoices' }],
    phases: [{ key: 'table', kind: 'table', label: 'Table' }, { key: 'automation', kind: 'automation', label: 'Automation' }],
};

beforeEach(() => {
    vi.resetAllMocks();
    language.locale = 'nl';
    language.strings = {};   // a Dutch preference the catalogue cannot serve
    playbooksApi.recipes.mockResolvedValue({ recipes: [BUILTIN], approvalsAllowed: false });
    playbooksApi.create.mockResolvedValue({ playbook: { id: 'pb_1', title: 'x', phases: [] } });
    playbooksApi.composeRecipe.mockResolvedValue({ recipe: { ...BUILTIN, id: 'custom_x', source: 'ai' }, warnings: [] });
});
afterEach(() => cleanup());

describe('NewPlaybookDialog — the demo speaks the language on screen', () => {
    it('an English screen on a Dutch browser builds in English', async () => {
        render(<NewPlaybookDialog user={{ id: 'u1', locale: 'nl' }} onClose={vi.fn()} onCreated={vi.fn()} />);
        await waitFor(() => expect(playbooksApi.recipes).toHaveBeenCalledWith('en'));
        fireEvent.click(await screen.findByText('Invoice tracker'));
        fireEvent.click(screen.getByTestId('playbook-start'));
        await waitFor(() => expect(playbooksApi.create).toHaveBeenCalledWith(expect.objectContaining({
            options: expect.objectContaining({ locale: 'en' }),
        })));
    });

    it('offers no language of its own — the screen decides', async () => {
        render(<NewPlaybookDialog user={{ id: 'u1', locale: 'nl' }} onClose={vi.fn()} onCreated={vi.fn()} />);
        await waitFor(() => expect(playbooksApi.recipes).toHaveBeenCalledWith('en'));
        expect(screen.queryByRole('radio', { name: 'Nederlands' })).toBeNull();
        expect(screen.queryByRole('radio', { name: 'English' })).toBeNull();
        expect(screen.queryByText('Language')).toBeNull();
        // One list, in the language on screen: no second fetch to undo.
        expect(playbooksApi.recipes).toHaveBeenCalledTimes(1);
    });

    it('the name follows the recipe the server sent in that language, unless the person typed one', async () => {
        playbooksApi.recipes.mockResolvedValue({ recipes: [{ ...BUILTIN, title: 'Facturen bijhouden' }], approvalsAllowed: false });
        const { unmount } = render(<NewPlaybookDialog user={{ id: 'u1' }} onClose={vi.fn()} onCreated={vi.fn()} />);
        fireEvent.click(await screen.findByText('Facturen bijhouden'));
        await waitFor(() => expect(screen.getByLabelText('Name').value).toBe('Facturen bijhouden'));
        fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Q3 invoices' } });
        fireEvent.click(screen.getByTestId('playbook-start'));
        await waitFor(() => expect(playbooksApi.create).toHaveBeenCalledWith(expect.objectContaining({ title: 'Q3 invoices' })));
        unmount();
    });

    it('a Dutch preference whose catalogue misses THIS dialog still builds in English', async () => {
        // The catalogue is loaded and far from empty — it just does not cover
        // the playbook screens, so they render English. What you see is what
        // gets built. (Measured 2026-09-16: this case shipped Dutch columns
        // and phase labels under an all-English dialog.)
        language.strings = { 'chat.send': 'Versturen', 'studio.tab.apps': 'Apps' };
        render(<NewPlaybookDialog user={{ id: 'u1', locale: 'nl' }} onClose={vi.fn()} onCreated={vi.fn()} />);
        await waitFor(() => expect(playbooksApi.recipes).toHaveBeenCalledWith('en'));
        fireEvent.click(screen.getByText('Describe it'));
        fireEvent.change(screen.getByLabelText('What should this playbook build?'), { target: { value: 'Lees de facturen in' } });
        fireEvent.click(screen.getByTestId('playbook-compose'));
        await waitFor(() => expect(playbooksApi.composeRecipe).toHaveBeenCalledWith('Lees de facturen in', 'en'));
    });

    it('a Dutch screen builds in Dutch — recipes, the AI composer and the playbook', async () => {
        language.strings = NL_DIALOG;
        render(<NewPlaybookDialog user={{ id: 'u1', locale: 'nl' }} onClose={vi.fn()} onCreated={vi.fn()} />);
        await waitFor(() => expect(playbooksApi.recipes).toHaveBeenCalledWith('nl'));
        fireEvent.click(screen.getByText('Describe it'));
        fireEvent.change(screen.getByLabelText('What should this playbook build?'), { target: { value: 'Lees de facturen in' } });
        fireEvent.click(screen.getByTestId('playbook-compose'));
        await waitFor(() => expect(playbooksApi.composeRecipe).toHaveBeenCalledWith('Lees de facturen in', 'nl'));
    });
});
