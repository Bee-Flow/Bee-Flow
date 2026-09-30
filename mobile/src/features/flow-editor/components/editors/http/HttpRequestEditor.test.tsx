/**
 * The HTTP request, datatable and code editors on screen: a write method
 * grows a Body and a caution on the reuse tick, allowing private targets
 * refuses it; a credential is picked by name; a datatable write that changes
 * rows asks for a condition; a code step reads back what it reaches and
 * leads with the server's refusal where there is one.
 */

import { fireEvent, screen } from '@testing-library/react-native';

import { api } from '@/core/api/client';
import type { FlowCatalog } from '@/features/flow-editor/api';
import type { FlowNode } from '@/features/flow-editor/bindings';

import { renderEditor } from '../testing';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const get = api.get as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
    get.mockImplementation(async (url: string) =>
        url === '/api/integrations/connections' ? { connections: [{ id: 'c1', label: 'Stripe', kind: 'bearer', access: 'own' }] } : [],
    );
});

const catalog = (extra: Partial<FlowCatalog> = {}) =>
    ({
        datatables: [{ id: 't1', name: 'Leads', canWrite: true, scope: 'personal', columns: [{ key: 'email', name: 'Email', type: 'text' }] }],
        datatableOps: [
            { op: 'find_rows', label: 'Find rows', blurb: '', writes: false },
            { op: 'delete_rows', label: 'Delete rows', blurb: '', writes: true },
        ],
        flags: { code: true, codeReason: null, automations: true },
        ...extra,
    }) as unknown as FlowCatalog;

describe('HttpRequestEditor', () => {
    const step = { id: 'h1', type: 'http_request', label: 'Call', icon: 'Globe', url: '', method: 'GET', headers: {}, timeoutMs: 10_000 } as unknown as FlowNode;

    it('grows a body for a write method and cautions the reuse tick', async () => {
        const h = await renderEditor(step, { catalog: catalog() });
        expect(screen.queryByTestId('http-body')).toBeNull();
        await fireEvent.press(await screen.findByTestId('http-method-select'));
        await fireEvent.press(screen.getByTestId('http-method-option-POST'));
        await fireEvent.press(screen.getByRole('button', { name: 'Body' }));
        expect(screen.getByTestId('http-body')).toBeTruthy();
        // JSON and the address are read by a machine: no capitals, no autocorrect.
        expect(screen.getByTestId('http-body-input').props).toMatchObject({ autoCapitalize: 'none', autoCorrect: false });
        expect(screen.getByTestId('http-url-input').props).toMatchObject({ autoCapitalize: 'none', keyboardType: 'url' });
        // The examples read as the pills do, never as {{…}}.
        expect(screen.getByPlaceholderText('{"key": "‹Trigger ▸ Value›"}')).toBeTruthy();
        expect(screen.getByText(/e\.g\. https:\/\/api\.example\.com\/users\/‹Trigger ▸ Id›\./)).toBeTruthy();
        await fireEvent.press(screen.getByRole('button', { name: 'Advanced' }));
        expect(screen.getAllByText('A POST is not promised to be a look-up — if this call creates or changes something, reusing the answer skips it.').length).toBeGreaterThan(0);
        expect(h.patch()).toMatchObject({ method: 'POST' });
    });

    it('refuses both reuse ticks while private targets are allowed', async () => {
        await renderEditor({ ...step, blockPrivateTargets: false } as unknown as FlowNode, { catalog: catalog() });
        await fireEvent.press(await screen.findByRole('button', { name: 'Advanced' }));
        expect(screen.getByText('Not while private targets are allowed.')).toBeTruthy();
        expect(screen.getByText('Nothing is kept while private targets are allowed.')).toBeTruthy();
    });

    it('signs in with a credential picked by name, and adds a header', async () => {
        const h = await renderEditor(step, { catalog: catalog() });
        await fireEvent.press(await screen.findByRole('button', { name: 'Authentication' }));
        await fireEvent.press(await screen.findByTestId('http-credential-select'));
        await fireEvent.press(await screen.findByTestId('http-credential-option-c1'));
        await fireEvent.press(screen.getByRole('button', { name: 'Headers' }));
        await fireEvent.press(screen.getByTestId('http-header-add'));
        expect(h.patch()).toMatchObject({ auth: { connectionId: 'c1' }, headers: { Header: '' } });
    });
});

describe('DatatableEditor', () => {
    it('asks for a condition before a write that changes rows', async () => {
        const h = await renderEditor({ id: 'd1', type: 'datatable', label: 'Leads', icon: 'Table', datatableId: 't1', op: 'find_rows', where: [] } as unknown as FlowNode, { catalog: catalog() });
        await fireEvent.press(await screen.findByTestId('datatable-op-select'));
        await fireEvent.press(screen.getByTestId('datatable-op-option-delete_rows'));
        await fireEvent.press(screen.getByRole('button', { name: 'Which rows (required)' }));
        expect(screen.getByText('Add at least one condition. Without one this would change every row in the table.')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('datatable-where-add'));
        await fireEvent.press(screen.getByText('email'));
        expect(h.patch()).toMatchObject({ op: 'delete_rows', where: [{ field: 'email', op: 'eq', value: '' }] });
    });

    it('says how to get a table when there is none', async () => {
        await renderEditor({ id: 'd2', type: 'datatable', label: 'T', op: 'find_rows' } as unknown as FlowNode, { catalog: catalog({ datatables: [] }) });
        expect(await screen.findByText(/No datatables yet\. You can make one yourself/)).toBeTruthy();
    });
});

describe('CodeEditor', () => {
    const step = { id: 'c1', type: 'code', label: 'Sum', icon: 'Code', code: 'const r = await ctx.http("https://x"); return inputs.total;', inputs: {} } as unknown as FlowNode;

    it('reads back what the code reaches, and saves an edit', async () => {
        const h = await renderEditor(step, { catalog: catalog() });
        expect(await screen.findByText('Reads these step inputs: total.')).toBeTruthy();
        expect(screen.getByText(/^The web, over ctx\.http\(\)/)).toBeTruthy();
        await fireEvent.changeText(screen.getByTestId('code-source'), 'return 1');
        expect(screen.getByText('Reads no step inputs.')).toBeTruthy();
        expect(h.patch()).toEqual({ code: 'return 1' });
    });

    it('leads with the server’s reason when a code step would be refused', async () => {
        await renderEditor(step, { catalog: catalog({ flags: { code: false, codeReason: 'runtime', automations: true } }) });
        expect(await screen.findByText('This server was installed without the code sandbox, so a code step could not run here.')).toBeTruthy();
    });
});
