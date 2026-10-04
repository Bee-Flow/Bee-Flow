import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Characterisation of OrganisationSection — the router between the
 * organisation sub-screens (Settings → Organisation).
 *
 * This component decides two things and delegates everything else: WHICH panel
 * a given `activeSection` shows, and WHETHER the caller's permissions allow it.
 * So the pins below are almost entirely about visibility: which sections are
 * gated behind org-admin, which are not gated at all, and what counts as
 * org-admin.
 *
 * Every child panel is stubbed — they have (or will get) their own files, and
 * two of them (N8nSection, IntegrationsSection) are far too heavy to mount for
 * a routing test. The stubs record the props they were handed. Tabs is REAL:
 * the integrations sub-tab is part of this component's own behaviour.
 *
 * No i18n mock: the global setup awaits ensureI18nDefaults(), so the real
 * hook's provider-less fallback resolves against the full EN catalogue.
 *
 * Nothing here judges the behaviour. Where today's behaviour is a wart the
 * test NAME says so.
 */

const H = vi.hoisted(() => ({
    onStateChange: null,
    matrixProps: null,
    /** Stub factory: a div with a testid, plus the props worth asserting on. */
    stub: (testid, propKeys = []) => async () => {
        const React = await import('react');
        return {
            default: (props) => React.createElement('div', {
                'data-testid': testid,
                ...Object.fromEntries(propKeys.map(k => [`data-${k}`, String(props[k] ?? '')])),
            }),
        };
    },
}));

vi.mock('../../utils/helpers', () => ({ API_BASE: '', authFetch: vi.fn() }));

vi.mock('../../components/admin/org/OrgInfoPanel', async () => {
    const React = await import('react');
    // The REAL section list — this component's `isInfoSection` test reads it,
    // so a hand-written copy here would stop tracking the source.
    const { SECTIONS } = await import('../../components/admin/org/orgInfo/orgInfoShared');
    return {
        SECTIONS,
        default: (props) => {
            H.onStateChange = props.onStateChange;
            return React.createElement('div', {
                'data-testid': 'org-info-panel',
                'data-active-section': props.activeSection,
                'data-user': props.user?.id ?? '',
            });
        },
    };
});
vi.mock('../../components/admin/org/OrgUsersPanel', H.stub('org-users-panel'));
vi.mock('./OrgAcademyPanel', H.stub('org-academy-panel'));
vi.mock('./N8nSection', H.stub('n8n-section'));
vi.mock('./UsageSection', H.stub('usage-section', ['initialReport']));
vi.mock('../../components/integrations/github/GitHubSyncPanel', H.stub('github-sync-panel'));
vi.mock('../../components/integrations/nextcloud/NextcloudSyncPanel', H.stub('nextcloud-sync-panel'));
vi.mock('../../components/meetings/MeetingNotesAdminPanel', H.stub('meeting-notes-admin-panel'));
vi.mock('../../components/meetings/GoogleMeetAdminPanel', H.stub('google-meet-admin-panel'));
vi.mock('../../components/meetings/TeamsAdminPanel', H.stub('teams-admin-panel'));
vi.mock('../../components/meetings/SummaryTemplatesAdminPanel', H.stub('summary-templates-admin-panel'));
vi.mock('../../components/integrations/nextcloud/OrgNcIntegrationsPanel', H.stub('org-nc-integrations-panel'));
vi.mock('../../components/integrations/nextcloud/OrgNcPairingPanel', H.stub('org-nc-pairing-panel'));
vi.mock('../../components/admin/org/GroupAccessMatrix', async () => {
    const React = await import('react');
    return {
        default: (props) => {
            H.matrixProps = props;
            return React.createElement('div', { 'data-testid': 'group-access-matrix' });
        },
    };
});

import OrganisationSection from './OrganisationSection';
import { SECTIONS as INFO_SECTIONS } from '../../components/admin/org/OrgInfoPanel';
import { authFetch } from '../../utils/helpers';

const jsonRes = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});

const USER = (over = {}) => ({ id: 'u1', permissions: [], ...over });
const ORG_ADMIN = USER({ permissions: ['org_admin'] });
const NOBODY = USER({ permissions: [] });

