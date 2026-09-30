/**
 * The org shield editor against canned server answers: what it loads, the
 * exact document a save sends, the licence locks, and who is turned away.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { ToastProvider } from '@/shared/ui';

import { OrgShieldScreen } from './OrgShieldScreen';

jest.setTimeout(30_000);

const mockState = { isOrgAdmin: true, licences: ['pii_tokenize', 'web_search_guard', 'advanced_usage_monitoring'] };

jest.mock('expo-router', () => ({
    useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
    useNavigation: () => ({ addListener: () => () => undefined, dispatch: jest.fn() }),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('@/core/auth/AuthProvider', () => {
    const user = () => ({ id: 'me', organizationId: 'o1' });
    return { useAuth: () => ({ user: user() }), useCurrentUser: user };
});
jest.mock('@/core/access', () => ({
    ...jest.requireActual('@/core/access'),
    useAccess: () => ({ isOrgAdmin: mockState.isOrgAdmin, mode: 'cloud' }),
    useGate: (gate: { license?: string }) =>
        mockState.licences.includes(gate.license ?? '')
            ? { visible: true, locked: false, reason: null }
            : { visible: true, locked: true, reason: 'upgrade' },
}));
jest.mock('@/shared/markdown/Markdown', () => ({ Markdown: () => null }));

const DOC = {
    enabled: false,
    collectionIds: [],
    scope: { userInput: true, agentOutput: true },
    action: 'delete',
    euModeEnabled: false,
    piiDetectionCategories: ['Person'],
    piiDetectionConfidenceThreshold: 0.7,
    piiDetectionAction: 'block',
    piiFailureMode: 'fail_closed',
    attachmentLargeInputPolicy: 'fail_open',
    webSearchGuardPiiCategories: [],
    toolPiiPolicy: { external: { blockCategories: [] }, internal: { blockCategories: [] } },
    monitorIntegrations: false,
    applyToAutomations: true,
    piiAllowTerms: [],
    piiAllowPublicOrgs: true,
    dlpScope: 'all',
    updatedAt: '2026-09-01T10:00:00Z',
    updatedBy: 'u9',
    clamped_fields: ['webSearchGuardEnabled'],
    clamped_tier: 'community',
};

const ANSWERS: Record<string, unknown> = {
    '/api/org-privacy-shield/o1': DOC,
    '/api/org-privacy-shield/user/guard-status': { configured: false, reachable: false },
    '/ai/config': { searchProvider: 'serper' },
    '/ai/config/chat-models-eu': { fast: { modelId: 'mistral-small' } },
    '/api/usage/guardrails/overview': {
        summary: { total_events: '12', pii_count: '9', dlp_blocked: '1', unique_users: '2' },
        top_categories: [{ category: 'Email', count: '4' }],
        top_users: [{ user_id: 'u1', display_name: 'Bea', total: 3 }],
    },
    '/api/usage/integrations/overview': {
        summary: { total_calls: '5', non_eu_count: '2', pii_non_eu_count: '1', sovereignty_score: 71 },
        top: { destinations: [{ country_code: 'US', country_name: 'United States', is_eu: false, is_local: false, total: 2, pii_events: 1 }] },
    },
    '/api/usage/guardrails/recent': [
        { id: 1, timestamp: '2026-09-02T09:00:00Z', violation_type: 'pii', violation_categories: 'Email', action_taken: 'redacted', display_name: 'Bea', source: 'direct_chat' },
    ],
    '/api/usage/integrations/egress': [
        { id: 2, timestamp: '2026-09-02T09:00:00Z', tool_name: 'gmail', dest_host: 'gmail.googleapis.com', country_name: 'United States', pii_categories_detected: 'Email' },
    ],
};

/** What the Save bar sends: the loaded document, fields laid over it, echoes stripped. */
function expectedBody(changes: Record<string, unknown>) {
    const { updatedAt: _a, updatedBy: _b, clamped_fields: _c, clamped_tier: _d, ...base } = DOC;
    return {
        ...base,
        webSearchGuardEnabled: false,
        disableSearchOnUpload: false,
        privacy_scan_knowledge_bases: true,
        showRawPayload: false,
        dlpEnabled: false,
        dlpMode: 'ask',
        dlpAlwaysReview: false,
        customSensitiveTerms: [],
        ...changes,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockState.isOrgAdmin = true;
    mockState.licences = ['pii_tokenize', 'web_search_guard', 'advanced_usage_monitoring'];
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(ANSWERS[path] ?? null));
    (api.put as jest.Mock).mockImplementation((_path: string, body: Record<string, unknown>) =>
        Promise.resolve({ ok: true, config: body, termErrors: [] }),
    );
});

const renderScreen = () =>
    renderWithProviders(
        <ToastProvider>
            <ConfirmProvider>
                <OrgShieldScreen />
            </ConfirmProvider>
        </ToastProvider>,
    );

