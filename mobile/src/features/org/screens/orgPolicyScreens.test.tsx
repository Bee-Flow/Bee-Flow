/**
 * The three policy sections — Encryption, Conversation memory, Answer reuse —
 * and Sign-in method, rendered against canned server answers: what they show,
 * the exact body each save sends, what a non-admin gets instead, and Back
 * with unsaved changes asking first.
 */

import { fireEvent, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import { api } from '@/core/api/client';
import { ConfirmProvider } from '@/shared/patterns';
import { renderWithProviders } from '@/shared/testing/renderWithProviders';
import { pressBack, type HeldLeave } from '@/shared/testing/screenMocks';
import { ToastProvider } from '@/shared/ui';

import { OrgAiContextScreen } from './OrgAiContextScreen';
import { OrgEncryptionScreen } from './OrgEncryptionScreen';
import { OrgIntegrationCacheScreen } from './OrgIntegrationCacheScreen';
import { OrgSignInScreen } from './OrgSignInScreen';
import { useOrgContext } from '../hooks/useOrgSections';

jest.setTimeout(30_000);

const mockLeave: HeldLeave = { listener: null, dispatch: jest.fn() };
jest.mock('expo-router', () => ({
    useRouter: () => ({ push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true }),
    useNavigation: jest.requireActual('@/shared/testing/screenMocks').leaveNavigation(() => mockLeave),
    Stack: { Screen: () => null },
}));
jest.mock('@/core/api/client', () => jest.requireActual('@/shared/testing/screenMocks').apiClient());
jest.mock('../hooks/useOrgSections', () => ({ useOrgContext: jest.fn() }));
const mockRefresh = jest.fn(async () => undefined);
jest.mock('@/core/auth/AuthProvider', () => ({ useAuth: () => ({ refresh: mockRefresh }) }));

const ADMIN = { orgId: 'o1', isOrgAdmin: true, isSelfHosted: true, isNcOrg: false };
let answers: Record<string, unknown> = {};

beforeEach(() => {
    jest.clearAllMocks();
    (useOrgContext as jest.Mock).mockReturnValue(ADMIN);
    (api.get as jest.Mock).mockImplementation((path: string) => Promise.resolve(answers[path] ?? null));
    (api.put as jest.Mock).mockImplementation((path: string) => Promise.resolve(answers[path] ?? { success: true }));
    (api.delete as jest.Mock).mockResolvedValue({ purged: 3 });
});

function render(ui: React.ReactElement) {
    return renderWithProviders(
        <ToastProvider>
            <ConfirmProvider>{ui}</ConfirmProvider>
        </ToastProvider>,
    );
}

describe('OrgEncryptionScreen', () => {
    beforeEach(() => {
        answers = {
            '/auth/organizations/o1/encryption': {
                tier: 'none',
                entitled: false,
                tierOptions: [
                    { tier: 'none', selectable: true },
                    { tier: 'managed', selectable: true },
                    { tier: 'zk', selectable: false, blockedBy: 'entitlement', reason: 'Not in your plan.' },
                ],
            },
        };
    });

    it('lists every tier, a locked one with its reason, and saves the new tier alone', async () => {
        await render(<OrgEncryptionScreen />);
        expect(await screen.findByText('Managed')).toBeTruthy();
        expect(screen.getByText(/Encryption is not included in your current plan/)).toBeTruthy();
        expect(screen.getByText(/Not in your plan\. Enterprise · Upgrade at beeflow\.nl/)).toBeTruthy();
        expect(screen.queryByTestId('save-bar')).toBeNull();

        await fireEvent.press(screen.getByTestId('choice-managed'));
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/auth/organizations/o1/encryption', { tier: 'managed' }),
        );
    });

    it('asks before zero-knowledge signs everyone out, and says so after', async () => {
        const options = (answers['/auth/organizations/o1/encryption'] as { tierOptions: object[] }).tierOptions;
        options[2] = { tier: 'zk', selectable: true, warningReason: 'OPAQUE is not configured.' };
        (api.put as jest.Mock).mockResolvedValue({ success: true, tier: 'zk', sessionsBusted: true });
        await render(<OrgEncryptionScreen />);
        await fireEvent.press(await screen.findByTestId('choice-zk'));
        expect(screen.getByText('OPAQUE is not configured.')).toBeTruthy();
        await fireEvent.press(screen.getByText('Save'));
        expect(api.put).not.toHaveBeenCalled();
        const [, confirmSave] = screen.getAllByLabelText('Save');
        await fireEvent.press(confirmSave as NonNullable<typeof confirmSave>);
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/organizations/o1/encryption', { tier: 'zk' }));
        expect(await screen.findByText(/Everyone in this organisation has been signed out/)).toBeTruthy();
    });

    it('asks before Back throws an unsaved tier away, and lets a clean screen go', async () => {
        await render(<OrgEncryptionScreen />);
        await screen.findByText('Managed');
        expect(mockLeave.listener).toBeNull();

        await fireEvent.press(screen.getByTestId('choice-managed'));
        const held = await pressBack(mockLeave);
        expect(held.preventDefault).toHaveBeenCalled();
        expect(await screen.findByText('Your changes here are not saved yet. Leave and lose them?')).toBeTruthy();
        await fireEvent.press(screen.getByText('Cancel'));
        expect(mockLeave.dispatch).not.toHaveBeenCalled();

        await fireEvent.press(screen.getByText('Discard'));
        expect(mockLeave.listener).toBeNull();
    });

    it('tells a member it is for administrators, and asks the server nothing', async () => {
        (useOrgContext as jest.Mock).mockReturnValue({ ...ADMIN, isOrgAdmin: false });
        await render(<OrgEncryptionScreen />);
        expect(screen.getByText('For organisation administrators')).toBeTruthy();
        expect(api.get).not.toHaveBeenCalled();
    });
});