const mount = (props = {}) => render(<OrganisationSection user={NOBODY} {...props} />);

/** Push a new org-save-bar state through OrgInfoPanel's onStateChange prop. */
const emit = (state) => act(() => { H.onStateChange(state); });

const saveButton = () => screen.queryByRole('button', { name: /Save changes|Saving/ });

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    H.onStateChange = null;
    H.matrixProps = null;
    authFetch.mockResolvedValue(jsonRes({ hasGoogleMapsKey: false }));
});

describe('OrganisationSection — which section renders what', () => {
    it('shows OrgInfoPanel for every id in the shared SECTIONS list, and passes the id straight through', () => {
        expect(INFO_SECTIONS.map(s => s.id)).toEqual([
            'license', 'auth', 'privacy', 'encryption', 'ai_context', 'integration_cache', 'info',
        ]);
        for (const { id } of INFO_SECTIONS) {
            cleanup();
            mount({ activeSection: id });
            expect(screen.getByTestId('org-info-panel')).toHaveAttribute('data-active-section', id);
        }
    });

    it('defaults to the license section when no activeSection is given', () => {
        mount();
        expect(screen.getByTestId('org-info-panel')).toHaveAttribute('data-active-section', 'license');
    });

    it('renders an empty shell for an unknown section', () => {
        const { container } = mount({ activeSection: 'azure' });
        expect(container.firstChild).toBeEmptyDOMElement();
    });

    it('hands the user object down to OrgInfoPanel', () => {
        mount({ user: USER({ id: 'u-77' }), activeSection: 'info' });
        expect(screen.getByTestId('org-info-panel')).toHaveAttribute('data-user', 'u-77');
    });
});

describe('OrganisationSection — permission gating', () => {
    const gated = [
        ['academy', 'org-academy-panel'],
        ['integrations', 'group-access-matrix'],
        ['github_sync', 'github-sync-panel'],
        ['nextcloud_sync', 'nextcloud-sync-panel'],
        ['meeting_templates', 'summary-templates-admin-panel'],
    ];

    it.each(gated)('hides %s from a member with no permissions', (activeSection, testid) => {
        const { container } = mount({ user: NOBODY, activeSection });
        expect(screen.queryByTestId(testid)).toBeNull();
        expect(container.firstChild).toBeEmptyDOMElement();
    });

    it.each(gated)('shows %s to an org_admin', (activeSection, testid) => {
        mount({ user: ORG_ADMIN, activeSection });
        expect(screen.getByTestId(testid)).toBeInTheDocument();
    });

    it.each(gated)('shows %s to a holder of the "all" permission', (activeSection, testid) => {
        mount({ user: USER({ permissions: ['all'] }), activeSection });
        expect(screen.getByTestId(testid)).toBeInTheDocument();
    });

    it.each(gated)('shows %s to ANY permission starting with admin_ (securityFinding: a read-only admin grant opens the org-admin surfaces)', (activeSection, testid) => {
        mount({ user: USER({ permissions: ['admin_readonly'] }), activeSection });
        expect(screen.getByTestId(testid)).toBeInTheDocument();
    });

    it('does not treat a permission that merely CONTAINS admin_ as admin (the check is startsWith)', () => {
        mount({ user: USER({ permissions: ['org_admin_lite', 'read_admin_logs'] }), activeSection: 'academy' });
        expect(screen.queryByTestId('org-academy-panel')).toBeNull();
    });

    it('survives a user with no permissions field at all, and grants nothing', () => {
        mount({ user: { id: 'u1' }, activeSection: 'academy' });
        expect(screen.queryByTestId('org-academy-panel')).toBeNull();
    });

    it('survives user === undefined and grants nothing', () => {
        const { container } = render(<OrganisationSection activeSection="integrations" />);
        expect(container.firstChild).toBeEmptyDOMElement();
    });

    it('shows Users & Groups to a member with NO permissions — this branch has no gate (securityFinding)', () => {
        mount({ user: NOBODY, activeSection: 'users' });
        expect(screen.getByTestId('org-users-panel')).toBeInTheDocument();
    });

    it('shows Usage & Monitoring to a member with NO permissions — this branch has no gate either (securityFinding)', () => {
        mount({ user: NOBODY, activeSection: 'usage' });
        expect(screen.getByTestId('usage-section')).toBeInTheDocument();
    });

    it('shows every org-info section (licence, sign-in method, privacy, encryption…) to a member with NO permissions (securityFinding)', () => {
        for (const { id } of INFO_SECTIONS) {
            cleanup();
            mount({ user: NOBODY, activeSection: id });
            expect(screen.getByTestId('org-info-panel')).toBeInTheDocument();
        }
    });

    it('forwards the deep-link report id to UsageSection', () => {
        mount({ user: NOBODY, activeSection: 'usage', usageInitialReport: 'terminations' });
        expect(screen.getByTestId('usage-section')).toHaveAttribute('data-initialReport', 'terminations');
    });
});

