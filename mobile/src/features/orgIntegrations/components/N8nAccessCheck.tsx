/**
 * The access check (N8nSection.jsx AccessCheckCard): why the AI can or cannot
 * see this organisation's n8n workflows, as four gates, each with its fix
 * where one exists — switch n8n on for the organisation, or go grant the
 * modify permission — and, when all pass, the tools the AI is given.
 */

import React from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Button, Group, Icon, ListRow, NoteRow } from '@/shared/ui';

import { accessChecks, type AccessCheck } from '../model/n8n';
import type { N8nDiagnostics } from '../model/n8nTypes';

function checkLabel(id: AccessCheck['id'], t: TranslateFn): string {
    if (id === 'credentials') return t('mobile.orgIntegrations.n8n_check_credentials', 'n8n credentials stored for this organisation');
    if (id === 'org_enabled') return t('mobile.orgIntegrations.n8n_check_org', "n8n is enabled in the organisation's integration set");
    if (id === 'user_can_use') return t('mobile.orgIntegrations.n8n_check_user', 'Your account can use n8n (read/run tools)');
    return t('mobile.orgIntegrations.n8n_check_modify', 'Your account can modify workflows (create/edit/delete/execute)');
}

const DETAILS: Readonly<Record<string, [string, string]>> = {
    all_enabled: ['n8n_why_all', 'No restriction — implicit.'],
    org_override: ['n8n_why_override', 'Org-level override in use.'],
    global_default: ['n8n_why_default', 'Following global default.'],
    auto_enabled: ['n8n_why_auto', 'Auto-enabled for new integrations.'],
    in_saved_list: ['n8n_why_saved', 'You have n8n in your Apps list.'],
    no_saved_list: ['n8n_why_no_list', 'All apps enabled by default.'],
    granted: ['n8n_why_granted', 'Granted via orgRole or group permission.'],
    ask_admin: ['n8n_why_ask', 'Ask an admin to grant the "Modify n8n Workflows" permission.'],
};

function detailText(detail: string | null, t: TranslateFn): string | undefined {
    const entry = detail ? DETAILS[detail] : undefined;
    return entry ? t(`mobile.orgIntegrations.${entry[0]}`, entry[1]) : undefined;
}

export function N8nAccessCheck({
    diag,
    enabling,
    onEnable,
    onPermissions,
}: {
    diag: N8nDiagnostics;
    enabling: boolean;
    onEnable: () => void;
    onPermissions: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const checks = accessChecks(diag);
    const allPass = checks.every((c) => c.ok);
    const fix = (check: AccessCheck) => {
        if (check.fix === 'enable_for_org') {
            return (
                <Button
                    testID="n8n-enable-org"
                    label={t('mobile.orgIntegrations.n8n_enable_org', 'Enable for organisation')}
                    size="sm"
                    variant="secondary"
                    loading={enabling}
                    onPress={onEnable}
                />
            );
        }
        if (check.fix === 'permissions') {
            return <Button label={t('mobile.orgIntegrations.n8n_manage_perms', 'Manage permissions')} size="sm" variant="secondary" onPress={onPermissions} />;
        }
        return undefined;
    };
    return (
        <Group
            title={t('mobile.orgIntegrations.n8n_access_check', 'Access check')}
            footer={
                allPass
                    ? t('mobile.orgIntegrations.n8n_ai_sees', 'AI sees {n} n8n tool(s)', { n: diag.tools.length })
                    : t('mobile.orgIntegrations.n8n_ai_blind', "AI can't see n8n workflows")
            }
        >
            {checks.map((check) => (
                <ListRow
                    key={check.id}
                    testID={`n8n-check-${check.id}`}
                    title={checkLabel(check.id, t)}
                    subtitle={detailText(check.detail, t)}
                    wrapTitle
                    leading={
                        <Icon
                            name={check.ok ? 'CircleCheck' : 'CircleX'}
                            size={18}
                            color={check.ok ? theme.colors.success : theme.colors.error}
                        />
                    }
                    trailing={fix(check)}
                />
            ))}
            {allPass && diag.tools.length > 0 ? <NoteRow>{diag.tools.join(', ')}</NoteRow> : null}
        </Group>
    );
}
