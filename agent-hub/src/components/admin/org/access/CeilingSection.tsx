import React from 'react';
import type { ReactNode } from 'react';
import { Building2 } from 'lucide-react';
import CeilingReadOnly from './CeilingReadOnly';
import CloudCeilingEditor from './CloudCeilingEditor';
import OrgAccessEditor from './OrgAccessEditor';
import SelfHostedCeilingEditor from './SelfHostedCeilingEditor';
import { ServerWideDivider } from '@/components/admin/dashboard/serverWideNav';
import { useTranslation } from '@/hooks/useTranslation';

interface CeilingSectionProps {
    mode?: string;
    isSuperAdmin?: boolean;
    orgId?: string | null;
    orgName?: string | null;
    onCeilingChanged?: () => void;
    /** Shown in place of the organisation's part when no organisation is chosen (a platform admin on all organisations). */
    chooseOrg?: ReactNode;
}

/**
 * CeilingSection — routes the ceiling surface by role + deployment mode:
 *   - org-admin (any mode)        → read-only view of the org's access
 *   - super-admin + cloud         → assign plan + edit plan allow-lists
 *   - super-admin + self-hosted   → server licence + global feature switches
 *
 * For super-admins the organisation's part (the cloud plan, and the per-org
 * "Organisation access" menu: which of the max THIS org may use) comes first,
 * under the organisation's name; the self-hosted licence and the global
 * switches are server-wide (adminTabs: access `ceiling/server`) and come last,
 * under a "Whole server" divider. The grant layer (Grants section) then
 * distributes within the organisation's menu.
 */
export default function CeilingSection({ mode, isSuperAdmin, orgId, orgName, onCeilingChanged, chooseOrg = null }: CeilingSectionProps) {
    const { t } = useTranslation();
    if (!isSuperAdmin) return <CeilingReadOnly orgId={orgId} />;
    const selfHosted = mode === 'self-hosted';

    return (
        <div className="flex flex-col gap-8">
            {orgId ? (
                <section className="flex flex-col gap-6" aria-label={t('admin.scope_org_named', 'Organisation: {name}', { name: orgName || orgId })}>
                    <h3 className="m-0 flex items-center gap-1.5 text-[13px] font-semibold text-[var(--text-primary)]">
                        <Building2 className="h-4 w-4 shrink-0" aria-hidden="true" />
                        {t('admin.scope_org_named', 'Organisation: {name}', { name: orgName || orgId })}
                    </h3>
                    {selfHosted ? null : <CloudCeilingEditor orgId={orgId} orgName={orgName} onCeilingChanged={onCeilingChanged} />}
                    <OrgAccessEditor orgId={orgId} onChanged={onCeilingChanged} />
                </section>
            ) : chooseOrg}
            {selfHosted && (
                <section className="flex flex-col gap-6" data-testid="ceiling-server-part">
                    <ServerWideDivider />
                    <SelfHostedCeilingEditor />
                </section>
            )}
        </div>
    );
}
