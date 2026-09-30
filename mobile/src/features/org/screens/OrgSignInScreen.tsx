/**
 * Sign-in method (web: orgInfo/OrgAuthSection.jsx, AUTH_METHODS and
 * AllowedDomainsEditor in orgInfoShared.jsx).
 *
 * The method is chosen ONCE: each user's key is tied to how they sign in, so
 * the server ignores any later change. The web lets the admin select and then
 * save; here choosing asks for confirmation and saves at once, and after that
 * the choice is shown locked. Allowed domains (self-hosted only) are a list
 * saved through the SaveBar, validated with the web's (and server's) regex.
 * An organisation provisioned through Nextcloud has neither: its identity is
 * the Nextcloud instance's.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';
import { Group, SaveBar, TagInput } from '@/shared/ui';

import { FieldRow } from '../components/FieldRow';
import { OrgSettingsFrame } from '../components/OrgSettingsFrame';
import { chooseCarefully, SignInMethodGroup } from '../components/SignInMethodGroup';
import { useOrganization } from '../hooks/queries';
import { useDraft } from '../hooks/useDraft';
import { useOrgContext } from '../hooks/useOrgSections';
import { useSaveOrgRecord } from '../hooks/useSaveOrgRecord';
import { isValidDomain, normalizeDomain, type AuthMethodId } from '../model/profile';

export function OrgSignInScreen() {
    const t = useTranslation();
    const confirm = useConfirm();
    const { orgId, isOrgAdmin, isSelfHosted, isNcOrg } = useOrgContext();
    const allowed = isOrgAdmin && Boolean(orgId) && !isNcOrg;
    const query = useOrganization(allowed ? orgId : null);
    const record = useSaveOrgRecord(orgId);
    const form = useDraft(query.data ? { allowedDomains: query.data.allowedDomains ?? [] } : null);

    const choose = async (method: AuthMethodId, label: string) => {
        const ok = await confirm({
            title: label,
            message: chooseCarefully(t),
            confirmLabel: t('common.save', 'Save'),
            tone: 'destructive',
        });
        if (ok) await record.save({ authMethod: method });
    };

    const saveDomains = async () => {
        if (await record.save(form.patch)) form.reset();
    };

    return (
        <OrgSettingsFrame
            title={t('org.signin_title', 'Sign-in Method')}
            subtitle={t('org.signin_subtitle', 'Choose how users will sign into your organisation')}
            allowed={allowed}
            denied={
                isNcOrg
                    ? {
                          icon: 'Cloud',
                          title: t('mobile.org.nc_title', 'Provisioned through Nextcloud'),
                          message: t(
                              'mobile.org.nc_message',
                              'User accounts and authentication are managed by your Nextcloud instance. Sign-in method and allowed-domain settings are not shown here.',
                          ),
                      }
                    : undefined
            }
            query={query}
            dirty={form.dirty}
            footer={
                <SaveBar dirty={form.dirty} saving={record.saving} onSave={() => void saveDomains()} onDiscard={form.reset} />
            }
        >
            {(org) => (
                <>
                    <SignInMethodGroup
                        current={org.authMethod ?? null}
                        saving={record.saving}
                        onChoose={(method, label) => void choose(method, label)}
                    />
                    {isSelfHosted ? (
                        <Group
                            title={t('org.allowed_domains', 'Allowed Domains')}
                            footer={t(
                                'org.allowed_domains_desc',
                                'Email domains that are allowed to join this organisation via SSO. Users with matching email domains will be automatically linked to this organisation.',
                            )}
                        >
                            <FieldRow>
                                <TagInput
                                testID="allowed-domains"
                                values={form.draft?.allowedDomains ?? []}
                                onChange={(next) => form.set('allowedDomains', next)}
                                placeholder={t('mobile.org.domain_placeholder', 'company.com')}
                                normalize={normalizeDomain}
                                validate={(domain) =>
                                    isValidDomain(domain)
                                        ? null
                                        : t('mobile.org.domain_invalid', 'Invalid domain format: "{domain}"', { domain })
                                }
                                disabled={record.saving}
                                />
                            </FieldRow>
                        </Group>
                    ) : null}
                </>
            )}
        </OrgSettingsFrame>
    );
}
