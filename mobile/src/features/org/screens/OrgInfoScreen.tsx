/**
 * Organisation Info (web: orgInfo/OrgInfoSection.jsx, OrgDefaultLanguage.jsx
 * and the save/logo handlers in OrgInfoPanel.jsx).
 *
 * The thirteen text fields save together through the SaveBar — but as a
 * partial patch of the fields that changed, where the web sends its whole
 * form back (the server skips an absent key, so the effect is the same and
 * a field the phone does not show can never be overwritten). The logo and the
 * default language act at once, as on the web. The organisation's identifier
 * closes the page, selectable, for a support request. The one deviation: an empty
 * company name is refused here, where the web would save it.
 */

import React, { useState } from 'react';

import { describeError } from '@/core/api/errors';
import { useAuth } from '@/core/auth/AuthProvider';
import { useTranslation } from '@/core/i18n';
import { Group, InfoRow, SaveBar, useToast } from '@/shared/ui';

import { CountrySheet } from '../components/CountrySheet';
import { DefaultLanguageGroup } from '../components/DefaultLanguageGroup';
import { LogoGroup } from '../components/LogoGroup';
import { NcBindingGroup } from '../components/NcBindingGroup';
import { OrgSettingsFrame } from '../components/OrgSettingsFrame';
import { ProfileFieldsGroups } from '../components/ProfileFieldsGroups';
import { useOrganization } from '../hooks/queries';
import { useSetOrgDefaultLanguage } from '../hooks/sectionMutations';
import { useOrgLanguages } from '../hooks/sectionQueries';
import { useDraft } from '../hooks/useDraft';
import { useLogoActions } from '../hooks/useLogoActions';
import { useOrgContext } from '../hooks/useOrgSections';
import { useSaveOrgRecord } from '../hooks/useSaveOrgRecord';
import { profileFormOf } from '../model/profile';

export function OrgInfoScreen() {
    const t = useTranslation();
    const { toast } = useToast();
    const { user } = useAuth();
    const { orgId, isOrgAdmin, isNcOrg } = useOrgContext();
    const allowed = isOrgAdmin && Boolean(orgId);
    const [countryOpen, setCountryOpen] = useState(false);

    const query = useOrganization(allowed ? orgId : null);
    const record = useSaveOrgRecord(orgId);
    const languages = useOrgLanguages(allowed);
    const setLanguage = useSetOrgDefaultLanguage();
    const logo = useLogoActions(orgId);
    const form = useDraft(query.data ? profileFormOf(query.data) : null);
    const nameError = form.draft && !form.draft.name.trim() ? t('mobile.org.name_required', 'An organisation needs a name.') : null;

    const onSave = async () => {
        if (await record.save(form.patch)) form.reset();
    };

    const onLanguage = (code: string) => {
        setLanguage.mutate(code, {
            onSuccess: () => toast(t('common.saved', 'Saved'), 'success'),
            onError: (err) => toast(describeError(err).message, 'error'),
        });
    };

    return (
        <OrgSettingsFrame
            title={t('settings.org_info', 'Organisation Info')}
            allowed={allowed}
            query={query}
            onRefresh={() => void languages.refetch()}
            dirty={form.dirty}
            footer={
                <SaveBar
                    dirty={form.dirty}
                    saving={record.saving}
                    blockedReason={nameError}
                    onSave={() => void onSave()}
                    onDiscard={form.reset}
                />
            }
        >
            {(org) => (
                <>
                    {isNcOrg && user?.ncOrg ? <NcBindingGroup binding={user.ncOrg} /> : null}
                    <LogoGroup logo={org.logo} busy={logo.busy} onUpload={logo.upload} onRemove={logo.remove} />
                    <ProfileFieldsGroups
                        form={form.draft ?? profileFormOf(org)}
                        onChange={form.set}
                        onPickCountry={() => setCountryOpen(true)}
                        disabled={record.saving}
                        nameError={nameError}
                    />
                    <DefaultLanguageGroup languages={languages.data} saving={setLanguage.isPending} onPick={onLanguage} />
                    <Group>
                        <InfoRow label={t('mobile.org.profile_id', 'Identifier')} value={orgId ?? ''} selectable />
                    </Group>
                    <CountrySheet
                        visible={countryOpen}
                        value={form.draft?.billingCountry ?? ''}
                        onPick={(code) => form.set('billingCountry', code)}
                        onClose={() => setCountryOpen(false)}
                    />
                </>
            )}
        </OrgSettingsFrame>
    );
}
