import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import AppList from './AppList';

vi.mock('./studioAppsApi', () => {
    const studioAppsApi = {
        listAccessible: vi.fn(),
        listMine: vi.fn(),
        listTemplates: vi.fn(),
        deleteTemplate: vi.fn(),
        createApp: vi.fn(),
        updateApp: vi.fn(),
        deleteApp: vi.fn(),
        templateUpgrade: vi.fn(),
        exportTemplate: vi.fn(),
        importTemplate: vi.fn(),
        importApp: vi.fn(),
    };
    return { studioAppsApi, default: studioAppsApi };
});

vi.mock('../../../shared/Toast', () => {
    const toast = { success: vi.fn(), error: vi.fn(), info: vi.fn() };
    return { default: toast, toast };
});

import { studioAppsApi } from './studioAppsApi';
import toast from '../../../shared/Toast';

const OWNED_APP = {
    id: 'app-owned',
    userId: 'u1',
    name: 'My tracker',
    description: 'Owned by me',
    icon: 'Rocket',
    accentColor: '#0F766E',
    isPublished: false,
    updatedAt: '2026-07-01T10:00:00.000Z',
};

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(studioAppsApi.listAccessible).mockResolvedValue({ apps: [OWNED_APP] });
    vi.mocked(studioAppsApi.listMine).mockResolvedValue({ apps: [OWNED_APP] });
    vi.mocked(studioAppsApi.listTemplates).mockResolvedValue({
        templates: [{
            id: 'tpl_ticket',
            title: 'Ticket tracker',
            description: 'Collect and triage requests.',
            category: 'Forms',
            icon: 'Ticket',
            tags: ['forms'],
        }],
    });
    vi.mocked(studioAppsApi.createApp).mockResolvedValue({ success: true, app: { id: 'app-new', name: 'Ticket tracker' } });
});

// The import tab produces a TEMPLATE, never an app, unless the file is an
// app archive — see `ARCHIVE` in the describe below. `ENVELOPE`, `jsonFile`
// and `openImportTab` are shared by both, so they live here rather than in
// either describe: each describe's own arrow function stays under the line
// cap this way, carrying only its own tests.
const ENVELOPE = {
    format: 'beeflow.apptemplate',
    schemaVersion: 1,
    exportedAt: '2026-09-22T10:00:00.000Z',
    source: { templateId: 'utpl_far', orgId: 'org-far', orgName: 'Acme BV', version: 2 },
    template: {
        version: 2,
        title: 'Purchase intake',
        description: 'From a colleague.',
        definition: { screens: [{ id: 'scr_1' }, { id: 'scr_2' }] },
        dataModel: { tables: [{ id: 'tbl_a' }] },
        seed: { tbl_a: [{ name: 'Ada' }, { name: 'Grace' }] },
    },
};

/** A file whose .text() resolves — jsdom's Blob.text is not always there. */
function jsonFile(data: unknown, name = 'purchase-intake.beeflow-app.json') {
    const body = typeof data === 'string' ? data : JSON.stringify(data);
    const file = new File([body], name, { type: 'application/json' });
    if (typeof file.text !== 'function') file.text = () => Promise.resolve(body);
    return file;
}

async function openImportTab() {
    const user = userEvent.setup();
    render(<AppList onOpen={vi.fn()} />);
    await screen.findByText('My tracker');
    await user.click(screen.getByRole('button', { name: /New app/ }));
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('tab', { name: 'From a file' }));
    return { user, input: screen.getByTestId('app-template-import-input') };
}

/**
 * Bringing a template file from another Bee Flow.
 *
 * Split out of AppList.test.jsx (which keeps blank/create/rename/delete/
 * upgrade) so this file's own setup — the import/export mocks above — is not
 * tangled with the rest, and so neither file's line count carries the
 * other's tests. Split again from the app-archive describe below for the
 * same reason: one describe, one line budget.
 *
 * These tests pin that the import tab produces a TEMPLATE, never an app,
 * because "import" reads to most people as "and then open it", and an app
 * created behind someone's back is the one outcome this must not have.
 */
