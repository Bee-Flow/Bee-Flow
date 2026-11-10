// The chip that says whose data an admin section is about: the whole server,
// one organisation, the viewer's own account, or (for sections that depend on
// who is looking) every organisation versus the viewer's own. It reuses the
// chip of the MCP library's ServerWideCard.
import { Building2, Server, User, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { CHIP } from '@/components/mcpLibrary/ui';
import type { AdminScope } from './adminTabs';

interface ScopeBadgeProps {
    scope: AdminScope;
    /** A platform admin sees every organisation where a section is 'mixed'. */
    isPlatformAdmin: boolean;
    /** The viewer's organisation name, when the SPA already holds it. */
    orgName?: string | null;
    /** The viewer belongs to more than one organisation, so their lists are the union. */
    multiOrg?: boolean;
}

export default function ScopeBadge({ scope, isPlatformAdmin, orgName, multiOrg = false }: ScopeBadgeProps) {
    const { t } = useTranslation();
    const yourOrg = orgName
        ? t('admin.scope_org_named', 'Organisation: {name}', { name: orgName })
        : t('admin.scope_org', 'Your organisation');
    let Icon: LucideIcon = Building2;
    let label = yourOrg;
    let hint = t('admin.scope_org_hint', 'Applies to your organisation only');
    if (scope === 'instance') {
        Icon = Server;
        label = t('admin.scope_instance', 'Whole server');
        hint = t('admin.scope_instance_hint', 'Applies to every organisation on this server');
    } else if (scope === 'user') {
        Icon = User;
        label = t('admin.scope_user', 'Personal');
        hint = t('admin.scope_user_hint', 'Applies to your own account only');
    } else if (scope === 'mixed') {
        if (isPlatformAdmin) {
            Icon = Users;
            label = t('admin.scope_all_orgs', 'All organisations');
            hint = t('admin.scope_all_orgs_hint', 'Shows every organisation on this server');
        } else if (multiOrg) {
            label = t('admin.scope_your_orgs', 'Your organisations');
            hint = t('admin.scope_your_orgs_hint', 'Shows the organisations you belong to');
        } else {
            hint = t('admin.scope_org_view_hint', 'Shows your organisation only');
        }
    }
    return (
        <span className={CHIP} title={hint} data-testid="admin-scope-badge" data-scope={scope}>
            <Icon size={11} aria-hidden="true" />
            {label}
        </span>
    );
}
