import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import NewPlaybookDialog from './NewPlaybookDialog';
import { playbooksApi } from './playbooksApi';

vi.mock('./playbooksApi', () => {
    const playbooksApi = { recipes: vi.fn(), composeRecipe: vi.fn(), create: vi.fn(), list: vi.fn(), get: vi.fn(), patch: vi.fn(), runPhase: vi.fn(), skipPhase: vi.fn(), retryPhase: vi.fn(), remove: vi.fn() };
    return { playbooksApi, default: playbooksApi };
});
vi.mock('../Datatables/datatablesApi', () => ({ datatablesApi: { list: vi.fn(async () => ({ datatables: [{ id: 'tbl_ex', name: 'Facturen', rowCount: 32, managedKind: 'nextcloud_table' }] })) } }));
vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn(async () => ({ ok: true, json: async () => [{ id: 'g1', name: 'Finance' }] })) }));

const BUILTIN = {
    id: 'invoice_tracker', title: 'Facturen bijhouden', description: 'Read invoices.', source: 'builtin',
    table: { fields: [{ key: 'datum', name: 'Datum', type: 'date' }] },
    inputs: [{ key: 'folderPath', label: 'Nextcloud folder with the invoices', kind: 'folder', default: '/Invoices' }],
    phases: [{ key: 'table', kind: 'table', label: 'Tabel' }, { key: 'automation', kind: 'automation', label: 'Automation' }, { key: 'fill', kind: 'fill', label: 'Eerste rijen' }, { key: 'app', kind: 'app', label: 'App' }, { key: 'approvals', kind: 'app_turn', label: 'Goedkeuringsflow', requires: 'approvals' }],
};
const COMPOSED = {
    id: 'custom_contracten', title: 'Contracten bewaken', description: 'Reads contracts.', source: 'ai',
    table: { fields: [{ key: 'leverancier', name: 'Leverancier', type: 'text' }, { key: 'einddatum', name: 'Einddatum', type: 'date' }] },
    inputs: [{ key: 'folderPath', label: 'Map met contracten', kind: 'folder', default: '/Contracten' }, { key: 'horizon', label: 'Dagen vooruit', kind: 'text', default: '90' }],
    phases: [{ key: 'table', kind: 'table', label: 'Tabel' }, { key: 'inlezen', kind: 'automation', label: 'Contracten inlezen', brief: 'b' }, { key: 'fill', kind: 'fill', label: 'Eerste rijen' }, { key: 'app', kind: 'app', label: 'Bewakings-app', brief: 'b' }],
};

beforeEach(() => {
    vi.resetAllMocks();
    playbooksApi.recipes.mockResolvedValue({ recipes: [BUILTIN], approvalsAllowed: true });
    playbooksApi.create.mockResolvedValue({ playbook: { id: 'pb_1', title: 'x', phases: [] } });
});
afterEach(() => cleanup());