describe('OrgShieldScreen', () => {
    it('turns away someone who is not an org admin, without asking the server', async () => {
        mockState.isOrgAdmin = false;
        await renderScreen();
        expect(screen.getByText('Only organisation administrators can change the shield')).toBeTruthy();
        expect(api.get).not.toHaveBeenCalledWith('/api/org-privacy-shield/o1', expect.anything());
    });

    it('loads the document with its banners and saves the whole document with the switch on', async () => {
        await renderScreen();
        expect(await screen.findByText('Protect personal data')).toBeTruthy();
        expect(screen.getByText(/No PII detector is installed/)).toBeTruthy();
        expect(screen.getByText(/Your plan does not include: Protect web searches/)).toBeTruthy();
        expect(screen.queryByTestId('save-bar')).toBeNull();

        await fireEvent(screen.getByTestId('shield-enabled'), 'valueChange', true);
        expect(await screen.findByTestId('save-bar')).toBeTruthy();
        expect(screen.getByTestId('posture-guard')).toBeTruthy();
        await fireEvent.press(screen.getByText('Save'));

        await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
        expect(api.put).toHaveBeenCalledWith('/api/org-privacy-shield/o1', expectedBody({ enabled: true }));
        await waitFor(() => expect(screen.queryByTestId('save-bar')).toBeNull());
    });

    it('edits categories on the detection tab and discards back to the document', async () => {
        (api.get as jest.Mock).mockImplementation((path: string) =>
            Promise.resolve(path === '/api/org-privacy-shield/o1' ? { ...DOC, enabled: true } : (ANSWERS[path] ?? null)),
        );
        await renderScreen();
        await fireEvent.press(await screen.findByText('What we look for'));
        expect(screen.queryByTestId('detect-Email')).toBeNull();
        expect(screen.getByText('1 of 21')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('open-detect'));
        await fireEvent(screen.getByTestId('detect-Email'), 'valueChange', true);
        await fireEvent.press(screen.getAllByText('Close').at(-1)!);
        expect(screen.getByText('2 of 21')).toBeTruthy();
        await fireEvent.press(screen.getByTestId('sensitivity-high'));
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
        const body = (api.put as jest.Mock).mock.calls[0][1];
        expect(body.piiDetectionCategories).toEqual(['Person', 'Email']);
        expect(body.piiDetectionConfidenceThreshold).toBe(0.45);
        expect(body.dlpScope).toBe('all');

        await fireEvent.press(screen.getByTestId('open-detect'));
        await fireEvent.press(screen.getByTestId('detect-none'));
        await fireEvent.press(screen.getAllByText('Close').at(-1)!);
        expect(await screen.findByTestId('save-bar')).toBeTruthy();
        await fireEvent.press(screen.getByText('Discard'));
        await waitFor(() => expect(screen.queryByTestId('save-bar')).toBeNull());
    });

    it('shows the raw threshold only for Custom or a value that matches no level', async () => {
        (api.get as jest.Mock).mockImplementation((path: string) =>
            Promise.resolve(path === '/api/org-privacy-shield/o1' ? { ...DOC, enabled: true } : (ANSWERS[path] ?? null)),
        );
        await renderScreen();
        await fireEvent.press(await screen.findByText('What we look for'));
        expect(screen.queryByTestId('threshold')).toBeNull();
        await fireEvent.press(screen.getByTestId('sensitivity-custom'));
        expect(screen.getByTestId('threshold')).toBeTruthy();
        expect(screen.queryByTestId('save-bar')).toBeNull();
        await fireEvent.press(screen.getByTestId('sensitivity-balanced'));
        expect(screen.queryByTestId('threshold')).toBeNull();
    });

    it('shows the threshold for a stored value that matches no level', async () => {
        (api.get as jest.Mock).mockImplementation((path: string) =>
            Promise.resolve(path === '/api/org-privacy-shield/o1' ? { ...DOC, enabled: true, piiDetectionConfidenceThreshold: 0.6 } : (ANSWERS[path] ?? null)),
        );
        await renderScreen();
        await fireEvent.press(await screen.findByText('What we look for'));
        expect(screen.getByTestId('threshold')).toBeTruthy();
    });

    it('asks before saving the shield switched off, and saves nothing on cancel', async () => {
        (api.get as jest.Mock).mockImplementation((path: string) =>
            Promise.resolve(path === '/api/org-privacy-shield/o1' ? { ...DOC, enabled: true } : (ANSWERS[path] ?? null)),
        );
        await renderScreen();
        await fireEvent(await screen.findByTestId('shield-enabled'), 'valueChange', false);
        await fireEvent.press(screen.getByText('Save'));
        expect(await screen.findByText('Turn protection off for everyone?')).toBeTruthy();
        await fireEvent.press(screen.getByText('Cancel'));
        await waitFor(() => expect(screen.queryByText('Turn protection off for everyone?')).toBeNull());
        expect(api.put).not.toHaveBeenCalled();

        await fireEvent.press(screen.getByText('Save'));
        await fireEvent.press(await screen.findByText('Turn off and save'));
        await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
        expect((api.put as jest.Mock).mock.calls[0][1].enabled).toBe(false);
    });

    it('locks placeholders without pii_tokenize and web-search protection without web_search_guard', async () => {
        mockState.licences = ['advanced_usage_monitoring'];
        (api.get as jest.Mock).mockImplementation((path: string) =>
            Promise.resolve(path === '/api/org-privacy-shield/o1' ? { ...DOC, enabled: true } : (ANSWERS[path] ?? null)),
        );
        await renderScreen();
        await fireEvent.press(await screen.findByText('What happens'));
        await fireEvent.press(screen.getByTestId('action-tokenize'));
        expect(screen.queryByTestId('save-bar')).toBeNull();
        await fireEvent.press(screen.getByText('Leaving your org'));
        expect(screen.getByTestId('web-guard').props.accessibilityState?.disabled ?? true).toBeTruthy();
        expect(screen.getByTestId('eu-mode')).toBeTruthy();
    });

    it('adds an own term, an allow entry, a tool list and the outbound check in one save', async () => {
        (api.get as jest.Mock).mockImplementation((path: string) =>
            Promise.resolve(path === '/api/org-privacy-shield/o1' ? { ...DOC, enabled: true } : (ANSWERS[path] ?? null)),
        );
        await renderScreen();
        await fireEvent.press(await screen.findByText('What we look for'));

        await fireEvent.press(screen.getByTestId('open-terms'));
        await fireEvent.press(screen.getByTestId('term-add'));
        await fireEvent.changeText(screen.getByTestId('term-label'), 'Apollo');
        await fireEvent.changeText(screen.getByTestId('term-pattern'), 'PRJ-(');
        await fireEvent.press(screen.getByText('Pattern (advanced)'));
        expect(screen.getByTestId('term-apply').props.accessibilityState?.disabled).toBe(true);
        await fireEvent.changeText(screen.getByTestId('term-pattern'), 'PRJ-\\d+');
        await fireEvent.press(screen.getByTestId('term-apply'));
        expect(await screen.findByText('Apollo')).toBeTruthy();
        await fireEvent.press(screen.getAllByLabelText('Close').at(-1)!);

        await fireEvent.press(screen.getByTestId('open-allow'));
        await fireEvent.changeText(screen.getByTestId('allow-input'), 'PostNL');
        await fireEvent(screen.getByTestId('allow-input'), 'submitEditing');
        await fireEvent(screen.getByTestId('allow-public'), 'valueChange', false);
        await fireEvent.press(screen.getAllByText('Close').at(-1)!);

        await fireEvent.press(screen.getByTestId('tool-internal'));
        await fireEvent(screen.getByTestId('tool-internal-Person'), 'valueChange', true);
        await fireEvent.press(screen.getAllByText('Close').at(-1)!);

        await fireEvent.press(screen.getByText('Leaving your org'));
        await fireEvent(screen.getByTestId('dlp-enabled'), 'valueChange', true);
        await fireEvent.press(screen.getByTestId('dlp-block'));
        await fireEvent.press(screen.getByText('What happens'));
        await fireEvent.press(screen.getByTestId('action-tokenize'));
        await fireEvent(await screen.findByTestId('raw-payload'), 'valueChange', true);
        await fireEvent.press(screen.getByTestId('failure-fail_open'));

        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() => expect(api.put).toHaveBeenCalledTimes(1));
        const body = (api.put as jest.Mock).mock.calls[0][1];
        expect(body.customSensitiveTerms).toEqual([
            expect.objectContaining({ label: 'Apollo', pattern: 'PRJ-\\d+', type: 'regex', caseSensitive: false }),
        ]);
        expect(body.piiAllowTerms).toEqual(['PostNL']);
        expect(body.piiAllowPublicOrgs).toBe(false);
        expect(body.toolPiiPolicy).toEqual({ external: { blockCategories: [] }, internal: { blockCategories: ['Person'] } });
        expect(body).toMatchObject({ dlpEnabled: true, dlpMode: 'block', piiDetectionAction: 'tokenize', showRawPayload: true, piiFailureMode: 'fail_open' });
    });

    it('shows what happened when licensed, and a lock when not', async () => {
        await renderScreen();
        await fireEvent.press(await screen.findByText('What happened'));
        expect(await screen.findByText('United States')).toBeTruthy();
        expect(api.get).toHaveBeenCalledWith('/api/usage/guardrails/overview', expect.objectContaining({ query: { days: 30, interval: 'day' } }));
        expect(api.get).toHaveBeenCalledWith('/api/usage/guardrails/recent', expect.objectContaining({ query: { days: 30, interval: 'day', limit: 200 } }));
        expect(screen.getAllByText('Email Addresses').length).toBeGreaterThan(1);
        await fireEvent.press(screen.getByLabelText('Outbound calls, 1'));
        expect(await screen.findByText('gmail → gmail.googleapis.com')).toBeTruthy();
    });

    it('does not ask for the activity without the licence', async () => {
        mockState.licences = [];
        await renderScreen();
        await fireEvent.press(await screen.findByText('What happened'));
        expect(screen.getByText('Available on a higher plan')).toBeTruthy();
        expect(api.get).not.toHaveBeenCalledWith('/api/usage/guardrails/overview', expect.anything());
    });
});