describe('OrgAiContextScreen', () => {
    beforeEach(() => {
        answers = {
            '/api/org-ai-context/o1': {
                compactionEnabled: false,
                compactionThreshold: 20,
                recentWindow: 6,
                contextBudgetPercent: 75,
                contextWindowExamples: [{ label: 'Claude Sonnet 5', contextWindow: 1_000_000 }],
                contextBudgetRange: { min: 25, max: 95 },
            },
        };
    });

    it('saves the switch and the limit, sending the unseen tunables back as read', async () => {
        await render(<OrgAiContextScreen />);
        expect(await screen.findByText('Keep the full conversation (recommended)')).toBeTruthy();
        expect(screen.getByText('Claude Sonnet 5 → ~750,000 tokens')).toBeTruthy();

        await fireEvent.press(screen.getByTestId('choice-on'));
        await fireEvent.press(screen.getByLabelText('More'));
        expect(screen.getByText('80%')).toBeTruthy();
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/api/org-ai-context/o1', {
                compactionEnabled: true,
                compactionThreshold: 20,
                recentWindow: 6,
                contextBudgetPercent: 80,
            }),
        );
    });
});

describe('OrgIntegrationCacheScreen', () => {
    beforeEach(() => {
        answers = {
            '/api/org-integration-cache/o1': {
                enabled: false,
                ttlSeconds: 300,
                scopes: { integration: true, http: false },
                killSwitch: true,
                ttlRange: { min: 60, max: 3600 },
                entries: 2,
                expiredEntries: 1,
                bytes: 2048,
            },
        };
    });

    it('turns reuse on with its scopes and lifetime, and saves the whole policy', async () => {
        await render(<OrgIntegrationCacheScreen />);
        expect(await screen.findByText(/switched off for the whole server/)).toBeTruthy();
        expect(screen.getByText(/Stored right now: 3 answer\(s\), 2 kB\. 1 of those/)).toBeTruthy();
        expect(screen.queryByTestId('cache-scope-http')).toBeNull();

        await fireEvent.press(screen.getByTestId('choice-on'));
        expect(screen.getByText('5 minutes')).toBeTruthy();
        await fireEvent(screen.getByTestId('cache-scope-http'), 'valueChange', true);
        await fireEvent.press(screen.getByLabelText('More'));
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/api/org-integration-cache/o1', {
                enabled: true,
                ttlSeconds: 360,
                scopes: { integration: true, http: true },
            }),
        );
    });

    it('asks before deleting the stored answers', async () => {
        await render(<OrgIntegrationCacheScreen />);
        await fireEvent.press(await screen.findByTestId('cache-purge'));
        expect(api.delete).not.toHaveBeenCalled();
        await fireEvent.press(screen.getByLabelText('Delete'));
        await waitFor(() => expect(api.delete).toHaveBeenCalledWith('/api/org-integration-cache/o1/entries'));
    });
});

describe('OrgSignInScreen', () => {
    beforeEach(() => {
        answers = { '/auth/organizations/o1': { id: 'o1', name: 'Acme', allowedDomains: ['acme.nl'] } };
    });

    it('chooses the method once, after a confirm', async () => {
        await render(<OrgSignInScreen />);
        await fireEvent.press(await screen.findByTestId('auth-google'));
        expect(screen.getAllByText(/Once saved, this cannot be changed/)).toHaveLength(2);
        await fireEvent.press(screen.getByLabelText('Save'));
        await waitFor(() => expect(api.put).toHaveBeenCalledWith('/auth/organizations/o1', { authMethod: 'google' }));
    });

    it('validates and lower-cases allowed domains, and saves only the list', async () => {
        await render(<OrgSignInScreen />);
        const field = await screen.findByTestId('allowed-domains');
        await fireEvent.changeText(field, 'not a domain');
        await fireEvent(field, 'submitEditing');
        expect(screen.getByText('Invalid domain format: "not a domain"')).toBeTruthy();
        await fireEvent.changeText(field, 'New.ORG');
        await fireEvent(field, 'submitEditing');
        expect(screen.getByText('new.org')).toBeTruthy();
        await fireEvent.press(screen.getByText('Save'));
        await waitFor(() =>
            expect(api.put).toHaveBeenCalledWith('/auth/organizations/o1', { allowedDomains: ['acme.nl', 'new.org'] }),
        );
        // Only a rename changes what the session carries of the organisation.
        expect(mockRefresh).not.toHaveBeenCalled();
    });

    it('shows a chosen method locked', async () => {
        answers = { '/auth/organizations/o1': { id: 'o1', name: 'Acme', authMethod: 'password' } };
        (useOrgContext as jest.Mock).mockReturnValue({ ...ADMIN, isSelfHosted: false });
        await render(<OrgSignInScreen />);
        expect(await screen.findByText(/Sign-in method is locked/)).toBeTruthy();
        expect(screen.queryByTestId('allowed-domains')).toBeNull();
    });

    it('sends a Nextcloud-provisioned organisation to Nextcloud', async () => {
        (useOrgContext as jest.Mock).mockReturnValue({ ...ADMIN, isNcOrg: true });
        await render(<OrgSignInScreen />);
        expect(screen.getByText('Provisioned through Nextcloud')).toBeTruthy();
        expect(api.get).not.toHaveBeenCalled();
    });
});
