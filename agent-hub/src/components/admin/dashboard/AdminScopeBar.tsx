// The full-width bar at the top of every dashboard tab that says what the page
// is about: one organisation (by name, with the picker for a platform admin),
// all organisations, the whole server (on the warning surface the notices use,
// so it cannot be taken for an organisation page), or the viewer's own account.
// Each of the four has its own icon and surface, so "one organisation" and
// "every organisation" differ at a glance, not only in the text: one
// organisation is a building on an accent tint, every organisation a stack of
// layers on the neutral surface.

import { useId } from 'react';
import type { ReactNode } from 'react';
import { Building2, Layers, Server, User } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useTranslation, type TranslateFn } from '@/hooks/useTranslation';
import { FIELD_INPUT } from '@/components/shared/SettingsList';
import type { AdminOrgChoice } from './useAdminOrg';
import type { ScopeBarView } from './scopeBarView';

const BAR = 'flex shrink-0 items-start gap-3 border-b px-4 py-2.5 md:px-6';
const NEUTRAL_SURFACE = 'border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[var(--text-primary)]';
const ONE_ORG_SURFACE = 'border-[color-mix(in_srgb,var(--accent)_45%,transparent)] bg-[color-mix(in_srgb,var(--accent)_10%,transparent)] text-[var(--text-primary)]';
const SERVER_SURFACE = 'border-[color-mix(in_srgb,var(--warning)_40%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[var(--warning-ink)]';
const NOTE = 'm-0 text-[12px] leading-snug opacity-80';

/** What the bar covers; it picks the icon and the surface, and is the bar's `data-reach`. */
type Reach = 'server' | 'personal' | 'one-org' | 'all-orgs';

const LOOK: Readonly<Record<Reach, { Icon: LucideIcon; surface: string }>> = {
    server: { Icon: Server, surface: SERVER_SURFACE },
    personal: { Icon: User, surface: NEUTRAL_SURFACE },
    'one-org': { Icon: Building2, surface: ONE_ORG_SURFACE },
    'all-orgs': { Icon: Layers, surface: NEUTRAL_SURFACE },
};

function Bar({ kind, reach, children }: { kind: ScopeBarView['kind']; reach: Reach; children: ReactNode }) {
    const { Icon, surface } = LOOK[reach];
    return (
        <div className={`${BAR} ${surface}`} data-testid="admin-scope-bar" data-kind={kind} data-reach={reach}>
            <Icon className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={2} aria-hidden="true" data-icon={reach} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">{children}</div>
        </div>
    );
}

/** "Organisation: {name}", or "Your organisation" when the name is not known. */
function orgLabel(t: TranslateFn, name: string | null): string {
    return name ? t('admin.scope_org_named', 'Organisation: {name}', { name }) : t('admin.scope_org', 'Your organisation');
}

function OrgPicker({ choice }: { choice: AdminOrgChoice }) {
    const { t } = useTranslation();
    const id = useId();
    const { orgId, orgName, organizations, setOrgId } = choice;
    return (
        <>
            <div className="flex flex-wrap items-center gap-2">
                <label htmlFor={id} className="text-[13px] font-semibold">{t('admin_org.access_panel_organisation', 'Organisation')}</label>
                <select
                    id={id}
                    value={orgId ?? ''}
                    onChange={(e) => setOrgId(e.target.value || null)}
                    className={`${FIELD_INPUT} w-auto max-w-xs min-w-[12rem] font-medium`}
                    data-testid="admin-org-picker"
                >
                    <option value="">{t('admin.scope_all_orgs', 'All organisations')}</option>
                    {organizations.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
            </div>
            <p className={NOTE} aria-live="polite">
                {orgId
                    ? t('admin.scope_one_org_hint', 'Showing {name} only', { name: orgName ?? orgId })
                    : t('admin.scope_all_orgs_showing', 'Showing every organisation on this server')}
            </p>
        </>
    );
}

export default function AdminScopeBar({ view, choice }: { view: ScopeBarView; choice: AdminOrgChoice }) {
    const { t } = useTranslation();
    switch (view.kind) {
        case 'server':
            return (
                <Bar kind="server" reach="server">
                    <strong className="text-[13px]">{t('admin.scope_instance', 'Whole server')}</strong>
                    <p className={NOTE}>{t('admin.scope_instance_changes', 'Changes here apply to every organisation on this server')}</p>
                </Bar>
            );
        case 'personal':
            return (
                <Bar kind="personal" reach="personal">
                    <strong className="text-[13px]">{t('admin.scope_personal', 'Personal: only for you')}</strong>
                </Bar>
            );
        case 'picker':
            return <Bar kind="picker" reach={choice.orgId ? 'one-org' : 'all-orgs'}><OrgPicker choice={choice} /></Bar>;
        case 'all-orgs':
            return (
                <Bar kind="all-orgs" reach="all-orgs">
                    <strong className="text-[13px]">{t('admin.scope_all_orgs', 'All organisations')}</strong>
                    <p className={NOTE}>{t('admin.scope_all_orgs_showing', 'Showing every organisation on this server')}</p>
                </Bar>
            );
        default:
            return (
                <Bar kind="org" reach="one-org">
                    <strong className="text-[13px]">{orgLabel(t, view.name)}</strong>
                    {view.note === 'compliance' && <p className={NOTE}>{t('admin.scope_compliance_home', 'Compliance shows your own organisation')}</p>}
                </Bar>
            );
    }
}
