import { screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import GoogleMeetNotesSection from './GoogleMeetNotesSection';
import { renderWithClient as render } from '../../test/render';
import { authFetch } from '../../utils/helpers';
import { asMock } from '@/test/mocks';
import userEvent from '@testing-library/user-event';
import { openGoogleOAuthPopup } from '../../lib/googleOAuthPopup';

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));
vi.mock('../../lib/googleOAuthPopup', () => ({ openGoogleOAuthPopup: vi.fn() }));
// A second dictionary for the tests that check a message goes through t() at all.
const { transOverride } = vi.hoisted(() => ({ transOverride: { current: null as Record<string, string> | null } }));
vi.mock('../../hooks/useTranslation', async (importOriginal) =>
    (await import('@/test/translationOverride')).overrideTranslation(await importOriginal(), transOverride));

const jsonRes = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});

const SETTINGS = {
    autoImport: true, autoRecordConfig: false, importScope: 'organizer', language: 'nl',
    connection: { googleConnected: true, meetScopesGranted: true, needsReauth: false },
};

describe('GoogleMeetNotesSection', () => {
    beforeEach(() => { vi.clearAllMocks(); transOverride.current = null; });

    it('renders nothing when the API returns non-OK (feature not licensed)', async () => {
        asMock(authFetch).mockResolvedValue(jsonRes({ error: 'forbidden' }, 403));
        const { container } = render(<GoogleMeetNotesSection />);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });

    it('renders nothing when Google is not connected', async () => {
        asMock(authFetch).mockResolvedValue(jsonRes({
            ...SETTINGS,
            connection: { googleConnected: false, meetScopesGranted: false, needsReauth: false },
        }));
        const { container } = render(<GoogleMeetNotesSection />);
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(container).toBeEmptyDOMElement();
    });

    it('renders the settings rows when connected with Meet scopes granted', async () => {
        asMock(authFetch).mockResolvedValue(jsonRes(SETTINGS));
        render(<GoogleMeetNotesSection />);
        await screen.findByText('Auto-import my recorded Meet meetings');
        expect(screen.getByText('Also pre-enable auto-recording for meetings I organize')).toBeInTheDocument();
        expect(screen.getByText('Which meetings')).toBeInTheDocument();
        expect(screen.getByText('Default language')).toBeInTheDocument();
        expect(screen.queryByText('Re-authorize Google')).not.toBeInTheDocument();
    });

    it('names each switch and list after its row title', async () => {
        asMock(authFetch).mockResolvedValue(jsonRes(SETTINGS));
        render(<GoogleMeetNotesSection />);
        await screen.findByText('Auto-import my recorded Meet meetings');
        expect(screen.getByRole('button', { name: 'Auto-import my recorded Meet meetings', pressed: true })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Also pre-enable auto-recording for meetings I organize', pressed: false })).toBeInTheDocument();
        expect(screen.getByRole('combobox', { name: 'Which meetings' })).toHaveValue('organizer');
        expect(screen.getByRole('combobox', { name: 'Default language' })).toHaveValue('nl');
    });

    it('shows the re-consent card instead of rows when Meet scopes are missing', async () => {
        asMock(authFetch).mockResolvedValue(jsonRes({
            ...SETTINGS,
            connection: { googleConnected: true, meetScopesGranted: false, needsReauth: false },
        }));
        render(<GoogleMeetNotesSection />);
        await screen.findByText('Re-authorize Google');
        expect(screen.getByText('Google Meet Meeting Notes')).toBeInTheDocument();
        expect(screen.queryByText('Auto-import my recorded Meet meetings')).not.toBeInTheDocument();
    });

    it('shows the expired notice and the re-authorize button when the stored connection needs reauth', async () => {
        asMock(authFetch).mockResolvedValue(jsonRes({
            ...SETTINGS,
            connection: { googleConnected: false, meetScopesGranted: true, needsReauth: true },
        }));
        render(<GoogleMeetNotesSection />);
        await screen.findByText('Re-authorize Google');
        expect(screen.getByText(/connection has expired/)).toBeInTheDocument();
        expect(screen.queryByText('Auto-import my recorded Meet meetings')).not.toBeInTheDocument();
    });

    it('shows the translated generic error when the auth-url request fails without a message', async () => {
        asMock(authFetch).mockResolvedValue(jsonRes({
            ...SETTINGS,
            connection: { googleConnected: true, meetScopesGranted: false, needsReauth: false },
        }));
        asMock(openGoogleOAuthPopup).mockRejectedValue(Object.assign(new Error(''), { code: 'auth_url_failed' }));
        transOverride.current = { 'settings.gmeet_notes.reauth_failed': 'Kon de Google-herautorisatie niet starten.' };
        const user = userEvent.setup();
        render(<GoogleMeetNotesSection />);
        await user.click(await screen.findByRole('button', { name: 'Re-authorize Google' }));
        expect(await screen.findByText('Kon de Google-herautorisatie niet starten.')).toBeInTheDocument();
    });

    it('shows the translated popup-blocked error rather than the helper\'s English message', async () => {
        asMock(authFetch).mockResolvedValue(jsonRes({
            ...SETTINGS,
            connection: { googleConnected: true, meetScopesGranted: false, needsReauth: false },
        }));
        asMock(openGoogleOAuthPopup).mockRejectedValue(Object.assign(new Error('raw helper text'), { code: 'popup_blocked' }));
        transOverride.current = { 'settings.gmeet_notes.popup_blocked': 'De pop-up is geblokkeerd.' };
        const user = userEvent.setup();
        render(<GoogleMeetNotesSection />);
        await user.click(await screen.findByRole('button', { name: 'Re-authorize Google' }));
        expect(await screen.findByText('De pop-up is geblokkeerd.')).toBeInTheDocument();
        expect(screen.queryByText('raw helper text')).not.toBeInTheDocument();
    });
});
