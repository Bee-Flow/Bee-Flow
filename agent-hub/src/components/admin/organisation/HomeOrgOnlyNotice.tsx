// In place of a part that the server ties to the caller's own organisation
// (it takes no organisation from the request), while a platform admin works on
// another organisation in the dashboard: showing the own organisation's data
// under another organisation's name would mislead.

import { useTranslation } from '@/hooks/useTranslation';
import { ALERT_INFO } from '@/components/mcpLibrary/ui';

export default function HomeOrgOnlyNotice() {
    const { t } = useTranslation();
    return (
        <p className={ALERT_INFO} data-testid="admin-home-org-only">
            {t('admin.org_home_only', 'This part works on your own organisation only. Choose your own organisation above to change it.')}
        </p>
    );
}
