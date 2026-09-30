/**
 * Microsoft / Azure AD SSO (web: integrations/azure/SSOSection.jsx): the app
 * registration's client ID, secret and tenant, whether Microsoft sign-ins are
 * approved automatically, and the Azure AD group sync with its settings.
 *
 * The credentials save as one section, like the web's Save; a blank secret
 * keeps the stored one. The tenant is checked as the server checks it before
 * the save is offered. The sync and its settings act at once and are not part
 * of the form, as on the web. The lock-out warning shows while there is
 * something unsaved to warn about, and Back asks before dropping it.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { OrgSettingsFrame } from '@/features/org';
import { useConfirmLeave } from '@/shared/patterns';
import { Badge, BadgeRow, Banner, Group, NoteRow, SaveBar } from '@/shared/ui';

import { AzureGroupSync } from '../components/AzureGroupSync';
import { AzureSsoFields, type SsoDraft } from '../components/AzureSsoFields';
import { AzureSsoGuide } from '../components/AzureSsoGuide';
import { AzureSyncSettings } from '../components/AzureSyncSettings';
import { useAzureScreen } from '../hooks/useAzureScreen';
import { useAzureSectionForm } from '../hooks/useAzureSectionForm';
import { ssoConfigured, validTenant } from '../model/azure';

export function AzureSsoScreen() {
    const t = useTranslation();
    const azure = useAzureScreen();
    const c = azure.query.data;
    const { form, saving, save } = useAzureSectionForm<SsoDraft>(
        azure.orgId,
        c ? { ssoClientId: c.ssoClientId, ssoClientSecret: '', ssoTenantId: c.ssoTenantId, autoApproveSSO: c.autoApproveSSO } : null,
        (d) => ({
            section: 'sso',
            ssoClientId: d.ssoClientId.trim(),
            ...(d.ssoClientSecret.trim() ? { ssoClientSecret: d.ssoClientSecret.trim() } : {}),
            ssoTenantId: d.ssoTenantId.trim(),
            autoApproveSSO: d.autoApproveSSO,
        }),
    );
    const tenantOk = validTenant(form.draft?.ssoTenantId ?? '');
    useConfirmLeave(form.dirty);

    return (
        <OrgSettingsFrame
            title={t('azure.sso_title', 'Microsoft / Azure AD SSO')}
            subtitle={azure.subtitle}
            allowed={azure.allowed}
            denied={azure.denied}
            query={azure.query}
            footer={
                <SaveBar
                    dirty={form.dirty}
                    saving={saving}
                    blockedReason={tenantOk ? null : t('mobile.orgIntegrations.sso_bad_tenant', 'The tenant is your directory GUID, or common, organizations or consumers.')}
                    onSave={() => void save()}
                    onDiscard={form.reset}
                />
            }
        >
            {(data) => {
                const d = form.draft ?? { ssoClientId: data.ssoClientId, ssoClientSecret: '', ssoTenantId: data.ssoTenantId, autoApproveSSO: data.autoApproveSSO };
                const configured = ssoConfigured(data);
                return (
                    <>
                        <Group footer={t('azure.sso_section_desc', 'Configure single sign-on so users can sign in with their Microsoft or Azure AD accounts.')}>
                            <BadgeRow label={t('azure.sso_status', 'Microsoft SSO')}>
                                {configured ? (
                                    <Badge label={t('azure.configured', 'Configured')} tone="success" icon="Check" />
                                ) : (
                                    <Badge label={t('azure.not_configured', 'Not configured')} tone="error" icon="TriangleAlert" />
                                )}
                            </BadgeRow>
                            <NoteRow>
                                {configured
                                    ? t('azure.sso_configured_desc', 'Configured — users can sign in with Microsoft accounts')
                                    : t('azure.sso_not_configured_desc', 'Not configured — users cannot use Microsoft sign-in')}
                            </NoteRow>
                        </Group>
                        {form.dirty ? (
                            <Banner tone="error">
                                {[
                                    t('azure.sso_warning_title', 'Changing these settings can lock users out'),
                                    `• ${t('azure.sso_warning_client', 'Wrong Client ID or Secret — all Microsoft sign-in attempts will fail immediately.')}`,
                                    `• ${t('azure.sso_warning_tenant', 'Wrong Tenant ID — users from your organisation will be unable to authenticate.')}`,
                                    `• ${t('azure.sso_warning_remove', 'Removing credentials — existing Microsoft SSO users will be unable to sign in.')}`,
                                ].join('\n')}
                            </Banner>
                        ) : null}
                        <AzureSsoFields draft={d} hasSecret={data.hasSsoClientSecret} set={form.set} />
                        <AzureGroupSync orgId={azure.orgId} config={data} ready={configured} />
                        {configured ? <AzureSyncSettings orgId={azure.orgId} settings={data.groupSyncSettings} /> : null}
                        <AzureSsoGuide />
                    </>
                );
            }}
        </OrgSettingsFrame>
    );
}
