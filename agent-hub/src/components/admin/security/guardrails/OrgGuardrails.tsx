import { useAdminScopeOverride } from '@/components/admin/dashboard/useAdminScopeOverride';
import SectionHeader from '@/components/shared/SectionHeader';
import { useTranslation } from '@/hooks/useTranslation';
import OrgShieldEditor from './orgShield/OrgShieldEditor';

interface OrgGuardrailsProps {
    /** The organisation to edit: the viewer's home organisation, or a platform admin's choice. */
    orgId: string | null;
    /**
     * The platform admin's organisation read by the "What happened" tab, when
     * it is not the caller's own. The activity endpoints answer for the
     * session's organisation unless one is named.
     */
    activityOrgId?: string | null;
    /** With no organisation, offer the editor's organisation picker (a platform admin) instead of nothing. */
    allowOrgPicker?: boolean;
}

/**
 * The guardrails below the server console: the Privacy Shield of one
 * organisation, with its "What happened" tab. An organisation administrator
 * gets their own organisation; a platform admin whose plan has no server
 * console gets the chosen one, or the editor's picker when none is chosen.
 * The pattern library, the Direct chat binding and the other sections of the
 * server console are about every organisation on the server, so they are not
 * part of this view (see GuardrailsHub).
 * Without an organisation and without the picker nothing is rendered or saved.
 */
export default function OrgGuardrails({ orgId, activityOrgId = null, allowOrgPicker = false }: OrgGuardrailsProps) {
    const { t } = useTranslation();
    // A pinned organisation is one organisation; the picker spans several.
    useAdminScopeOverride(!orgId && allowOrgPicker ? 'mixed' : 'org');
    if (!orgId && !allowOrgPicker) return null;
    return (
        <div className="space-y-5">
            <SectionHeader title={t('admin.sec_guardrails', 'Guardrails')} />
            {orgId
                ? <OrgShieldEditor key={orgId} orgId={orgId} showActivityTab activityOrgId={activityOrgId} />
                : <OrgShieldEditor allowOrgPicker />}
        </div>
    );
}