describe('AppList — importing a template file', () => {
    it('a picked template file is previewed by what it claims, then added to the gallery', async () => {
        vi.mocked(studioAppsApi.importTemplate).mockResolvedValue({
            template: { id: 'utpl_new', title: 'Purchase intake' }, report: {}, warnings: [],
        });
        const { user, input } = await openImportTab();

        await user.upload(input, jsonFile(ENVELOPE));

        expect(await screen.findByText('Purchase intake')).toBeInTheDocument();
        expect(screen.getByText(/2 screens · 1 table · 2 example rows/)).toBeInTheDocument();
        // The provenance block is shown as a claim, never as a fact.
        expect(screen.getByText(/The file says it came from Acme BV/)).toBeInTheDocument();

        await user.click(screen.getByTestId('app-template-import-confirm'));

        await waitFor(() => expect(studioAppsApi.importTemplate).toHaveBeenCalledWith(ENVELOPE, {}));
        // A template, not an app.
        expect(studioAppsApi.createApp).not.toHaveBeenCalled();
        // And the gallery is refetched so the new template is actually there.
        await waitFor(() => expect(studioAppsApi.listTemplates).toHaveBeenCalledTimes(2));
    });

    it('a name typed in the modal renames the imported template', async () => {
        vi.mocked(studioAppsApi.importTemplate).mockResolvedValue({ template: { id: 'utpl_new' }, warnings: [] });
        const { user, input } = await openImportTab();
        await user.upload(input, jsonFile(ENVELOPE));
        await screen.findByText('Purchase intake');

        await user.type(screen.getByPlaceholderText('e.g. Vacation requests'), 'PO intake');
        await user.click(screen.getByTestId('app-template-import-confirm'));

        await waitFor(() => expect(studioAppsApi.importTemplate).toHaveBeenCalledWith(ENVELOPE, { title: 'PO intake' }));
    });

    it('a file that is not JSON is answered here, without troubling the server', async () => {
        const { user, input } = await openImportTab();
        await user.upload(input, jsonFile('this is not json{', 'notes.txt'));

        expect(await screen.findByText(/not readable JSON/)).toBeInTheDocument();
        expect(studioAppsApi.importTemplate).not.toHaveBeenCalled();
    });

    it('a server refusal names each reason, so the file can be fixed', async () => {
        const err: Error & { status?: number; body?: unknown } = new Error('That file could not be imported');
        err.status = 400;
        err.body = { details: ['screens.missing @ screens', 'action.unknown @ actions.act_1'] };
        vi.mocked(studioAppsApi.importTemplate).mockRejectedValue(err);

        const { user, input } = await openImportTab();
        await user.upload(input, jsonFile(ENVELOPE));
        await screen.findByText('Purchase intake');
        await user.click(screen.getByTestId('app-template-import-confirm'));

        expect(await screen.findByRole('alert')).toHaveTextContent('screens.missing @ screens');
        // Still on the import tab with the file in hand — nothing to re-pick.
        expect(screen.getByTestId('app-template-import-confirm')).toBeInTheDocument();
    });
});

/**
 * The other file kind: an app archive.
 *
 * One picker, two formats. The file says which it is, and everything after
 * that follows from `format` — the call, the button, the wording, and where
 * the modal lands. A template produced a template, so the gallery is the
 * result; an archive produced a working app, so the app is.
 */
