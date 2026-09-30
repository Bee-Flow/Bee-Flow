/**
 * The Form page over a mocked HTTP client and the real draft store:
 *
 *   - the owner edits a question and saves it into the routine's definition
 *     (PUT /api/automation/:id), and a tab switch with unsaved questions asks;
 *   - an older link carrying the page TOKEN is swapped for the routine's id;
 *   - a colleague the answers are shared with sees Answers only;
 *   - Share changes who may fill it in, Settings arms the routine and turns
 *     collecting off (asking first);
 *   - the answers table opens on the phone's own table screen — never the
 *     web's Studio in a browser tab, which has no session and sends a phone
 *     back to Chat.
 */

import { QueryClient } from '@tanstack/react-query';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { setServerUrl } from '@/core/api/server';
import { useAuth } from '@/core/auth/AuthProvider';
import { resetDraftRegistry } from '@/features/flow-editor/state';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { FormPageScreen } from './FormPageScreen';

jest.setTimeout(30_000);

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), setParams: jest.fn() };
jest.mock('expo-router', () => ({
    useRouter: () => mockRouter,
    useNavigation: () => ({ isFocused: () => true, addListener: () => () => undefined, dispatch: jest.fn() }),
    useFocusEffect: jest.fn(),
}));
// The Share tab's link card still opens the FORM's own page in the browser.
jest.mock('expo-web-browser', () => ({ openBrowserAsync: jest.fn() }));
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: jest.fn() }));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());

const AID = '3f2b6c1e-0000-4000-8000-000000000001';
const TOKEN = 'ab'.repeat(24);

const FORM = {
    title: 'Intake',
    description: '',
    submitLabel: 'Send',
    successMessage: 'Thanks',
    collect: true,
    fields: [{ name: 'full_name', type: 'text', label: 'Your name', required: true, placeholder: '' }],
    theme: { primary: '#0F766E', radius: 'md', density: 'comfortable', fontScale: 'md', appearance: 'light' },
};
const DEF = { schemaVersion: 1, trigger: { id: 'trg', type: 'trigger', kind: 'form', form: FORM, output: {} }, steps: [], edges: [], vars: {} };

const detail = (patch: Record<string, unknown> = {}) => ({
    form: {
        id: TOKEN, url: `/f/${TOKEN}`, automationId: AID, title: 'Intake', description: null, live: false, isActive: false, isDraft: true,
        submissions: 0, mine: true, canOpen: true, audience: { mode: 'restricted', groups: [], users: [] },
        questions: { ...FORM, fields: FORM.fields },
        pages: [],
        answers: { collecting: true, datatableId: 't1', grade: 'owner', rowCount: 0, linked: true, lastWriteError: null },
        definition: DEF,
        routineTitle: 'Intake',
        ...patch,
    },
});

const SUMMARY = {
    table: { id: 't1', name: 'Intake answers', rowCount: 2 },
    range: { from: '2026-08-27', to: '2026-09-25', bucket: 'day' },
    totals: { all: 2, inRange: 2, last7d: 2, today: 1, completed: 2, open: 0, lastAt: '2026-09-25T08:00:00.000Z' },
    timeline: [{ bucket: '2026-09-25', n: 2 }],
    questions: [{ fieldId: 'f1', key: 'full_name', label: 'Your name', formType: 'text', columnType: 'text', answered: 2, skipped: 0, breakdown: { kind: 'text', recent: [{ rowId: 'r1', value: 'Anna', at: null }] } }],
    recent: [{ rowId: 'r1', submittedAt: '2026-09-25T08:00:00.000Z', runId: null, by: { id: 'u2', name: 'Bert' }, preview: { full_name: 'Anna' } }],
};

function routes(overrides: Record<string, unknown> = {}) {
    (api.get as jest.Mock).mockImplementation(async (path: string) => {
        if (path in overrides) return overrides[path];
        if (path === '/api/automation/forms') return { forms: [detail().form] };
        if (path === `/api/automation/forms/${AID}`) return detail();
        if (path === `/api/automation/${AID}`) return { automation: { id: AID, title: 'Intake', definition: DEF, version: 1, isActive: false, isDraft: true }, summary: '' };
        if (path === '/api/automation/catalog/form-pick-sources') return { sources: [] };
        if (path === '/api/datatables/t1/answers/summary') return SUMMARY;
        return null;
    });
}

/** Mutations kept forever too: a finished one's five-minute GC timer would outlive the test. */
const client = () => new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { retry: false, gcTime: Infinity } } });

async function mount(formRef = AID, tab: string | null = null) {
    return renderWithProviders(
        <ToastProvider>
            <ConfirmProvider>
                <FormPageScreen formRef={formRef} tab={tab} />
            </ConfirmProvider>
        </ToastProvider>,
        { queryClient: client() },
    );
}

beforeAll(async () => {
    await setServerUrl('https://bee.test');
});

beforeEach(() => {
    jest.clearAllMocks();
    (useAuth as jest.Mock).mockReturnValue({ stage: { kind: 'signed-in', user: { id: 'u1' } }, user: { id: 'u1' }, permissions: null });
    routes();
    (api.put as jest.Mock).mockImplementation(async (path: string, body: { definition?: unknown; audience?: string }) => {
        if (path.endsWith('/audience')) return { audience: { mode: body.audience, groups: [], users: [] } };
        return { automation: { id: AID, title: 'Intake', definition: body.definition, version: 2, isActive: false, isDraft: true }, warnings: [] };
    });
});

