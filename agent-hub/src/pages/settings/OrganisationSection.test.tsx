import { act, cleanup, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OrgInfoSaveState } from '../../components/admin/org/orgInfo/useOrgInfoForm';

/**
 * Characterisation of OrganisationSection — the router between the
 * organisation sub-screens (the sections of Admin > Organisation, and the
 * licence page a phone keeps in Settings) — and of OrgIntegrationSettings
 * (Integration status). The Google Maps key left that page for Platform
 * services; its pins are in IntegrationsAdminPanel/GoogleMapsRow.test.tsx.
 *
 * This component decides two things and delegates everything else: WHICH panel
 * a given `activeSection` shows, and WHETHER the caller's permissions allow it.
 * So the pins below are almost entirely about visibility: which sections are
 * gated behind org-admin, which are not gated at all, and what counts as
 * org-admin.
 *
 * Every child panel is stubbed — they have (or will get) their own files, and
 * two of them (N8nSection, IntegrationsSection) are far too heavy to mount for
 * a routing test. The stubs record the props they were handed.
 *
 * No i18n mock: the global setup awaits ensureI18nDefaults(), so the real
 * hook's provider-less fallback resolves against the full EN catalogue.
 *
 * Nothing here judges the behaviour. Where today's behaviour is a wart the
 * test NAME says so.
 */

/** What OrgInfoPanel reports to the save bar; a test may send a broken report (no handleSave). */
type StateReport = (state: Omit<Partial<OrgInfoSaveState>, 'handleSave' | 'message'> & { handleSave: unknown; message: unknown }) => void;

const H = vi.hoisted(() => ({
    onStateChange: null as ((state: Record<string, unknown>) => void) | null,
    /** Stub factory: a div with a testid, plus the props worth asserting on. */
    stub: (testid: string, propKeys: string[] = []) => async () => {
        const React = await import('react');
        return {
            default: (props: Record<string, unknown>) => React.createElement('div', {
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
        default: (props: { onStateChange: (state: Record<string, unknown>) => void; activeSection?: string; user?: { id?: string } | null }) => {
            H.onStateChange = props.onStateChange;
            return React.createElement('div', {
                'data-testid': 'org-info-panel',
                'data-active-section': props.activeSection,
                'data-user': props.user?.id ?? '',
            });
        },
    };
});
vi.mock('./OrgAcademyPanel', H.stub('org-academy-panel'));
vi.mock('./N8nSection', H.stub('n8n-section'));
vi.mock('../../components/integrations/github/GitHubSyncPanel', H.stub('github-sync-panel'));
vi.mock('../../components/mcpLibrary/McpLibraryPage', H.stub('mcp-library-page', ['view']));
// The Nextcloud and Meeting notes pages decide their own cards (OrgNextcloudSection.test.tsx, OrgMeetingNotesSection.test.tsx).
vi.mock('./OrgNextcloudSection', H.stub('org-nextcloud-section', ['orgId', 'homeOrg']));
vi.mock('./OrgMeetingNotesSection', H.stub('org-meeting-notes-section', ['orgId', 'homeOrg', 'inDashboard']));
vi.mock('../../components/integrations/nextcloud/OrgNcIntegrationsPanel', H.stub('org-nc-integrations-panel'));

import type { ComponentProps } from 'react';
import { renderWithClient as render } from '@/test/render';
import { asMock } from '@/test/mocks';
import { availabilityAnswer, availabilityOrgOf } from '@/test/organisationHubKit';
import type { IntegrationFamily } from '@/api/queries/orgIntegrationAvailability';
import OrganisationSection from './OrganisationSection';
import OrgIntegrationSettings from './OrgIntegrationSettings';
import { SECTIONS as INFO_SECTIONS } from '../../components/admin/org/OrgInfoPanel';
import { authFetch } from '../../utils/helpers';

// The sections read through react-query: one client per render, kept across rerender().

const jsonRes = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
});

type TestUser = NonNullable<ComponentProps<typeof OrganisationSection>['user']>;
const USER = (over: Partial<TestUser> & Record<string, unknown> = {}): TestUser => ({ id: 'u1', permissions: [], ...over }) as TestUser;
const ORG_ADMIN = USER({ permissions: ['org_admin'] });
const NOBODY = USER({ permissions: [] });

const mount = (props: Partial<ComponentProps<typeof OrganisationSection>> = {}) => render(<OrganisationSection user={NOBODY} {...props} />);

/** Push a new org-save-bar state through OrgInfoPanel's onStateChange prop. */
const emit: StateReport = (state) => act(() => { H.onStateChange?.(state); });

const saveButton = () => screen.queryByRole('button', { name: /Save changes|Saving/ });
/** The Save button of the bar, which a test has just made appear. */
const theSaveButton = () => screen.getByRole('button', { name: /Save changes|Saving/ });

beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    H.onStateChange = null;
    asMock(authFetch).mockResolvedValue(jsonRes({}));
});

