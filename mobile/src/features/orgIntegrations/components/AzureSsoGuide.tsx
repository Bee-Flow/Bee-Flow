/**
 * The SSO setup guide at the foot of SSOSection.jsx, behind one row: the six
 * steps in the web's words, the Azure permissions the group sync needs, and
 * the Azure Portal's App registrations a tap away.
 */

import React, { useState } from 'react';
import { Linking } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { Button, Group, NoteRow, SettingRow, Sheet } from '@/shared/ui';

const APP_REGISTRATIONS = 'https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade';
const REDIRECT_URI = 'https://your-domain/auth/callback/microsoft';
const PERMISSIONS = ['GroupMember.Read.All', 'User.Read.All', 'Application.Read.All'] as const;

export function AzureSsoGuide() {
    const t = useTranslation();
    const [open, setOpen] = useState(false);
    const title = t('azure.sso_setup_guide', 'Setup guide');
    const portal = t('mobile.orgIntegrations.sso_portal_link', 'Azure Portal → App registrations');
    const steps = [
        `${t('azure.sso_step_1', 'Go to')} ${portal}`,
        t('azure.sso_step_2', 'Create a new registration (or select your existing app)'),
        t('mobile.orgIntegrations.sso_step_3', 'Under Authentication, add a redirect URI: {uri}', { uri: REDIRECT_URI }),
        t('azure.sso_step_4', 'Copy the Application (client) ID and Directory (tenant) ID from the Overview page'),
        t('azure.sso_step_5', 'Under Certificates & secrets, create a new client secret and paste the value above'),
        t(
            'azure.sso_step_6',
            'Under API permissions, add Application permissions: GroupMember.Read.All, User.Read.All, Application.Read.All and grant admin consent',
        ),
    ];
    return (
        <Group>
            <SettingRow testID="azure-sso-guide" label={title} onPress={() => setOpen(true)} />
            <Sheet visible={open} onClose={() => setOpen(false)} title={title} tall footer={<Button label={t('common.close', 'Close')} onPress={() => setOpen(false)} fullWidth />}>
                <Group>
                    <NoteRow>{steps.map((step, i) => `${i + 1}. ${step}`).join('\n')}</NoteRow>
                    <SettingRow testID="azure-sso-portal" label={portal} onPress={() => void Linking.openURL(APP_REGISTRATIONS)} />
                </Group>
                <Group title={t('azure.sync_permissions_title', 'Required Azure Permissions')}>
                    <NoteRow>
                        {t('azure.sync_permissions_desc', 'The following Application permissions must be granted in Azure Portal → App registrations → API permissions, with admin consent:')}
                    </NoteRow>
                    <NoteRow>{PERMISSIONS.join('\n')}</NoteRow>
                </Group>
            </Sheet>
        </Group>
    );
}
