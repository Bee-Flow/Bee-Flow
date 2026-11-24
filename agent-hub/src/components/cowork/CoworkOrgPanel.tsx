/**
 * The organisation's Cowork policy, for its administrators, opened from the page's menu in the sheet (`kind: 'org'`
 * of ./coworkSheetPanels.ts): the same panel as the admin dashboard's (CoworkPolicyPanel), on the user's home
 * organisation. The server checks again that the user administers it.
 */
import CoworkPolicyPanel from '../admin/security/guardrails/orgShield/parts/CoworkPolicyPanel';
import CoworkSheetHeading from './CoworkSheetHeading';
import type { CoworkSheetPanelProps } from './coworkSheetPanels';
import { administersOrg } from './coworkViewer';
import { homeOrgIdOf } from '@/utils/adminAccess';
import { useTranslation } from '@/hooks/useTranslation';

export default function CoworkOrgPanel({ user }: CoworkSheetPanelProps) {
    const { t } = useTranslation();
    const orgId = homeOrgIdOf(user);
    return (
        <div className="flex flex-col" data-testid="cowork-org-panel">
            <CoworkSheetHeading>{t('cowork_home.menu.org', 'Organisation')}</CoworkSheetHeading>
            {orgId && administersOrg(user)
                ? <CoworkPolicyPanel orgId={orgId} t={t} />
                : <p className="text-[14px] text-[var(--text-tertiary)]">{t('cowork_home.org.not_admin', 'Only an administrator of your organisation changes this.')}</p>}
        </div>
    );
}
