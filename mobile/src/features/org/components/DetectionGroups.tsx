/**
 * What the shield looks for, what it does on a match, and what happens when
 * the detector itself is down — three groups that read one shield document.
 */

import React from 'react';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { Group, Icon, InfoRow, OptionRow, SettingRow } from '@/shared/ui';

import { EMPTY_MEANS_ALL, PII_ACTIONS, PII_CATEGORIES, PII_FAILURE_MODES } from '../model/piiCategories';
import type { UserShield } from '../model/types';

export function DetectionGroups({
    shield,
    onChange,
    onPickCategories,
}: {
    shield: UserShield;
    onChange: (changes: Partial<UserShield>) => void;
    onPickCategories: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const selected = shield.piiDetectionCategories.length;
    const detecting = shield.enabled && shield.piiDetectionEnabled;
    return (
        <>
            <Group
                title={t('automations.ndv.extraction.field_desc', 'What to look for')}
                footer={
                    selected === 0
                        ? t(EMPTY_MEANS_ALL.i18nKey, EMPTY_MEANS_ALL.en)
                        : t('mobile.org.pii_selected_of', '{count} of {total} categories selected.', {
                              count: selected,
                              total: PII_CATEGORIES.length,
                          })
                }
            >
                <SettingRow
                    label={t('automations.templates.categories', 'Categories')}
                    value={
                        selected === 0
                            ? t('mobile.org.pii_everything', 'Everything')
                            : t('mobile.org.pii_selected', '{count} selected', { count: selected })
                    }
                    disabled={!detecting}
                    icon={<Icon name="List" size={16} color={theme.colors.textSecondary} />}
                    onPress={onPickCategories}
                />
                <InfoRow
                    label={t('mobile.org.pii_confidence', 'Confidence threshold')}
                    value={`${Math.round(shield.piiDetectionConfidenceThreshold * 100)}%`}
                />
            </Group>

            <Group
                title={t('mobile.org.pii_on_match_title', 'When something is found')}
                footer={t('mobile.org.pii_on_match_footer', 'Replacing keeps the conversation working; stopping is stricter and more interruptive.')}
            >
                {PII_ACTIONS.map((action) => (
                    <OptionRow
                        key={action.id}
                        label={t(action.label.i18nKey, action.label.en)}
                        description={t(action.description.i18nKey, action.description.en)}
                        selected={shield.piiDetectionAction === action.id}
                        disabled={!detecting}
                        onPress={() => onChange({ piiDetectionAction: action.id })}
                    />
                ))}
            </Group>

            <Group
                title={t('mobile.org.pii_down_title', 'If the detector is down')}
                footer={t('mobile.org.pii_down_footer', 'This only bites when a detector is installed but unreachable. On a server with none installed, messages are never held back.')}
            >
                {PII_FAILURE_MODES.map((mode) => (
                    <OptionRow
                        key={mode.id}
                        label={t(mode.label.i18nKey, mode.label.en)}
                        description={t(mode.description.i18nKey, mode.description.en)}
                        selected={shield.piiFailureMode === mode.id}
                        disabled={!shield.enabled}
                        onPress={() => onChange({ piiFailureMode: mode.id })}
                    />
                ))}
            </Group>
        </>
    );
}
