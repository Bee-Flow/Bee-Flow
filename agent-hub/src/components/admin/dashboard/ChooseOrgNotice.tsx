// In place of an organisation's page while a platform admin has "All
// organisations" chosen in the dashboard: there is no organisation to work on,
// so the page asks for a choice rather than picking one.

import { useTranslation } from '@/hooks/useTranslation';
import { ALERT_INFO } from '@/components/mcpLibrary/ui';

interface ChooseOrgNoticeProps {
    /** The server has no organisations at all. */
    noOrgs: boolean;
}

export default function ChooseOrgNotice({ noOrgs }: ChooseOrgNoticeProps) {
    const { t } = useTranslation();
    return (
        <p className={ALERT_INFO} data-testid="admin-choose-org">
            {noOrgs
                ? t('admin_org.access_panel_no_orgs', 'No organisations found.')
                : t('admin.scope_choose_org', 'Choose an organisation above to manage it')}
        </p>
    );
}
