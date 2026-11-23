// In place of an organisation's page while a platform admin has "All
// organisations" chosen in the dashboard: there is no organisation to work on,
// so the page asks for a choice rather than picking one. With no organisation
// on the server at all, it points to where one is created.

import { ArrowRight } from 'lucide-react';
import { useTranslation } from '@/hooks/useTranslation';
import { ALERT_INFO } from '@/components/mcpLibrary/ui';
import { QUIET_BTN } from '@/components/shared/adminUi';
import { navigate } from '@/router/history';

/** Whole server > Organisations, where "Add organisation" lives. */
const ORGANISATIONS_PATH = '/app/admin/organisations';

interface ChooseOrgNoticeProps {
    /** The server has no organisations at all. */
    noOrgs: boolean;
    /** The page's own sentence (why it needs one organisation); left out, the general one. */
    text?: string;
}

export default function ChooseOrgNotice({ noOrgs, text }: ChooseOrgNoticeProps) {
    const { t } = useTranslation();
    if (noOrgs) {
        return (
            <div role="status" className={`${ALERT_INFO} flex flex-wrap items-center justify-between gap-2`} data-testid="admin-choose-org">
                <span>{t('admin_no_org.no_orgs_yet', 'There is no organisation on this server yet. This page works on one organisation.')}</span>
                <button type="button" className={QUIET_BTN} onClick={() => navigate(ORGANISATIONS_PATH)} data-testid="admin-create-org">
                    {t('admin_no_org.create_org', 'Create an organisation')}
                    <ArrowRight className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            </div>
        );
    }
    return (
        <p role="status" className={ALERT_INFO} data-testid="admin-choose-org">
            {text ?? t('admin.scope_choose_org', 'Choose an organisation above to manage it')}
        </p>
    );
}