describe('OrganisationSection — the org save bar', () => {
    const mountInfo = (activeSection = 'license') => mount({ user: ORG_ADMIN, activeSection });

    it('stays hidden until OrgInfoPanel reports something', () => {
        mountInfo();
        expect(saveButton()).toBeNull();
        expect(screen.queryByText('Unsaved changes')).toBeNull();
    });

    it('appears with an amber "Unsaved changes" marker and an enabled Save button', () => {
        mountInfo();
        emit({ hasChanges: true, saving: false, message: null, handleSave: vi.fn() });
        expect(screen.getByText('Unsaved changes')).toHaveStyle({ color: 'rgb(217, 119, 6)' });
        expect(saveButton()).toBeEnabled();
        expect(saveButton()).toHaveTextContent('Save changes');
    });

    it('calls the handleSave the panel supplied', () => {
        const handleSave = vi.fn();
        mountInfo();
        emit({ hasChanges: true, saving: false, message: null, handleSave });
        fireEvent.click(saveButton());
        expect(handleSave).toHaveBeenCalledTimes(1);
    });

    it('does not blow up when the panel reported changes but no handleSave', () => {
        // React reports an uncaught handler error through reportError(), which
        // jsdom turns into a window 'error' event — asserting on the click
        // returning normally would NOT catch a missing `?.` guard.
        const onError = vi.fn();
        window.addEventListener('error', onError);
        try {
            mountInfo();
            emit({ hasChanges: true, saving: false, message: null, handleSave: null });
            fireEvent.click(saveButton());
        } finally {
            window.removeEventListener('error', onError);
        }
        expect(onError).not.toHaveBeenCalled();
        expect(saveButton()).toBeEnabled();
    });

    it('switches to "Saving…" and disables the button while saving', () => {
        mountInfo();
        emit({ hasChanges: true, saving: true, message: null, handleSave: vi.fn() });
        expect(saveButton()).toHaveTextContent('Saving…');
        expect(saveButton()).toBeDisabled();
    });

    it('shows a success message with a check mark in green', () => {
        mountInfo();
        emit({ hasChanges: false, saving: false, message: { type: 'success', text: 'Saved' }, handleSave: null });
        const msg = screen.getByText(/Saved/);
        expect(msg).toHaveTextContent('✓ Saved');
        expect(msg).toHaveClass('text-green-600');
    });

    it('shows any other message type with a warning sign in red', () => {
        mountInfo();
        emit({ hasChanges: false, saving: false, message: { type: 'error', text: 'Nope' }, handleSave: null });
        const msg = screen.getByText(/Nope/);
        expect(msg).toHaveTextContent('⚠ Nope');
        expect(msg).toHaveClass('text-red-500');
    });

    it('hides the "Unsaved changes" marker while a message is showing, even with changes pending (wart)', () => {
        mountInfo();
        emit({ hasChanges: true, saving: false, message: { type: 'success', text: 'Saved' }, handleSave: vi.fn() });
        expect(screen.queryByText('Unsaved changes')).toBeNull();
        expect(screen.getByText(/Saved/)).toBeInTheDocument();
        expect(saveButton()).toBeEnabled();
    });

    it('leaves the bar visible with a DISABLED button when only a message remains', () => {
        mountInfo();
        emit({ hasChanges: false, saving: false, message: { type: 'success', text: 'Saved' }, handleSave: vi.fn() });
        expect(saveButton()).toBeDisabled();
    });

    it('NEVER renders the generic bar on the privacy section — the Privacy Shield owns its own', () => {
        mountInfo('privacy');
        emit({ hasChanges: true, saving: false, message: null, handleSave: vi.fn() });
        expect(saveButton()).toBeNull();
        expect(screen.queryByText('Unsaved changes')).toBeNull();
        expect(screen.getByTestId('org-info-panel')).toBeInTheDocument();
    });
});