describe('OrganisationSection — which section renders what', () => {
    it('shows OrgInfoPanel for every id in the shared SECTIONS list, and passes the id straight through', () => {
        expect(INFO_SECTIONS.map(s => s.id)).toEqual([
            'license', 'auth', 'privacy', 'encryption', 'ai_context', 'integration_cache', 'cowork', 'info',
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
        ['github_sync', 'github-sync-panel'],
        ['nextcloud_sync', 'org-nextcloud-section'],
        ['meeting_templates', 'org-meeting-notes-section'],
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

    it.each(gated)('hides %s from a holder of another admin_* permission: the page and the rail read one standing', (activeSection, testid) => {
        mount({ user: USER({ permissions: ['admin_readonly', 'admin_monitoring'] }), activeSection });
        expect(screen.queryByTestId(testid)).toBeNull();
    });

    it.each(gated)('shows %s to an organisation-admin role', (activeSection, testid) => {
        mount({ user: USER({ orgRole: 'org_admin' }), activeSection });
        expect(screen.getByTestId(testid)).toBeInTheDocument();
    });

    it.each(gated)('shows %s to the platform admin', (activeSection, testid) => {
        mount({ user: USER({ isAdmin: true }), activeSection });
        expect(screen.getByTestId(testid)).toBeInTheDocument();
    });

    it('does not treat a permission that merely CONTAINS admin_ as admin (the check is startsWith)', () => {
        mount({ user: USER({ permissions: ['org_admin_lite', 'read_admin_logs'] }), activeSection: 'academy' });
        expect(screen.queryByTestId('org-academy-panel')).toBeNull();
    });

    it('survives a user with no permissions field at all, and grants nothing', () => {
        mount({ user: { id: 'u1' } as TestUser, activeSection: 'academy' });
        expect(screen.queryByTestId('org-academy-panel')).toBeNull();
    });

    it('survives user === undefined and grants nothing', () => {
        const { container } = render(<OrganisationSection user={undefined} activeSection="academy" />);
        expect(container.firstChild).toBeEmptyDOMElement();
    });

    it('shows every org-info section (licence, sign-in method, privacy, encryption…) to a member with NO permissions (securityFinding)', () => {
        for (const { id } of INFO_SECTIONS) {
            cleanup();
            mount({ user: NOBODY, activeSection: id });
            expect(screen.getByTestId('org-info-panel')).toBeInTheDocument();
        }
    });
});

describe('OrganisationSection — the org save bar', () => {
    const mountInfo = (activeSection = 'license') => mount({ user: ORG_ADMIN, activeSection });

    it('stays hidden until OrgInfoPanel reports something', () => {
        mountInfo();
        expect(saveButton()).toBeNull();
        expect(screen.queryByText('Unsaved changes')).toBeNull();
    });

    it('appears with a warning-coloured "Unsaved changes" marker and an enabled Save button', () => {
        mountInfo();
        emit({ hasChanges: true, saving: false, message: null, handleSave: vi.fn() });
        expect(screen.getByText('Unsaved changes')).toHaveClass('text-[var(--warning-ink)]');
        expect(theSaveButton()).toBeEnabled();
        expect(theSaveButton()).toHaveTextContent('Save changes');
    });

    it('calls the handleSave the panel supplied', async () => {
        const user = userEvent.setup();
        const handleSave = vi.fn();
        mountInfo();
        emit({ hasChanges: true, saving: false, message: null, handleSave });
        await user.click(theSaveButton());
        expect(handleSave).toHaveBeenCalledTimes(1);
    });

    it('does not blow up when the panel reported changes but no handleSave', async () => {
        const user = userEvent.setup();
        // React reports an uncaught handler error through reportError(), which
        // jsdom turns into a window 'error' event — asserting on the click
        // returning normally would NOT catch a missing `?.` guard.
        const onError = vi.fn();
        window.addEventListener('error', onError);
        try {
            mountInfo();
            emit({ hasChanges: true, saving: false, message: null, handleSave: null });
            await user.click(theSaveButton());
        } finally {
            window.removeEventListener('error', onError);
        }
        expect(onError).not.toHaveBeenCalled();
        expect(theSaveButton()).toBeEnabled();
    });

    it('switches to "Saving…" and disables the button while saving', () => {
        mountInfo();
        emit({ hasChanges: true, saving: true, message: null, handleSave: vi.fn() });
        expect(theSaveButton()).toHaveTextContent('Saving…');
        expect(theSaveButton()).toBeDisabled();
    });

    it('shows a success message with a check mark in the success ink of the theme', () => {
        mountInfo();
        emit({ hasChanges: false, saving: false, message: { type: 'success', text: 'Saved' }, handleSave: null });
        const msg = screen.getByText(/Saved/);
        expect(msg).toHaveTextContent('✓ Saved');
        expect(msg).toHaveClass('text-[var(--success-ink)]');
    });

    it('shows an error message with a warning sign in the error ink of the theme', () => {
        mountInfo();
        emit({ hasChanges: false, saving: false, message: { type: 'error', text: 'Nope' }, handleSave: null });
        const msg = screen.getByText(/Nope/);
        expect(msg).toHaveTextContent('⚠ Nope');
        expect(msg).toHaveClass('text-[var(--error-ink)]');
    });

    it('hides the "Unsaved changes" marker while a message is showing, even with changes pending (wart)', () => {
        mountInfo();
        emit({ hasChanges: true, saving: false, message: { type: 'success', text: 'Saved' }, handleSave: vi.fn() });
        expect(screen.queryByText('Unsaved changes')).toBeNull();
        expect(screen.getByText(/Saved/)).toBeInTheDocument();
        expect(theSaveButton()).toBeEnabled();
    });

    it('leaves the bar visible with a DISABLED button when only a message remains', () => {
        mountInfo();
        emit({ hasChanges: false, saving: false, message: { type: 'success', text: 'Saved' }, handleSave: vi.fn() });
        expect(theSaveButton()).toBeDisabled();
    });

    it('NEVER renders the generic bar on the privacy section — the Privacy Shield owns its own', () => {
        mountInfo('privacy');
        emit({ hasChanges: true, saving: false, message: null, handleSave: vi.fn() });
        expect(saveButton()).toBeNull();
        expect(screen.queryByText('Unsaved changes')).toBeNull();
        expect(screen.getByTestId('org-info-panel')).toBeInTheDocument();
    });
});

describe('OrganisationSection — where the org save bar shows', () => {
    const mountInfo = (activeSection = 'license') => mount({ user: ORG_ADMIN, activeSection });

    it('sticks to the top of the scrolling page, so Save stays in reach on the long License and Info pages', () => {
        mountInfo();
        emit({ hasChanges: true, saving: false, message: null, handleSave: vi.fn() });
        expect(theSaveButton().parentElement).toHaveClass('sticky', 'top-0');
    });

    it.each(['license', 'auth', 'info'])('serves the org form on %s', (activeSection) => {
        mountInfo(activeSection);
        emit({ hasChanges: true, saving: false, message: null, handleSave: vi.fn() });
        expect(theSaveButton()).toBeEnabled();
    });

    // These editors save themselves. OrgInfoPanel stays mounted between info
    // sections, so an unsaved Org Info edit must not put its Save above them.
    it.each(['encryption', 'ai_context', 'integration_cache'])('NEVER renders the generic bar on %s — that editor has its own Save', (activeSection) => {
        mountInfo(activeSection);
        emit({ hasChanges: true, saving: false, message: { type: 'success', text: 'Saved' }, handleSave: vi.fn() });
        expect(saveButton()).toBeNull();
        expect(screen.queryByText('Unsaved changes')).toBeNull();
        expect(screen.queryByText(/Saved/)).toBeNull();
        expect(screen.getByTestId('org-info-panel')).toHaveAttribute('data-active-section', activeSection);
    });
});

describe('OrgIntegrationSettings — Integration status (Admin > Connections)', () => {
    /** The chosen organisation's availability, with `off` families closed; every other read answers empty. */
    const serveAvailability = (off: IntegrationFamily[] = []) => {
        asMock(authFetch).mockImplementation(async (url: string) => {
            const org = availabilityOrgOf(url);
            return jsonRes(org ? availabilityAnswer({ orgId: org, homeOrg: org === 'org-a', off }) : {});
        });
    };
    const renderSettings = (over: Record<string, unknown> = {}) => render(<OrgIntegrationSettings user={USER({ permissions: ['org_admin'], organizationId: 'org-a', ...over })} />);

    it('draws the status of every integration family, then the n8n configuration; the Maps key is no longer here', async () => {
        serveAvailability();
        renderSettings();
        expect(await screen.findByTestId('n8n-section')).toBeInTheDocument();
        expect(screen.getByTestId('integration-status-n8n')).toBeInTheDocument();
        expect(screen.queryByLabelText('Google Maps API key')).toBeNull();
    });

    it('follows the organisation\'s availability, not the viewer\'s own enabledIntegrations list', async () => {
        serveAvailability();
        renderSettings({ enabledIntegrations: [] });
        expect(await screen.findByTestId('n8n-section')).toBeInTheDocument();
        cleanup();
        serveAvailability(['n8n']);
        renderSettings({ enabledIntegrations: ['n8n'] });
        expect(await screen.findByTestId('integration-status-n8n')).toHaveAttribute('data-state', 'not_in_plan');
        expect(screen.queryByTestId('n8n-section')).toBeNull();
    });

    it('adds the Nextcloud configuration only where the organisation has Nextcloud', async () => {
        serveAvailability();
        renderSettings();
        expect(await screen.findByTestId('org-nc-integrations-panel')).toBeInTheDocument();
        cleanup();
        serveAvailability(['nextcloud']);
        renderSettings();
        await screen.findByTestId('n8n-section');
        expect(screen.queryByTestId('org-nc-integrations-panel')).toBeNull();
    });
});

describe('OrganisationSection — the page heading outside the admin dashboard', () => {
    it.each([
        ['info', 'Organisation info'],
        ['license', 'Licence & usage'],
        ['auth', 'Preferred sign-in method'],
        ['encryption', 'Encryption'],
        ['ai_context', 'Conversations'],
        ['academy', 'Learning Center'],
        ['mcp_access', 'MCP client access'],
        ['github_sync', 'GitHub sync'],
        ['nextcloud_sync', 'Nextcloud'],
        ['meeting_templates', 'Meeting notes'],
    ])('names the %s page on a phone (no organisation named), as the dashboard row does', (activeSection, title) => {
        mount({ user: ORG_ADMIN, activeSection });
        expect(screen.getByRole('heading', { level: 2, name: title })).toBeInTheDocument();
    });

    it('leaves the heading to the dashboard frame when an organisation is named', () => {
        mount({ user: ORG_ADMIN, activeSection: 'github_sync', orgId: 'org-a' });
        expect(screen.getByTestId('github-sync-panel')).toBeInTheDocument();
        expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    });

    it('leaves the MCP library to name itself: outside the dashboard it draws its own title', () => {
        mount({ user: ORG_ADMIN, activeSection: 'mcp' });
        expect(screen.getByTestId('mcp-library-page')).toHaveAttribute('data-view', '');
        expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    });

    it('leaves the Privacy Shield to name itself: its editor draws its own title row', () => {
        mount({ user: ORG_ADMIN, activeSection: 'privacy' });
        expect(screen.getByTestId('org-info-panel')).toHaveAttribute('data-active-section', 'privacy');
        expect(screen.queryByRole('heading', { level: 2 })).toBeNull();
    });

    it('draws no heading over a page the viewer may not open', () => {
        const { container } = mount({ user: NOBODY, activeSection: 'github_sync' });
        expect(container.firstChild).toBeEmptyDOMElement();
    });
});

describe('OrganisationSection — the Nextcloud and Meeting notes pages', () => {
    it('hands the Nextcloud page the chosen organisation and whether it is the viewer\'s own', () => {
        mount({ user: ORG_ADMIN, activeSection: 'nextcloud_sync', orgId: 'org-b', homeOrg: false });
        const page = screen.getByTestId('org-nextcloud-section');
        expect(page).toHaveAttribute('data-orgId', 'org-b');
        expect(page).toHaveAttribute('data-homeOrg', 'false');
    });

    it('tells the Meeting notes page it is in the admin dashboard when an organisation is named', () => {
        mount({ user: ORG_ADMIN, activeSection: 'meeting_templates', orgId: 'org-a' });
        const page = screen.getByTestId('org-meeting-notes-section');
        expect(page).toHaveAttribute('data-orgId', 'org-a');
        expect(page).toHaveAttribute('data-homeOrg', 'true');
        expect(page).toHaveAttribute('data-inDashboard', 'true');
    });

    it('draws the Meeting notes page as Settings on a phone does when no organisation is named', () => {
        mount({ user: ORG_ADMIN, activeSection: 'meeting_templates' });
        expect(screen.getByTestId('org-meeting-notes-section')).toHaveAttribute('data-inDashboard', 'false');
    });
});
