/**
 * Preferred sign-in method (web: orgInfo/OrgAuthSection.tsx, AUTH_METHODS and
 * AllowedDomainsEditor in orgInfoShared.tsx).
 *
 * A preference, not a lock: nothing reads it when someone signs in, so it can
 * change at any time. The web selects and then saves on its save bar; here a
 * tap saves the new method at once. Allowed domains (self-hosted only) are a
 * list saved through the SaveBar, validated with the web's (and server's)
 * regex. An organisation provisioned through Nextcloud has neither: its
 * identity is the Nextcloud instance's.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { Group, SaveBar, TagInput } from '@/shared/ui';

import { FieldRow } from '../components/FieldRow';
import { OrgSettingsFrame } from '../components/OrgSettingsFrame';
import { SignInMethodGroup } from '../components/SignInMethodGroup';
import { useOrganization } from '../hooks/queries';
import { useDraft } from '../hooks/useDraft';
import { useOrgContext } from '../hooks/useOrgSections';
import { useSaveOrgRecord } from '../hooks/useSaveOrgRecord';
import { isValidDomain, normalizeDomain, type AuthMethodId } from '../model/profile';

export function OrgSignInScreen() {
    const t = useTranslation();
    const { orgId, isOrgAdmin, isSelfHosted, isNcOrg } = useOrgContext();
    const allowed = isOrgAdmin && Boolean(orgId) && !isNcOrg;
    const query = useOrganization(allowed ? orgId : null);
    const record = useSaveOrgRecord(orgId);
    const form = useDraft(query.data ? { allowedDomains: query.data.allowedDomains ?? [] } : null);

    const choose = async (method: AuthMethodId) => {
        await record.save({ authMethod: method });
    };

    const saveDomains = async () => {
        if (await record.save(form.patch)) form.reset();
    };

    return (
        <OrgSettingsFrame
            title={t('org_signin.title', 'Preferred sign-in method')}
            subtitle={t(
                'org_signin.subtitle',
                'How you would like members of this organisation to sign in. It is a preference: the other sign-in methods of this server keep working, and you can change it at any time.',
            )}
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
                        onChoose={(method) => void choose(method)}
                    />
                    {isSelfHosted ? (
                        <Group
                            title={t('org.allowed_domains', 'Allowed Domains')}
                            footer={t(
                                'org_signin.allowed_domains_desc',
                                'E-mail domains that belong to this organisation. Someone who signs in through single sign-on with an address on one of these domains is linked to this organisation, and no new organisation can be created with them.',
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
