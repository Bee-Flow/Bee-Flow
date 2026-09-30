/**
 * Azure Configuration (web: integrations/azure/index.jsx, self-hosted only):
 * the installation's Azure OpenAI deployment, chat-model tiers, document
 * processing and Microsoft SSO with Azure AD group sync. The web shows one
 * section at a time beside its list; here the list opens each as its own
 * screen. Every key is the installation's (the admin dashboard writes the
 * same ones), which is why the server opens it to org admins on self-hosted
 * installs only — and only to the strict org_admin role.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { OrgSettingsFrame } from '@/features/org';
import { Group } from '@/shared/ui';

import { AzureSectionRow } from '../components/AzureSectionRow';
import { useAzureScreen } from '../hooks/useAzureScreen';
import { AZURE_SECTIONS } from '../model/azure';

export function AzureScreen() {
    const t = useTranslation();
    const router = useRouter();
    const azure = useAzureScreen();
    return (
        <OrgSettingsFrame title={azure.subtitle} allowed={azure.allowed} denied={azure.denied} query={azure.query}>
            {(config) => (
                <Group
                    footer={t(
                        'azure.panel_subheader',
                        'Manage Azure services for your platform. Changes here apply to the same configuration used in the admin dashboard.',
                    )}
                >
                    {AZURE_SECTIONS.map((section) => (
                        <AzureSectionRow key={section.id} section={section} config={config} onPress={() => router.push(section.href as never)} />
                    ))}
                </Group>
            )}
        </OrgSettingsFrame>
    );
}
