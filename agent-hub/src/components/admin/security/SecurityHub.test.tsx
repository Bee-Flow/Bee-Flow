import { render, screen, cleanup, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Mock } from 'vitest';
import SecurityHub from './SecurityHub';
import { AdminScopeOverrideProvider } from '../dashboard/useAdminScopeOverride';
import type { AdminScope } from '../dashboard/adminTabs';
import { AdminOrgProvider, type AdminOrgChoice } from '../dashboard/useAdminOrg';

type SetScope = Mock<(scope: AdminScope | null) => void>;

const hasTier = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useTranslation', () => ({
    useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('../../licensing/LicenseContext', () => ({ useLicenseContext: () => ({ hasTier }) }));

// The panels are heavy and each fetches on mount. SecurityHub only gates
// sections and routes between them, so the panels are stubbed to keep this
// about that decision. The guardrails stub echoes its `section` prop, because
// threading the third path segment through is now part of SecurityHub's job.
vi.mock('./guardrails/GuardrailsHub', () => ({
    default: ({ section }: { section?: string }) => <div data-testid="guardrails-panel" data-section={section || ''} />,
}));
vi.mock('./guardrails/OrgGuardrails', () => ({
    default: ({ orgId, activityOrgId, allowOrgPicker }: { orgId: string | null; activityOrgId?: string | null; allowOrgPicker?: boolean }) => (
        <div data-testid="org-guardrails-panel" data-org={orgId || ''} data-activity-org={activityOrgId || ''} data-picker={String(!!allowOrgPicker)} />
    ),
}));
vi.mock('./SSOConfigPanel', () => ({ default: () => <div data-testid="sso-panel" /> }));
vi.mock('../org/UserManagement', () => ({ default: () => <div data-testid="user-management" /> }));
vi.mock('../../integrations/health/ConnectorHealthPanel', () => ({
    default: ({ initialOrgId }: { initialOrgId?: string }) => <div data-testid="connector-health-panel" data-org={initialOrgId || ''} />,
}));

const choiceOf = (orgId: string | null): AdminOrgChoice => ({
    isPlatformAdmin: true, orgId, orgName: null, organizations: [], organizationsLoaded: true, pending: false, homeOrganization: null, setOrgId: () => {},
});

const fullAdmin = { permissions: ['all'], isAdmin: true };
const orgAdmin = { permissions: ['admin_security'], isAdmin: false };