describe('NewPlaybookDialog — a built-in recipe, or one the AI writes', () => {
    it('with nothing built-in on offer there is no picker at all — Describe it is the dialog', async () => {
        playbooksApi.recipes.mockResolvedValue({ recipes: [], approvalsAllowed: true });
        render(<NewPlaybookDialog user={{ id: 'u1' }} onClose={vi.fn()} onCreated={vi.fn()} />);
        await waitFor(() => expect(playbooksApi.recipes).toHaveBeenCalledWith('en'));
        expect(await screen.findByTestId('playbook-describe')).toBeTruthy();
        expect(screen.queryByText('Playbook')).toBeNull();
        expect(screen.queryByText('Describe it')).toBeNull();     // no card to pick either
        expect(screen.queryByText('Facturen bijhouden')).toBeNull();
        // Nothing to start until the AI has written the phases.
        expect(screen.getByTestId('playbook-start').disabled).toBe(true);
    });

    it('lists the server recipes, an existing table needs a pick, and Start posts the built-in id with the inputs', async () => {
        const onCreated = vi.fn();
        render(<NewPlaybookDialog user={{ id: 'u1', locale: 'nl' }} onClose={vi.fn()} onCreated={onCreated} />);
        // The INTERFACE language, not the account's: the demo is built in the
        // language the person is looking at (no provider in tests → 'en').
        await waitFor(() => expect(playbooksApi.recipes).toHaveBeenCalledWith('en'));
        // The dialog opens on Describe it; an offered recipe is a card to pick.
        fireEvent.click(await screen.findByText('Facturen bijhouden'));
        expect(screen.getByLabelText('Approver group (optional)')).toBeTruthy();
        const start = screen.getByTestId('playbook-start');
        expect(start.disabled).toBe(false);
        fireEvent.click(screen.getByText('An existing table'));
        await waitFor(() => expect(screen.getByTestId('playbook-start').disabled).toBe(true));
        const pick = await screen.findByTestId('playbook-table-pick');
        fireEvent.change(pick, { target: { value: 'tbl_ex' } });
        expect(screen.getByTestId('playbook-start').disabled).toBe(false);
        fireEvent.change(screen.getByTestId('playbook-input-folderPath'), { target: { value: '/Invoices-Test' } });
        fireEvent.click(screen.getByTestId('playbook-start'));
        await waitFor(() => expect(playbooksApi.create).toHaveBeenCalledWith({
            recipeId: 'invoice_tracker',
            title: 'Facturen bijhouden',
            options: { tableMode: 'existing', datatableId: 'tbl_ex', inputs: { folderPath: '/Invoices-Test' }, folderPath: '/Invoices-Test', tier: 'fast', locale: 'en', approverGroupId: undefined },
        }));
        expect(onCreated).toHaveBeenCalledWith({ id: 'pb_1', title: 'x', phases: [] });
    });

    it('a folder that is not an absolute path blocks Start with the hint', async () => {
        render(<NewPlaybookDialog user={{ id: 'u1' }} onClose={vi.fn()} onCreated={vi.fn()} />);
        fireEvent.click(await screen.findByText('Facturen bijhouden'));
        fireEvent.change(screen.getByTestId('playbook-input-folderPath'), { target: { value: 'Invoices' } });
        expect(screen.getByTestId('playbook-start').disabled).toBe(true);
        expect(screen.getByText(/absolute Nextcloud path/)).toBeTruthy();
    });

    it('Describe it: composes a document, previews its phases and columns, renders ITS inputs, and Start posts the document', async () => {
        playbooksApi.composeRecipe.mockResolvedValue({ recipe: COMPOSED, warnings: [] });
        render(<NewPlaybookDialog user={{ id: 'u1', locale: 'nl' }} onClose={vi.fn()} onCreated={vi.fn()} />);
        await screen.findByText('Facturen bijhouden');
        fireEvent.click(screen.getByText('Describe it'));
        expect(screen.getByTestId('playbook-start').disabled).toBe(true); // nothing composed yet
        const compose = screen.getByTestId('playbook-compose');
        expect(compose.disabled).toBe(true);
        fireEvent.change(screen.getByLabelText('What should this playbook build?'), { target: { value: 'Lees contracten in en bewaak de einddatum' } });
        fireEvent.click(compose);
        await waitFor(() => expect(playbooksApi.composeRecipe).toHaveBeenCalledWith('Lees contracten in en bewaak de einddatum', 'en'));
        const preview = await screen.findByTestId('playbook-recipe-preview');
        expect(preview.textContent).toContain('Contracten inlezen');
        expect(preview.textContent).toContain('Bewakings-app');
        expect(preview.textContent).toContain('Leverancier (text)');
        // The document's own inputs, with their defaults; no approver row (no phase requires approvals).
        expect(screen.getByTestId('playbook-input-folderPath').value).toBe('/Contracten');
        expect(screen.getByTestId('playbook-input-horizon').value).toBe('90');
        expect(screen.queryByLabelText('Approver group (optional)')).toBeNull();
        expect(screen.getByLabelText('Name').value).toBe('Contracten bewaken');
        fireEvent.click(screen.getByTestId('playbook-start'));
        await waitFor(() => expect(playbooksApi.create).toHaveBeenCalledWith({
            recipe: COMPOSED,
            title: 'Contracten bewaken',
            // `ask` is what the person TYPED, not the AI's reading of it: the
            // design phase draws from it, so "one screen" stays one screen.
            options: { tableMode: 'new', datatableId: undefined, inputs: { folderPath: '/Contracten', horizon: '90' }, folderPath: '/Contracten', tier: 'fast', locale: 'en', approverGroupId: undefined, ask: 'Lees contracten in en bewaak de einddatum' },
        }));
    });

    it('columns the server guessed from the briefs are flagged beside the preview — never silent', async () => {
        // The composer's last resort (recipeDoc.synthesizeTableFromPlaceholders)
        // fills `table` from {{field.x}} placeholders when the model declared no
        // columns and the repair round still did not. The person must see that
        // these are a guess before Start.
        playbooksApi.composeRecipe.mockResolvedValue({ recipe: COMPOSED, warnings: ['table_synthesized'] });
        render(<NewPlaybookDialog user={{ id: 'u1' }} onClose={vi.fn()} onCreated={vi.fn()} />);
        await screen.findByText('Facturen bijhouden');
        fireEvent.click(screen.getByText('Describe it'));
        fireEvent.change(screen.getByLabelText('What should this playbook build?'), { target: { value: 'Lees contracten in' } });
        fireEvent.click(screen.getByTestId('playbook-compose'));
        const preview = await screen.findByTestId('playbook-recipe-preview');
        expect(preview.textContent).toContain('Leverancier (text)');
        expect(screen.getByTestId('playbook-columns-synthesized').textContent).toMatch(/did not declare these columns/);
        expect(screen.getByTestId('playbook-start').disabled).toBe(false);
    });

    it('a clean composition shows no synthesized-columns note', async () => {
        playbooksApi.composeRecipe.mockResolvedValue({ recipe: COMPOSED, warnings: ['no_app'] });
        render(<NewPlaybookDialog user={{ id: 'u1' }} onClose={vi.fn()} onCreated={vi.fn()} />);
        await screen.findByText('Facturen bijhouden');
        fireEvent.click(screen.getByText('Describe it'));
        fireEvent.change(screen.getByLabelText('What should this playbook build?'), { target: { value: 'Lees contracten in' } });
        fireEvent.click(screen.getByTestId('playbook-compose'));
        await screen.findByTestId('playbook-recipe-preview');
        expect(screen.queryByTestId('playbook-columns-synthesized')).toBeNull();
    });

    it('a cut-off composition (compose_truncated) says to ask for less, in the GUI language', async () => {
        playbooksApi.composeRecipe.mockRejectedValue(Object.assign(new Error('server sentence'), { status: 422, code: 'compose_truncated', body: { errors: [] } }));
        render(<NewPlaybookDialog user={{ id: 'u1' }} onClose={vi.fn()} onCreated={vi.fn()} />);
        await screen.findByText('Facturen bijhouden');
        fireEvent.click(screen.getByText('Describe it'));
        fireEvent.change(screen.getByLabelText('What should this playbook build?'), { target: { value: 'alles' } });
        fireEvent.click(screen.getByTestId('playbook-compose'));
        expect((await screen.findByRole('alert')).textContent).toMatch(/longer than the model can write in one answer/);
        expect(screen.getByTestId('playbook-start').disabled).toBe(true);
    });

    it('a refused composition shows the validator\'s findings and keeps Start closed', async () => {
        playbooksApi.composeRecipe.mockRejectedValue(Object.assign(new Error("The model's playbook is not runnable."), { status: 422, code: 'recipe_invalid', body: { errors: [{ code: 'brief_required', message: 'Phase "R" needs a brief.' }] } }));
        render(<NewPlaybookDialog user={{ id: 'u1' }} onClose={vi.fn()} onCreated={vi.fn()} />);
        await screen.findByText('Facturen bijhouden');
        fireEvent.click(screen.getByText('Describe it'));
        fireEvent.change(screen.getByLabelText('What should this playbook build?'), { target: { value: 'iets' } });
        fireEvent.click(screen.getByTestId('playbook-compose'));
        expect((await screen.findByRole('alert')).textContent).toContain('needs a brief');
        expect(screen.getByTestId('playbook-start').disabled).toBe(true);
    });
});