afterEach(async () => {
    await cleanup();
    resetDraftRegistry();
});

it('saves an edited question into the routine’s definition', async () => {
    await mount();
    const label = await screen.findByTestId('question-1-label', {}, { timeout: 5000 });
    expect(screen.getByTestId('form-save').props.accessibilityState).toMatchObject({ disabled: true });
    await fireEvent.changeText(label, 'Full name');
    await fireEvent.press(screen.getByTestId('form-save'));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const [path, body] = (api.put as jest.Mock).mock.calls.at(-1) as [string, { definition: typeof DEF }];
    expect(path).toBe(`/api/automation/${AID}`);
    expect(body.definition.trigger.form.fields[0]).toMatchObject({ name: 'full_name', label: 'Full name' });
    expect(body.definition.trigger.form.collect).toBe(true);
});

it('asks before a tab switch throws unsaved questions away', async () => {
    await mount();
    await fireEvent.changeText(await screen.findByTestId('question-1-label', {}, { timeout: 5000 }), 'Changed');
    await fireEvent.press(screen.getByText('Share'));
    expect(await screen.findByText('Unsaved changes')).toBeTruthy();
    await fireEvent.press(screen.getByText('Leave'));
    expect(await screen.findByText('Who can fill it in')).toBeTruthy();
    expect(api.put).not.toHaveBeenCalled();
});

it('swaps an old link’s page token for the routine’s id', async () => {
    await mount(TOKEN);
    await waitFor(() => expect(mockRouter.replace).toHaveBeenCalledWith(`/forms/${AID}`));
});

it('shows a colleague the answers only', async () => {
    routes({ [`/api/automation/forms/${AID}`]: detail({ mine: false, definition: undefined, answers: { collecting: true, datatableId: 't1', grade: 'viewer', rowCount: 2, linked: true, lastWriteError: null } }) });
    await mount(AID, 'questions');
    expect(await screen.findByTestId('form-answers', {}, { timeout: 5000 })).toBeTruthy();
    expect(screen.queryByText('Questions')).toBeNull();
    expect(await screen.findByText('Anna', {}, { timeout: 5000 })).toBeTruthy();
    expect(api.get).not.toHaveBeenCalledWith(`/api/automation/${AID}`, expect.anything());
});

it('opens the form to everyone in the organisation, after asking', async () => {
    await mount(AID, 'share');
    await fireEvent.press(await screen.findByTestId('form-audience-org', {}, { timeout: 5000 }));
    await fireEvent.press(await screen.findByText('Open to everyone'));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith(`/api/automation/forms/${AID}/audience`, { audience: 'org', sharedGroups: [], sharedUserIds: [] }, expect.anything()));
});

it('arms the routine to go live, and stops collecting only after asking', async () => {
    (api.post as jest.Mock).mockResolvedValue({ automation: { id: AID, title: 'Intake', definition: DEF, version: 2, isActive: true, isDraft: false }, warnings: [] });
    await mount(AID, 'settings');
    await fireEvent(await screen.findByTestId('form-live', {}, { timeout: 5000 }), 'valueChange', true);
    await waitFor(() => expect(api.post).toHaveBeenCalledWith(`/api/automation/${AID}/activate`, undefined, expect.anything()));

    await fireEvent(screen.getByTestId('form-collect'), 'valueChange', false);
    await fireEvent.press(await screen.findByText('Stop collecting'));
    await waitFor(() => expect(api.put).toHaveBeenCalled());
    const body = (api.put as jest.Mock).mock.calls.at(-1)?.[1] as { definition: typeof DEF };
    expect(body.definition.trigger.form.collect).toBe(false);
});

describe('the answers table opens natively', () => {
    const table = (tab: string) => ({ pathname: '/datatables/[id]', params: { id: 't1', tab } });

    it('from Answers, Share and Settings, on its rows', async () => {
        await mount(AID, 'answers');
        await fireEvent.press(await screen.findByTestId('answers-open-table', {}, { timeout: 5000 }));
        expect(mockRouter.push).toHaveBeenLastCalledWith(table('rows'));

        await fireEvent.press(screen.getByText('Share'));
        await fireEvent.press(await screen.findByTestId('form-open-table'));
        expect(mockRouter.push).toHaveBeenLastCalledWith(table('rows'));

        await fireEvent.press(screen.getByText('Settings'));
        await fireEvent.press(await screen.findByTestId('form-settings-open-table'));
        expect(mockRouter.push).toHaveBeenLastCalledWith(table('rows'));
        expect(jest.requireMock('expo-web-browser').openBrowserAsync).not.toHaveBeenCalled();
    });

    it('from Settings, on how long the answers are kept', async () => {
        await mount(AID, 'settings');
        await fireEvent.press(await screen.findByTestId('form-retention-open', {}, { timeout: 5000 }));
        expect(mockRouter.push).toHaveBeenCalledWith(table('retention'));
        expect(jest.requireMock('expo-web-browser').openBrowserAsync).not.toHaveBeenCalled();
    });
});
