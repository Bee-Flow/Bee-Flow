/**
 * The SSO credentials and approval rule of SSOSection.jsx, as fields of the
 * screen's form: client ID, secret (blank keeps the stored one), tenant — with
 * the web's warning while it lets any Microsoft account in — and the
 * auto-approve switch with its security notice.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import type { Draft } from '@/features/org';
import { Banner, Group, TextField, ToggleRow } from '@/shared/ui';

import { FieldsGroup } from './FieldsGroup';

export interface SsoDraft {
    ssoClientId: string;
    ssoClientSecret: string;
    ssoTenantId: string;
    autoApproveSSO: boolean;
}

const GUID_PLACEHOLDER = 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx';

export function AzureSsoFields({ draft: d, hasSecret, set }: { draft: SsoDraft; hasSecret: boolean; set: Draft<SsoDraft>['set'] }) {
    const t = useTranslation();
    const common = ['', 'common'].includes(d.ssoTenantId.trim());
    return (
        <>
            <FieldsGroup>
                <TextField
                    testID="azure-sso-client-id"
                    label={t('azure.sso_client_id', 'Application (Client) ID')}
                    placeholder={GUID_PLACEHOLDER}
                    hint={t('azure.sso_client_id_help', 'Found in Azure Portal → App registrations → your app → Overview → Application (client) ID')}
                    autoCapitalize="none"
                    value={d.ssoClientId}
                    onChangeText={(v) => set('ssoClientId', v)}
                />
                <TextField
                    testID="azure-sso-secret"
                    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and its English label, not a secret
                    label={t('azure.sso_client_secret', 'Client Secret')}
                    // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- a fixed mask shown when a secret is stored, and an i18n placeholder; the value itself is typed by the admin
                    placeholder={hasSecret ? '••••••••••••' : t('mobile.orgIntegrations.sso_secret_ph', 'Enter client secret value')}
                    hint={
                        hasSecret
                            // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and its English help text, not a secret
                            ? t('azure.sso_client_secret_help_set', 'Secret is configured. Enter a new value to replace it.')
                            // nosemgrep: ajinabraham.njsscan.generic.hardcoded_secrets.node_secret -- an i18n key and its English help text, not a secret
                            : t('azure.sso_client_secret_help_empty', 'Found in Azure Portal → App registrations → Certificates & secrets → Client secrets')
                    }
                    secure
                    value={d.ssoClientSecret}
                    onChangeText={(v) => set('ssoClientSecret', v)}
                />
                <TextField
                    testID="azure-sso-tenant"
                    label={t('azure.sso_tenant_id', 'Directory (Tenant) ID')}
                    placeholder={t('mobile.orgIntegrations.sso_tenant_ph', 'your-tenant-guid or common')}
                    hint={t('azure.sso_tenant_help', 'Your Azure AD tenant GUID, or use {code} to allow all Microsoft accounts.', { code: 'common' })}
                    autoCapitalize="none"
                    value={d.ssoTenantId}
                    onChangeText={(v) => set('ssoTenantId', v)}
                />
            </FieldsGroup>
            {common ? (
                <Banner tone="warning">
                    {`${t('azure.sso_tenant_common_title', 'Tenant ID is set to "common"')}. ${t('mobile.orgIntegrations.sso_tenant_common_desc', "This allows any Microsoft account (personal and work) to attempt sign-in. For production use, set this to your organisation's specific tenant GUID to restrict access to only your Azure AD directory.")}`}
                </Banner>
            ) : null}
            <Group>
                <ToggleRow
                    testID="azure-sso-auto-approve"
                    label={t('azure.sso_auto_approve', 'Auto-approve new SSO users')}
                    description={t('azure.sso_auto_approve_desc', 'Automatically approve users who sign in via Microsoft SSO with a matching email domain, without requiring admin approval.')}
                    value={d.autoApproveSSO}
                    onValueChange={(v) => set('autoApproveSSO', v)}
                />
            </Group>
            {d.autoApproveSSO ? (
                <Banner tone="warning">
                    {t('azure.sso_auto_approve_warning', 'Security notice: When enabled, any user with a matching email domain will be granted immediate access without admin review. Only enable this if you trust all users in your Azure AD directory.')}
                </Banner>
            ) : null}
        </>
    );
}
