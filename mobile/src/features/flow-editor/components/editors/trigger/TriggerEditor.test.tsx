/**
 * The trigger editor on screen: the kind switch renames a generated name and
 * opens the kind's band, a schedule is seeded and previewed by the server, an
 * app event snaps to the first app and edits its filter, a flowlet declares
 * its inputs, and a form trigger is created on a tap and grows a question.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';

import { api } from '@/core/api/client';
import type { FlowCatalog } from '@/features/flow-editor/api';
import type { FlowNode } from '@/features/flow-editor/bindings';

import { renderEditor } from '../testing';

jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('expo-clipboard', () => ({ setStringAsync: jest.fn(async () => true) }));
jest.mock('expo-router', () => ({ useRouter: () => ({ push: jest.fn() }) }));

const post = api.post as jest.Mock;
const get = api.get as jest.Mock;

const trigger = (extra: Record<string, unknown> = {}) => ({ id: 'trg', type: 'trigger', kind: 'manual', label: 'Manual trigger', ...extra }) as FlowNode;

beforeEach(() => {
    jest.clearAllMocks();
    get.mockResolvedValue({});
    post.mockResolvedValue({ valid: true, cron: '0 9 * * *', tz: 'Europe/Amsterdam', next: ['2026-10-01T07:00:00.000Z'] });
});

describe('TriggerEditor', () => {
    it('switches kind, renames a generated name, and seeds the schedule', async () => {
        const h = await renderEditor(trigger());
        await fireEvent.press(await screen.findByTestId('trigger-kind-select'));
        await fireEvent.press(screen.getByTestId('trigger-kind-option-schedule'));
        expect(h.draft()).toMatchObject({ kind: 'schedule', label: 'Schedule' });
        await waitFor(() => expect(h.patch().schedule).toEqual({ cron: '0 9 * * *', tz: 'Europe/Amsterdam' }));
        await waitFor(() => expect(post).toHaveBeenCalledWith('/api/automation/_schedule/preview', { cron: '0 9 * * *', tz: 'Europe/Amsterdam', count: 3 }, expect.anything()));
        expect(await screen.findByText(/Next runs in Europe\/Amsterdam/)).toBeTruthy();
    });

    it('snaps an app event to the first app and edits its filter', async () => {
        const catalog = {
            triggers: [{ kind: 'app_event', providers: [{ id: 'gmail', label: 'Gmail', defaultEvent: 'mail.new', events: [{ id: 'mail.new', label: 'New email' }] }] }],
        } as unknown as FlowCatalog;
        const h = await renderEditor(trigger({ kind: 'app_event', label: 'App event' }), { catalog });
        await waitFor(() => expect(h.draft()).toMatchObject({ appProvider: 'gmail', appEventName: 'mail.new' }));
        expect(await screen.findByText('Gmail filter (all optional, AND across keys)')).toBeTruthy();
        await fireEvent.changeText(screen.getByLabelText('Subject contains'), 'invoice');
        expect(h.patch().appEvent).toEqual({ provider: 'gmail', event: 'mail.new', filter: { subjectContains: 'invoice' } });
    });

    it('says so when no app can be watched', async () => {
        await renderEditor(trigger({ kind: 'app_event', label: 'App event' }), { catalog: { triggers: [] } as unknown as FlowCatalog });
        expect(await screen.findByText(/No event sources are available to you yet/)).toBeTruthy();
    });

    it('declares a flowlet’s inputs', async () => {
        const h = await renderEditor(trigger({ kind: 'layer_input', label: 'Flowlet input' }));
        await fireEvent.press(await screen.findByText('Add input'));
        expect(h.patch().params).toEqual([{ name: 'input1', type: 'string', required: false }]);
        expect(screen.queryByTestId('trigger-kind-select')).toBeNull();
    });

    it('commits a parameter rename on submit, and refuses a name the server would', async () => {
        const h = await renderEditor(trigger({ kind: 'agent_call', label: 'Agent', parametersSchema: { type: 'object', properties: { city: { type: 'string' } } } }));
        const box = await screen.findByLabelText('Field 1 name');
        await fireEvent.changeText(box, '2nd');
        await fireEvent(box, 'submitEditing');
        expect(await screen.findByText('Start with a letter; letters, digits and underscores only.')).toBeTruthy();
        await fireEvent.changeText(box, 'town');
        await fireEvent(box, 'submitEditing');
        expect(h.draft().params).toEqual([expect.objectContaining({ name: 'town' })]);
    });

    it('creates a form on a tap, then adds a question to it', async () => {
        const h = await renderEditor(trigger({ kind: 'form', label: 'Form' }));
        await fireEvent.press(await screen.findByTestId('form-create'));
        expect((h.draft().form as { fields: unknown[] }).fields).toHaveLength(3);
        await fireEvent.press(screen.getByText('Add a question'));
        expect((h.patch().form as { fields: { name: string }[] }).fields.map((f) => f.name)).toEqual(['name', 'email', 'message', 'new_question']);
    });

    it('offers an additional trigger only the kinds it may be', async () => {
        const definition = { trigger: { id: 'trg', type: 'trigger', kind: 'manual' }, triggers: [{ id: 't2', type: 'trigger', kind: 'webhook' }], steps: [], edges: [] };
        await renderEditor({ id: 't2', type: 'trigger', kind: 'schedule', label: 'Schedule' } as FlowNode, { definition: definition as never });
        await fireEvent.press(await screen.findByTestId('trigger-kind-select'));
        expect(screen.queryByTestId('trigger-kind-option-manual')).toBeNull();
        expect(screen.getByTestId('trigger-kind-option-webhook')).toBeTruthy();
    });

    it('gives a webhook trigger its URL on first open, and shows the secret once', async () => {
        let listed: unknown[] = [];
        get.mockImplementation(async (path: string) => (path === '/api/automation/flow-1/webhooks' ? { webhooks: listed } : {}));
        post.mockImplementation(async (path: string) => {
            if (path !== '/api/automation/flow-1/webhook') return {};
            listed = [{ id: 'slug1', triggerStepId: 'trg', url: 'https://h/api/automation/webhook/slug1' }];
            return { webhook: { id: 'slug1', triggerStepId: 'trg', url: 'https://h/api/automation/webhook/slug1', secret: 'abcdefghijkl' } };
        });
        await renderEditor(trigger({ kind: 'webhook', label: 'Webhook' }));
        await waitFor(() => expect(post).toHaveBeenCalledWith('/api/automation/flow-1/webhook', { triggerStepId: 'trg' }, expect.anything()));
        expect(await screen.findByText('https://h/api/automation/webhook/slug1')).toBeTruthy();
        expect(screen.getByText('••••••••ijkl')).toBeTruthy();
        expect(post).toHaveBeenCalledTimes(1);
    });
});
