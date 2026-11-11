import { ALERT_INFO } from '@/components/mcpLibrary/ui';
import { useTranslation } from '@/hooks/useTranslation';
import type { OrgTabMode } from './useOrgTabTarget';

/** In place of an organisation-only tab while it has no organisation to work on. */
export default function OrgOnlyNotice({ mode }: { mode: Exclude<OrgTabMode, 'ok'> }) {
    const { t } = useTranslation();
    return (
        <p role="status" className={ALERT_INFO} data-testid="users-org-only-notice">
            {mode === 'choose'
                ? t('admin_org.users_choose_org', 'Choose an organisation above to manage its invitations, roles and model tiers.')
                : t('admin_org.users_home_org_only', 'Invitations, organisation roles and model tiers apply to your own organisation. Choose it above to manage them.')}
        </p>
    );
}