describe('OrganisationSection — the Integrations section', () => {
    const mountInt = (over = {}) => mount({ user: USER({ permissions: ['org_admin'], ...over }), activeSection: 'integrations' });

    it('leads with the heading, subtitle and two sub-tabs, "Integration access" selected', () => {
        mountInt();
        expect(screen.getByText('Organisation Integrations')).toBeInTheDocument();
        expect(screen.getByText('Shared across all members of your organisation.')).toBeInTheDocument();
        expect(screen.getByRole('tab', { name: 'Integration access' })).toHaveAttribute('aria-selected', 'true');
        expect(screen.getByRole('tab', { name: 'Integration settings' })).toHaveAttribute('aria-selected', 'false');
    });

    it('renders GroupAccessMatrix scoped to integrations, with locked entries hidden and hard-coded English copy (wart: not translated)', () => {
        mountInt();
        expect(screen.getByTestId('group-access-matrix')).toBeInTheDocument();
        expect(H.matrixProps.kinds).toEqual(['integration']);
        expect(H.matrixProps.hideLocked).toBe(true);
        expect(H.matrixProps.heading).toBe('Integration access');
        expect(H.matrixProps.subtitle).toContain('Give an integration to your whole organisation or to a specific group.');
    });

    it('swaps the matrix for the provider configuration on the settings tab', async () => {
        mountInt();
        fireEvent.click(screen.getByRole('tab', { name: 'Integration settings' }));
        await waitFor(() => expect(screen.queryByTestId('group-access-matrix')).toBeNull());
        expect(screen.getByText('Configure the integrations themselves — credentials, instance URLs and workflows.')).toBeInTheDocument();
        expect(screen.getByTestId('n8n-section')).toBeInTheDocument();
        expect(screen.getByText('Google Maps')).toBeInTheDocument();
    });

    const settingsTab = async (over) => {
        mountInt(over);
        fireEvent.click(screen.getByRole('tab', { name: 'Integration settings' }));
        await screen.findByText('Configure the integrations themselves — credentials, instance URLs and workflows.');
    };

    it('shows EVERY integration when enabledIntegrations is missing — absent means allowed (securityFinding)', async () => {
        await settingsTab({});
        expect(screen.getByTestId('n8n-section')).toBeInTheDocument();
        expect(screen.getByText('Google Maps')).toBeInTheDocument();
    });

    it('shows only the integrations named in enabledIntegrations', async () => {
        await settingsTab({ enabledIntegrations: ['n8n'] });
        expect(screen.getByTestId('n8n-section')).toBeInTheDocument();
        expect(screen.queryByText('Google Maps')).toBeNull();
    });

    it('shows the "no integrations" notice when the list is empty and the org is standalone', async () => {
        await settingsTab({ enabledIntegrations: [] });
        expect(screen.getByText('No integrations are enabled for this organisation. Contact your platform administrator.')).toBeInTheDocument();
        expect(screen.queryByTestId('n8n-section')).toBeNull();
    });

    it('adds the Nextcloud panel for an NC-bound org', async () => {
        await settingsTab({ ncOrg: { instanceId: 'nc-1' } });
        expect(screen.getByTestId('org-nc-integrations-panel')).toBeInTheDocument();
    });

    it('never shows the Nextcloud panel for a standalone org', async () => {
        await settingsTab({ ncOrg: {} });
        expect(screen.queryByTestId('org-nc-integrations-panel')).toBeNull();
    });

    it('swallows the "no integrations" notice for an NC org with an empty list, leaving an empty bordered box (wart)', async () => {
        await settingsTab({ enabledIntegrations: [], ncOrg: { instanceId: 'nc-1' } });
        expect(screen.queryByText('No integrations are enabled for this organisation. Contact your platform administrator.')).toBeNull();
        expect(screen.queryByTestId('n8n-section')).toBeNull();
        expect(screen.queryByText('Google Maps')).toBeNull();
        expect(screen.getByTestId('org-nc-integrations-panel')).toBeInTheDocument();
    });
});

