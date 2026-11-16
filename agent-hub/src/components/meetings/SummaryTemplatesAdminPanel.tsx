import { useCallback } from 'react';
import { useOrgSummaryTemplatesQuery } from '../../api/queries/meetingLibrary';
import useTranslation from '../../hooks/useTranslation';
import TemplateManager from '../../pages/meeting-notes/detail/TemplateManager';
import type { BuiltinTemplate, CustomTemplate, OrgGroup } from '../../pages/meeting-notes/detail/summaryTemplates.types';
import { SettingsGroup } from '@/components/shared/SettingsList';
import LoadingState from '@/components/shared/LoadingState';
import { ALERT_INFO } from '@/components/shared/adminUi';

interface OrgTemplates {
    orgId: string;
    templates: CustomTemplate[];
    groups: OrgGroup[];
}

const NO_BUILTINS: BuiltinTemplate[] = [];

/**
 * Org-admin card: manage organisation-wide and group summary templates in one
 * place, the first card of the Meeting notes page. The heading stays while
 * the templates load and when the API refuses (not an org admin, or Meeting
 * Notes not licensed), so the page never loses its first section silently.
 */
export default function SummaryTemplatesAdminPanel() {
    const { t } = useTranslation();
    const query = useOrgSummaryTemplatesQuery();
    const org: OrgTemplates | null = query.data?.org ?? null;      // { orgId, templates, groups }
    const builtins: BuiltinTemplate[] = query.data?.builtins ?? NO_BUILTINS;
    const { refetch } = query;
    const reload = useCallback(async () => { await refetch(); }, [refetch]);

    return (
        <SettingsGroup
            title={t('meetings.admin_sources.templates_title', 'Summary templates')}
            description={t('meeting_notes.template_org_desc', 'Add Meeting Notes summary styles for your whole organisation or a specific group. Members pick them from the Regenerate menu; a default is applied to new meetings automatically.')}
        >
            <LoadingState
                loading={query.isPending}
                error={query.isError ? true : null}
                errorFallback={() => (
                    <p className={ALERT_INFO}>
                        {t('meetings.admin_sources.templates_unavailable', 'The summary templates could not be loaded for this organisation.')}
                    </p>
                )}
            >
                <TemplateManager
                    templates={org?.templates || []}
                    builtins={builtins}
                    canManageOrg
                    defaultScope="org"
                    groups={org?.groups || []}
                    emptyHint={t('meeting_notes.template_org_empty', 'No organisation or group templates yet.')}
                    onReload={reload}
                />
            </LoadingState>
        </SettingsGroup>
    );
}
