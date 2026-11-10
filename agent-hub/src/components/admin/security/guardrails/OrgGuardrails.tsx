import { adminSectionScope } from '@/components/admin/dashboard/adminTabs';
import { useAdminScopeOverride } from '@/components/admin/dashboard/useAdminScopeOverride';
import SectionHeader from '@/components/shared/SectionHeader';
import { useTranslation } from '@/hooks/useTranslation';
import OrgShieldEditor from './orgShield/OrgShieldEditor';

interface OrgGuardrailsProps {
    /** The viewer's home organisation; without one there is nothing to edit. */
    orgId: string | null;
}

/**
 * The guardrails an organisation administrator sees: the Privacy Shield of their
 * own organisation. The pattern library, the Direct chat binding and the other
 * sections of the server console are about every organisation on the server, so
 * they are not part of this view (see GuardrailsHub, which a platform admin gets).
 * No organisation picker: nothing is rendered or saved without an organisation.
 */
export default function OrgGuardrails({ orgId }: OrgGuardrailsProps) {
    const { t } = useTranslation();
    useAdminScopeOverride(adminSectionScope('security', 'guardrails', 'organisations'));
    if (!orgId) return null;
    return (
        <div className="space-y-5">
            <SectionHeader title={t('admin.sec_guardrails', 'Guardrails')} />
            <OrgShieldEditor orgId={orgId} />
        </div>
    );
}
