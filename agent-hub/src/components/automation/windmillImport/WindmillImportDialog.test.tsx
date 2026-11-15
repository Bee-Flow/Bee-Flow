import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithClient } from '@/test/render';
import { jsonAnswer } from '@/test/http';
import EntitlementsContext from '@/components/licensing/EntitlementsContext';
import type { EntitlementsValue } from '@/components/licensing/EntitlementsContext';
import WindmillImportDialog from './WindmillImportDialog';

/**
 * The Windmill import dialog against the routes' shapes (a stubbed fetch):
 * upload → preview → import → the per-flow report with "Complete with AI",
 * the remote source never keeps its token, the inventory panel only shows
 * when the server says `available: true`, and a plan without the feature
 * gets the upgrade hint instead of the form.
 */

const fetchMock = vi.fn();
const rel = (u: unknown) => String(u).replace(/^https?:\/\/[^/]+/, '');
type Hit = { status: number; body: unknown } | null;
let route: (method: string, path: string, init?: RequestInit) => Hit = () => null;

const FLOW = {
    path: 'f/demo/expense', title: 'Expense claim', triggerType: 'app_event', generation: 'standalone',
    counts: { mapped: 3, pattern: 1, shim: 0, ai: 1, unsupported: 0, dropped: 0 }, confidence: 'low',
    modules: [], aiChecklist: [{ wmId: 'ocr', stepId: 'ocr', title: 'Analyse the images', why: 'No image input yet' }],
    warnings: [
        { code: 'identity_change', message: 'Bee Flow runs it as the owner.' },
        { code: 'trigger_switch_off', message: 'Switch the Windmill trigger off.' },
    ],
    connections: [{ kind: 'resource', path: 'u/admin/smtp', where: ['mail'] }], outboundHosts: ['api.example.com'],
    suggestedRunPolicy: {}, validationErrors: [], importable: true,
};
const PREVIEW = { mode: 'preview', flows: [FLOW], notMigrated: [], readWarnings: [], notes: [] };
const REPORT = {
    automationId: 'a-new', sourceKind: 'windmill_upload', windmillPath: FLOW.path, windmillGeneration: 'standalone', createdAt: null,
    acknowledged: [], dryRunOkAt: null,
    gate: { applies: true, open: [{ wmId: 'ocr', stepId: 'ocr', title: 'Analyse the images' }], dryRunRequired: true, cleared: false },
    report: { title: FLOW.title, warnings: FLOW.warnings },
    brief: 'Complete this automation that was imported from Windmill …',
};