describe('AppList — importing an app archive', () => {
    const ARCHIVE = {
        format: 'beeflow.app',
        schemaVersion: 1,
        source: { orgName: 'Acme BV' },
        app: { name: 'Aanvraag automatisering', description: 'With its data' },
        template: { definition: { screens: [{ id: 'scr_1' }, { id: 'scr_2' }] }, dataModel: { tables: [{ id: 'tbl_a' }] } },
        content: {
            records: { tbl_a: [{ name: 'Ada' }, { name: 'Grace' }, { name: 'Alan' }] },
            files: [{ ref: 'f1', size: 2 * 1024 * 1024 }, { ref: 'f2', size: 1024 }],
        },
    };

    it('an app archive is previewed as rows and documents, and creates the app', async () => {
        vi.mocked(studioAppsApi.importApp).mockResolvedValue({
            app: { id: 'app_new', name: 'Aanvraag automatisering' },
            report: { installed: { rows: 3, files: 2 } },
            warnings: [],
        });
        const onOpen = vi.fn();
        const user = userEvent.setup();
        render(<AppList onOpen={onOpen} />);
        await screen.findByText('My tracker');
        await user.click(screen.getByRole('button', { name: /New app/ }));
        await screen.findByRole('dialog');
        await user.click(screen.getByRole('tab', { name: 'From a file' }));
        const input = screen.getByTestId('app-template-import-input');

        await user.upload(input, jsonFile(ARCHIVE, 'demo.beeflow-appdata.json'));

        expect(await screen.findByText('Aanvraag automatisering')).toBeInTheDocument();
        // Real rows, not "example rows" — and the documents, with their weight.
        expect(screen.getByText(/2 screens · 1 table · 3 rows · 2 files \(2.0 MB\)/)).toBeInTheDocument();
        // Provenance stays a claim for an archive exactly as for a template.
        expect(screen.getByText(/The file says it came from Acme BV/)).toBeInTheDocument();

        // The button says what pressing it does.
        const confirm = screen.getByTestId('app-template-import-confirm');
        expect(confirm).toHaveTextContent('Create the app');
        await user.click(confirm);

        await waitFor(() => expect(studioAppsApi.importApp).toHaveBeenCalledWith(ARCHIVE, {}));
        expect(studioAppsApi.importTemplate).not.toHaveBeenCalled();
        // An app, so the modal lands on the app rather than on the gallery.
        await waitFor(() => expect(onOpen).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'app_new' }),
        ));
    });

    it('a name typed in the modal renames the imported app', async () => {
        vi.mocked(studioAppsApi.importApp).mockResolvedValue({ app: { id: 'app_new' }, report: {}, warnings: [] });
        const { user, input } = await openImportTab();
        await user.upload(input, jsonFile(ARCHIVE, 'demo.beeflow-appdata.json'));
        await screen.findByText('Aanvraag automatisering');

        await user.type(screen.getByPlaceholderText('e.g. Vacation requests'), 'Demo');
        await user.click(screen.getByTestId('app-template-import-confirm'));

        await waitFor(() => expect(studioAppsApi.importApp).toHaveBeenCalledWith(ARCHIVE, { name: 'Demo' }));
    });

    it('what did NOT arrive is reported over the success, not under it', async () => {
        vi.mocked(studioAppsApi.importApp).mockResolvedValue({
            app: { id: 'app_new' },
            report: { installed: { rows: 3, files: 1 } },
            warnings: ['File skipped: drawing.pdf: the bytes do not match the sha256 in the file.'],
        });
        const { user, input } = await openImportTab();
        await user.upload(input, jsonFile(ARCHIVE, 'demo.beeflow-appdata.json'));
        await screen.findByText('Aanvraag automatisering');
        await user.click(screen.getByTestId('app-template-import-confirm'));

        // A missing drawing under a green toast reads as a broken app.
        await waitFor(() => expect(toast.error).toHaveBeenCalledWith(
            expect.stringContaining('drawing.pdf'),
        ));
        expect(toast.success).not.toHaveBeenCalledWith(expect.stringContaining('App imported'));
    });
});

describe('AppList — exporting a gallery template', () => {
    it('downloads it and repeats what the scrub cleared', async () => {
        const createObjectURL = vi.fn(() => 'blob:fake');
        const revokeObjectURL = vi.fn();
        const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
        Object.defineProperty(window.URL, 'createObjectURL', { value: createObjectURL, configurable: true });
        Object.defineProperty(window.URL, 'revokeObjectURL', { value: revokeObjectURL, configurable: true });

        vi.mocked(studioAppsApi.exportTemplate).mockResolvedValue({
            envelope: ENVELOPE,
            filename: 'ticket-tracker.beeflow-app.json',
            warnings: ['2 automation reference(s) removed — whoever installs this connects their own.'],
        });

        const user = userEvent.setup();
        render(<AppList onOpen={vi.fn()} />);
        await screen.findByText('My tracker');
        await user.click(screen.getByRole('button', { name: /New app/ }));
        await screen.findByRole('dialog');
        await user.click(screen.getByRole('tab', { name: 'From template' }));
        await screen.findByText('Ticket tracker');

        await user.click(screen.getByTestId('app-template-export-tpl_ticket'));

        await waitFor(() => expect(studioAppsApi.exportTemplate).toHaveBeenCalledWith('tpl_ticket'));
        await waitFor(() => expect(createObjectURL).toHaveBeenCalled());
        expect(click).toHaveBeenCalled();
        await waitFor(() => expect(toast.success).toHaveBeenCalledWith(
            expect.stringContaining('2 automation reference(s) removed'),
        ));
        // Exporting never creates anything.
        expect(studioAppsApi.createApp).not.toHaveBeenCalled();
        click.mockRestore();
    });
});
