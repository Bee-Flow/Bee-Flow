/**
 * The organisation's shield, read-only: applied on top of the user's own, and
 * possibly narrowed by the tier. An org admin gets a way into the editor
 * (features/orgShield at /org/shield); everyone else is told who sets it.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { useTranslation } from '@/core/i18n';
import { humanise } from '@/shared/lib/display';
import { Badge, BadgeRow, Group, InfoRow, NoteRow, SettingRow, Text } from '@/shared/ui';

import { useOrgContext } from '../hooks/useOrgSections';
import { PII_ACTIONS } from '../model/piiCategories';
import type { OrgShield } from '../model/types';

export function OrgShieldGroup({ shield }: { shield: OrgShield }) {
    const t = useTranslation();
    const router = useRouter();
    const { isOrgAdmin } = useOrgContext();
    const onMatch =
        PII_ACTIONS.find((a) => a.id === shield.piiDetectionAction)?.label ??
        humanise(shield.piiDetectionAction);
    return (
        <Group
            title={t('mobile.org.shield_org_title', "Your organisation's shield")}
            footer={
                isOrgAdmin
                    ? t('mobile.org.shield_org_footer_admin', 'It applies on top of everyone’s own settings and can be stricter than anything they can choose.')
                    : t('mobile.org.shield_org_footer', 'Set by your administrator. It applies on top of yours and can be stricter than anything you can choose here.')
            }
        >
            <BadgeRow label={t('common.status', 'Status')}>
                <Badge
                    label={shield.enabled ? t('mobile.org.shield_active', 'Active') : t('common.off', 'Off')}
                    tone={shield.enabled ? 'success' : 'neutral'}
                />
            </BadgeRow>
            {shield.enabled ? (
                <>
                    <InfoRow label={t('mobile.org.shield_on_match', 'On a match')} value={onMatch} />
                    <InfoRow
                        label={t('mobile.org.shield_eu_only', 'EU-only models')}
                        value={shield.euModeEnabled ? t('mobile.org.shield_required', 'Required') : t('mobile.org.shield_not_required', 'Not required')}
                    />
                    <InfoRow
                        label={t('mobile.org.shield_automations', 'Applies to automations')}
                        value={shield.applyToAutomations ? t('common.yes', 'Yes') : t('common.no', 'No')}
                    />
                </>
            ) : null}
            {shield.clamped_fields?.length ? (
                <NoteRow>
                    <Text variant="caption" tone="warning">
                        {t('mobile.org.shield_clamped', 'Your organisation’s licence tier narrows {fields}. The values above are what actually runs, not what is stored.', { fields: shield.clamped_fields.join(', ') })}
                    </Text>
                </NoteRow>
            ) : null}
            {isOrgAdmin ? (
                <SettingRow
                    label={t('mobile.org.shield_edit', 'Edit organisation shield')}
                    onPress={() => router.push('/org/shield')}
                    testID="edit-org-shield"
                />
            ) : null}
        </Group>
    );
}