describe('OrganisationSection — the Nextcloud Sync section', () => {
    const mountNc = (over = {}) => mount({ user: USER({ permissions: ['org_admin'], ...over }), activeSection: 'nextcloud_sync' });

    it('always stacks sync, meeting notes, Google Meet and Teams for an org_admin', () => {
        mountNc();
        ['nextcloud-sync-panel', 'meeting-notes-admin-panel', 'google-meet-admin-panel', 'teams-admin-panel']
            .forEach(id => expect(screen.getByTestId(id)).toBeInTheDocument());
    });

    it('withholds the pairing panel from an org_admin of a standalone org', () => {
        mountNc();
        expect(screen.queryByTestId('org-nc-pairing-panel')).toBeNull();
    });

    it('shows the pairing panel once the org is NC-bound', () => {
        mountNc({ ncOrg: { instanceId: 'nc-1' } });
        expect(screen.getByTestId('org-nc-pairing-panel')).toBeInTheDocument();
    });

    it('shows the pairing panel to a full admin even on a standalone org', () => {
        mount({ user: USER({ permissions: ['all'] }), activeSection: 'nextcloud_sync' });
        expect(screen.getByTestId('org-nc-pairing-panel')).toBeInTheDocument();
    });
});

describe('OrganisationSection — the Google Maps integration row', () => {
    const openMaps = async ({ hasGoogleMapsKey = false } = {}) => {
        authFetch.mockImplementation(async (_url, opts = {}) => (
            opts.method === 'POST' ? jsonRes({ ok: true }) : jsonRes({ hasGoogleMapsKey })
        ));
        const view = mount({ user: ORG_ADMIN, activeSection: 'integrations' });
        fireEvent.click(screen.getByRole('tab', { name: 'Integration settings' }));
        await screen.findByText('Google Maps');
        await waitFor(() => expect(authFetch).toHaveBeenCalledWith('/ai/config'));
        return view;
    };

    const mapsToggle = () => screen.getByText('Google Maps').closest('button');
    const keyInput = (container) => container.querySelector('input[type="password"]');
    const posts = () => authFetch.mock.calls.filter(c => c[1]?.method === 'POST');

    it('probes /ai/config on mount and stays "not configured" when no key is stored', async () => {
        await openMaps({ hasGoogleMapsKey: false });
        expect(screen.getByText('Directions, route maps & places search in chat')).toBeInTheDocument();
        expect(screen.queryByText('Connected')).toBeNull();
    });

    it('shows a Connected badge and the configured subtitle when a key is stored', async () => {
        await openMaps({ hasGoogleMapsKey: true });
        expect(await screen.findByText('Connected')).toBeInTheDocument();
        expect(screen.getByText('Maps, directions & places — configured')).toBeInTheDocument();
    });

    it('reads a failed /ai/config probe as "no key" (wart: an unreachable config looks unconfigured)', async () => {
        authFetch.mockRejectedValue(new Error('offline'));
        mount({ user: ORG_ADMIN, activeSection: 'integrations' });
        fireEvent.click(screen.getByRole('tab', { name: 'Integration settings' }));
        await screen.findByText('Google Maps');
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(screen.queryByText('Connected')).toBeNull();
        expect(screen.getByText('Directions, route maps & places search in chat')).toBeInTheDocument();
    });

    it('keeps the key editor collapsed until the row is clicked', async () => {
        const { container } = await openMaps();
        expect(keyInput(container)).toBeNull();
        fireEvent.click(mapsToggle());
        expect(keyInput(container)).not.toBeNull();
        fireEvent.click(mapsToggle());
        expect(keyInput(container)).toBeNull();
    });

    it('masks the placeholder once a key exists, and otherwise reuses the description', async () => {
        const { container } = await openMaps({ hasGoogleMapsKey: true });
        fireEvent.click(mapsToggle());
        expect(keyInput(container)).toHaveAttribute('placeholder', '••••••••••••••••');
        cleanup();
        const view = await openMaps({ hasGoogleMapsKey: false });
        fireEvent.click(mapsToggle());
        expect(keyInput(view.container)).toHaveAttribute('placeholder', 'Directions, route maps & places search in chat');
    });

    it('refuses to save an empty or whitespace-only key — the Enter path is guarded too', async () => {
        const { container } = await openMaps();
        fireEvent.click(mapsToggle());
        const save = screen.getByRole('button', { name: 'Save changes' });
        expect(save).toBeDisabled();
        fireEvent.change(keyInput(container), { target: { value: '   ' } });
        expect(save).toBeDisabled();
        // The button is unclickable, but Enter reaches save() directly.
        fireEvent.keyDown(keyInput(container), { key: 'Enter' });
        await waitFor(() => expect(authFetch).toHaveBeenCalled());
        expect(posts()).toHaveLength(0);
    });

    it('POSTs the raw key to /ai/config, then collapses the row and flips to Connected', async () => {
        const { container } = await openMaps();
        fireEvent.click(mapsToggle());
        fireEvent.change(keyInput(container), { target: { value: 'AIza-secret' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

        await waitFor(() => expect(posts()).toHaveLength(1));
        const [url, opts] = posts()[0];
        expect(url).toBe('/ai/config');
        expect(opts.headers).toEqual({ 'Content-Type': 'application/json' });
        expect(JSON.parse(opts.body)).toEqual({ googleMapsApiKey: 'AIza-secret' });

        expect(await screen.findByText('Connected')).toBeInTheDocument();
        await waitFor(() => expect(keyInput(container)).toBeNull());
    });

    it('saves on Enter as well as on the button', async () => {
        const { container } = await openMaps();
        fireEvent.click(mapsToggle());
        fireEvent.change(keyInput(container), { target: { value: 'k' } });
        fireEvent.keyDown(keyInput(container), { key: 'Enter' });
        await waitFor(() => expect(posts()).toHaveLength(1));
    });

    it('leaves the typed key on screen and shows NO error when the save is rejected (wart)', async () => {
        authFetch.mockImplementation(async (_url, opts = {}) => (
            opts.method === 'POST' ? jsonRes({ error: 'bad key' }, 400) : jsonRes({ hasGoogleMapsKey: false })
        ));
        const { container } = mount({ user: ORG_ADMIN, activeSection: 'integrations' });
        fireEvent.click(screen.getByRole('tab', { name: 'Integration settings' }));
        await screen.findByText('Google Maps');
        fireEvent.click(mapsToggle());
        fireEvent.change(keyInput(container), { target: { value: 'wrong' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));

        await waitFor(() => expect(posts()).toHaveLength(1));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
        expect(keyInput(container)).toHaveValue('wrong');
        expect(screen.queryByText('Connected')).toBeNull();
        expect(screen.queryByText(/invalid|failed|error/i)).toBeNull();
    });

    it('swallows a thrown save the same silent way', async () => {
        authFetch.mockImplementation(async (_url, opts = {}) => {
            if (opts.method === 'POST') throw new Error('offline');
            return jsonRes({ hasGoogleMapsKey: false });
        });
        const { container } = mount({ user: ORG_ADMIN, activeSection: 'integrations' });
        fireEvent.click(screen.getByRole('tab', { name: 'Integration settings' }));
        await screen.findByText('Google Maps');
        fireEvent.click(mapsToggle());
        fireEvent.change(keyInput(container), { target: { value: 'boom' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(screen.getByRole('button', { name: 'Save changes' })).toBeEnabled());
        expect(keyInput(container)).toHaveValue('boom');
        expect(screen.queryByText('Connected')).toBeNull();
    });

    it('links out to the Google Cloud API library with the three APIs to enable', async () => {
        await openMaps();
        fireEvent.click(mapsToggle());
        const link = screen.getByRole('link', { name: 'Google Cloud Console' });
        expect(link).toHaveAttribute('href', 'https://console.cloud.google.com/apis/library');
        expect(link).toHaveAttribute('rel', 'noopener noreferrer');
        ['Directions API', 'Places API', 'Maps Embed API'].forEach(api => {
            expect(screen.getByText(api)).toBeInTheDocument();
        });
    });
});