function Dialog(props: Partial<React.ComponentProps<typeof WindmillImportDialog>>) {
    return (
        <WindmillImportDialog
            open
            onClose={props.onClose ?? (() => {})}
            onImported={props.onImported ?? (() => {})}
            onCompleteWithAi={props.onCompleteWithAi ?? (() => {})}
            onOpenAutomation={props.onOpenAutomation ?? (() => {})}
        />
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockImplementation(async (url: unknown, init?: RequestInit) => {
        const hit = route(String(init?.method || 'GET'), rel(url), init);
        return jsonAnswer(hit ? hit.body : { error: 'Not found' }, hit ? hit.status : 404);
    });
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('WindmillImportDialog', () => {
    it('uploads an export, previews it, imports the selection and offers "Complete with AI"', async () => {
        const modes: string[] = [];
        route = (method, path, init) => {
            if (path.endsWith('/import/windmill/upload')) {
                const form = init?.body as FormData;
                modes.push(String(form.get('mode')));
                const file = form.get('file') as File;
                expect(file.type).toBe('application/yaml');
                if (form.get('mode') === 'commit') {
                    expect(JSON.parse(String(form.get('select')))).toEqual([FLOW.path]);
                    return { status: 200, body: { ...PREVIEW, mode: 'commit', results: [{ path: FLOW.path, title: FLOW.title, ok: true, automationId: 'a-new', openItems: 1 }] } };
                }
                return { status: 200, body: PREVIEW };
            }
            if (method === 'GET' && path.endsWith('/a-new/import-report')) return { status: 200, body: REPORT };
            return null;
        };
        const onImported = vi.fn();
        const onCompleteWithAi = vi.fn();
        const user = userEvent.setup();
        const { container } = renderWithClient(<Dialog onImported={onImported} onCompleteWithAi={onCompleteWithAi} />);

        const input = container.ownerDocument.querySelector('input[type="file"]') as HTMLInputElement;
        await user.upload(input, new File(['summary: x\nvalue:\n  modules: []\n'], 'flow.yaml', { type: '' }));
        await user.click(screen.getByRole('button', { name: 'Preview' }));

        expect(await screen.findByText('Expense claim')).toBeInTheDocument();
        expect(screen.getByText('Needs work')).toBeInTheDocument();
        expect(screen.getByText(/Sends data to: api\.example\.com/)).toBeInTheDocument();
        expect(screen.getByText(/u\/admin\/smtp/)).toBeInTheDocument();
        expect(screen.getByRole('checkbox', { name: 'Expense claim' })).toBeChecked();

        await user.click(screen.getByRole('button', { name: 'Import 1 flows' }));
        expect(await screen.findByRole('button', { name: /Complete with AI/ })).toBeInTheDocument();
        expect(onImported).toHaveBeenCalledTimes(1);
        expect(screen.getByText(/2 things to check|Switch the Windmill trigger off/)).toBeTruthy();
        expect(screen.getByText(/A dry run of this version without errors is needed/)).toBeInTheDocument();

        await user.click(screen.getByRole('button', { name: /Complete with AI/ }));
        expect(onCompleteWithAi).toHaveBeenCalledWith('a-new', REPORT.brief);
        expect(modes).toEqual(['preview', 'commit']);
    });

    it('reads a standalone Windmill with the token in the body, and clears the token after the import', async () => {
        const bodies: Array<Record<string, unknown>> = [];
        route = (_m, path, init) => {
            if (path.endsWith('/import/windmill/remote')) {
                const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
                bodies.push(body);
                return { status: 200, body: body.mode === 'commit' ? { ...PREVIEW, mode: 'commit', results: [] } : PREVIEW };
            }
            return null;
        };
        const user = userEvent.setup();
        renderWithClient(<Dialog />);
        await user.click(screen.getByRole('tab', { name: 'Read from a Windmill' }));
        await user.type(screen.getByLabelText('Windmill address (https://)'), 'https://wm.example.com');
        await user.type(screen.getByLabelText('Workspace id'), 'main');
        await user.type(screen.getByLabelText('Read-only token'), 'tok');
        await user.click(screen.getByRole('button', { name: 'Preview' }));
        await screen.findByText('Expense claim');
        await user.click(screen.getByRole('button', { name: 'Import 1 flows' }));
        await waitFor(() => expect(bodies).toHaveLength(2));
        expect(bodies[0]).toEqual({ source: 'windmill_api', baseUrl: 'https://wm.example.com', workspace: 'main', token: 'tok', mode: 'preview' });
        expect(bodies[1].mode).toBe('commit');
        await user.click(screen.getByRole('button', { name: 'Done' }));
    });

    it('shows the inventory only when the server says available', async () => {
        route = (method, path) => (method === 'GET' && path.endsWith('/import/windmill/inventory')
            ? { status: 200, body: { available: true, generation: 'standalone', flows: [{ path: 'f/a/b', summary: 'File to table', events: ['file.new'], active: true }] } }
            : null);
        const first = renderWithClient(<Dialog />);
        expect(await screen.findByText('Found in this Nextcloud')).toBeInTheDocument();
        expect(screen.getByText('File to table')).toBeInTheDocument();
        first.unmount();

        route = () => null; // the route does not exist on this server: 404
        renderWithClient(<Dialog />);
        await screen.findByRole('tab', { name: 'Upload an export' });
        await waitFor(() => expect(fetchMock).toHaveBeenCalled());
        expect(screen.queryByText('Found in this Nextcloud')).not.toBeInTheDocument();
    });

    it('a plan without the feature gets the upgrade hint and no form', () => {
        const ent = { loading: false, lockReason: (id: string) => (id === 'automation_import' ? 'ceiling' : null) } as unknown as EntitlementsValue;
        renderWithClient(
            <EntitlementsContext.Provider value={ent}>
                <Dialog />
            </EntitlementsContext.Provider>,
        );
        expect(screen.getByText('Importing from Windmill is part of the Enterprise plan')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Preview' })).not.toBeInTheDocument();
    });
});