describe('SecurityHub', () => {
    beforeEach(() => {
        cleanup();
        hasTier.mockReset();
        hasTier.mockReturnValue(true); // enterprise unless a test says otherwise
    });

    it('shows all three sections to a full admin on enterprise', () => {
        render(<SecurityHub user={fullAdmin} />);
        expect(screen.getByText('admin.sec_users')).toBeInTheDocument();
        expect(screen.getByText('admin.sec_guardrails')).toBeInTheDocument();
        expect(screen.getByText('admin.sec_sso')).toBeInTheDocument();
    });

    it('keeps the organisation shield on a community install, without the server console', () => {
        hasTier.mockReturnValue(false);
        render(<SecurityHub user={fullAdmin} activeSection="guardrails" />);
        expect(screen.getByText('admin.sec_guardrails')).toBeInTheDocument();
        expect(screen.queryByTestId('guardrails-panel')).not.toBeInTheDocument();
        // No organisation chosen: the editor's own picker.
        expect(screen.getByTestId('org-guardrails-panel').getAttribute('data-picker')).toBe('true');
    });

    it('resolves the tier against the real licence, with no super-admin elevation', () => {
        hasTier.mockReturnValue(false);
        render(<SecurityHub user={fullAdmin} activeSection="guardrails" />);
        // A super-admin on community still does not get the enterprise server console:
        // LicenseContext.hasTier reads the REAL tier by documented invariant.
        expect(hasTier).toHaveBeenCalledWith('enterprise');
        expect(screen.queryByTestId('guardrails-panel')).not.toBeInTheDocument();
    });

    it('hides sso from a non-full admin', () => {
        render(<SecurityHub user={orgAdmin} />);
        expect(screen.queryByText('admin.sec_sso')).not.toBeInTheDocument();
        expect(screen.getByText('admin.sec_users')).toBeInTheDocument();
    });

    it('renders the section named by activeSection', () => {
        render(<SecurityHub user={fullAdmin} activeSection="guardrails" />);
        expect(screen.getByTestId('guardrails-panel')).toBeInTheDocument();
        expect(screen.queryByTestId('user-management')).not.toBeInTheDocument();
    });

    it('falls back to users when activeSection is not a section at all', () => {
        render(<SecurityHub user={fullAdmin} activeSection="does-not-exist" />);
        expect(screen.getByTestId('user-management')).toBeInTheDocument();
    });

    it('falls back to users when a non-full admin lands on sso', () => {
        render(<SecurityHub user={orgAdmin} activeSection="sso" />);
        expect(screen.getByTestId('user-management')).toBeInTheDocument();
        expect(screen.queryByTestId('sso-panel')).not.toBeInTheDocument();
    });

    it('shows an organisation admin their own shield on a community install', () => {
        hasTier.mockReturnValue(false);
        render(<SecurityHub user={{ ...orgAdmin, organizationId: 'org-1', isHomeOrgAdmin: true }} activeSection="guardrails" />);
        expect(screen.getByTestId('org-guardrails-panel').getAttribute('data-org')).toBe('org-1');
        expect(screen.getByTestId('org-guardrails-panel').getAttribute('data-activity-org')).toBe('');
    });

    it('gives a platform admin the dashboard organisation as the shield and the activity organisation', () => {
        hasTier.mockReturnValue(false);
        render(
            <AdminOrgProvider value={{ ...choiceOf('org-9') }}>
                <SecurityHub user={fullAdmin} activeSection="guardrails" />
            </AdminOrgProvider>,
        );
        const panel = screen.getByTestId('org-guardrails-panel');
        expect(panel.getAttribute('data-org')).toBe('org-9');
        expect(panel.getAttribute('data-activity-org')).toBe('org-9');
    });

    it('navigates to the section path when a rail button is clicked', async () => {
        const user = userEvent.setup();
        const onNavigate = vi.fn();
        render(<SecurityHub user={fullAdmin} onNavigate={onNavigate} />);
        await user.click(screen.getByText('admin.sec_sso'));
        expect(onNavigate).toHaveBeenCalledWith('admin/security/sso');
    });

    it('shows connector-health to a full admin only', () => {
        render(<SecurityHub user={fullAdmin} />);
        expect(screen.getByText('admin.sec_connector_health')).toBeInTheDocument();
    });

    it('hides connector-health from a non-full admin', () => {
        render(<SecurityHub user={orgAdmin} />);
        expect(screen.queryByText('admin.sec_connector_health')).not.toBeInTheDocument();
    });

    it('falls back to users when a non-full admin lands on connector-health', () => {
        render(<SecurityHub user={orgAdmin} activeSection="connector-health" />);
        expect(screen.getByTestId('user-management')).toBeInTheDocument();
        expect(screen.queryByTestId('connector-health-panel')).not.toBeInTheDocument();
    });

    it('renders the connector-health panel and threads the org drill-in segment', () => {
        render(<SecurityHub user={fullAdmin} activeSection="connector-health" userSection="org-123" />);
        const panel = screen.getByTestId('connector-health-panel');
        expect(panel).toBeInTheDocument();
        expect(panel.getAttribute('data-org')).toBe('org-123');
        expect(screen.queryByTestId('user-management')).not.toBeInTheDocument();
    });

    it('threads the third path segment into the guardrails console', () => {
        // This is what makes /app/admin/security/guardrails/<section> a real URL
        // without touching App.jsx's three-segment parser.
        render(<SecurityHub user={fullAdmin} activeSection="guardrails" userSection="patterns" />);
        expect(screen.getByTestId('guardrails-panel').getAttribute('data-section')).toBe('patterns');
    });

    it('renders the guardrails console with no segment when none is given', () => {
        render(<SecurityHub user={fullAdmin} activeSection="guardrails" />);
        expect(screen.getByTestId('guardrails-panel').getAttribute('data-section')).toBe('');
    });

    it('marks the section from the URL as the current page of a named navigation', () => {
        render(<SecurityHub user={fullAdmin} activeSection="sso" />);
        expect(screen.getByRole('navigation', { name: 'admin.tab_security' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'admin.sec_sso admin.scope_instance' })).toHaveAttribute('aria-current', 'page');
        expect(screen.getByRole('button', { name: 'admin.sec_users' })).not.toHaveAttribute('aria-current');
    });

    it('lists the server-wide sections last, under a "Whole server" divider, each with the server icon', () => {
        render(<SecurityHub user={fullAdmin} />);
        const nav = screen.getByRole('navigation', { name: 'admin.tab_security' });
        const items = within(nav).getAllByRole('button');
        expect(items.map(b => b.textContent?.trim())).toEqual(['admin.sec_users', 'admin.sec_guardrails', 'admin.sec_sso', 'admin.sec_email_domains', 'admin.sec_connector_health']);
        for (const name of ['admin.sec_sso', 'admin.sec_email_domains', 'admin.sec_connector_health']) {
            const row = items.find(b => b.textContent?.trim() === name) as HTMLElement;
            expect(within(row).getByRole('img', { name: 'admin.scope_instance' })).toBeInTheDocument();
        }
        for (const name of ['admin.sec_users', 'admin.sec_guardrails']) {
            const row = items.find(b => b.textContent?.trim() === name) as HTMLElement;
            expect(within(row).queryByRole('img')).not.toBeInTheDocument();
        }
        // The divider label sits once, before the first server-wide section.
        expect(within(nav).getAllByText('admin.scope_instance', { selector: 'div' })).toHaveLength(1);
    });

    describe('scope reported to the dashboard', () => {
        const lastScope = (set: SetScope) => set.mock.calls.filter(c => c[0] !== null).at(-1)?.[0];
        const renderIn = (set: SetScope, props: React.ComponentProps<typeof SecurityHub>) => render(
            <AdminScopeOverrideProvider value={set}><SecurityHub {...props} /></AdminScopeOverrideProvider>,
        );

        it('guardrails leave the scope to the console, which knows the open sub-section', () => {
            const set: SetScope = vi.fn<(scope: AdminScope | null) => void>();
            renderIn(set, { user: fullAdmin, activeSection: 'guardrails' });
            expect(lastScope(set)).toBeUndefined();
        });

        // The Users screen knows its open tab (some are server-wide), so it reports the scope itself.
        it('users, also as the fallback for a section the viewer cannot see, leave the scope to the Users screen', () => {
            const set: SetScope = vi.fn<(scope: AdminScope | null) => void>();
            renderIn(set, { user: orgAdmin, activeSection: 'sso' });
            expect(screen.getByTestId('user-management')).toBeInTheDocument();
            expect(lastScope(set)).toBeUndefined();
        });

        it('a server-wide section reports the whole server', () => {
            const set: SetScope = vi.fn<(scope: AdminScope | null) => void>();
            renderIn(set, { user: fullAdmin, activeSection: 'sso' });
            expect(lastScope(set)).toBe('instance');
        });
    });

    describe('for an organisation admin', () => {
        const orgAdminOfOrg = { ...orgAdmin, orgRole: 'org_admin', organizationId: 'org-1', isHomeOrgAdmin: true };

        it('lists only the sections that are not about the whole server', () => {
            render(<SecurityHub user={orgAdminOfOrg} />);
            const items = screen.getAllByRole('button').map(b => b.textContent);
            expect(items).toEqual(['admin.sec_users', 'admin.sec_guardrails']);
        });

        it('shows the guardrails of the own organisation instead of the server console', () => {
            render(<SecurityHub user={orgAdminOfOrg} activeSection="guardrails" userSection="patterns" />);
            expect(screen.getByTestId('org-guardrails-panel').getAttribute('data-org')).toBe('org-1');
            expect(screen.queryByTestId('guardrails-panel')).not.toBeInTheDocument();
        });

        it('drops guardrails for an organisation admin without a home organisation', () => {
            render(<SecurityHub user={{ permissions: ['admin_security'], isAdmin: false }} activeSection="guardrails" />);
            expect(screen.queryByText('admin.sec_guardrails')).not.toBeInTheDocument();
            expect(screen.getByTestId('user-management')).toBeInTheDocument();
        });

        // admin_security through a plain group: the shield save needs an organisation admin of the home organisation.
        it('drops guardrails for someone with a home organisation they do not administer', () => {
            render(<SecurityHub user={{ ...orgAdmin, orgRole: 'member', organizationId: 'org-1', isHomeOrgAdmin: false }} activeSection="guardrails" />);
            expect(screen.queryByText('admin.sec_guardrails')).not.toBeInTheDocument();
            expect(screen.getByTestId('user-management')).toBeInTheDocument();
        });

        it('a user holding only the all permission is not a platform admin', () => {
            render(<SecurityHub user={{ permissions: ['all'], isAdmin: false }} activeSection="email-domains" />);
            expect(screen.getByTestId('user-management')).toBeInTheDocument();
            expect(screen.queryByText('admin.sec_email_domains')).not.toBeInTheDocument();
        });
    });
});
