/**
 * What the shield looks for, what it does on a match, and what happens when
 * the detector itself is down — three groups that read one shield document.
 */

import React from 'react';

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
    const theme = useTheme();
    const selected = shield.piiDetectionCategories.length;
    const detecting = shield.enabled && shield.piiDetectionEnabled;
    return (
        <>
            <Group
                title="What to look for"
                footer={
                    selected === 0
                        ? EMPTY_MEANS_ALL
                        : `${selected} of ${PII_CATEGORIES.length} categories selected.`
                }
            >
                <SettingRow
                    label="Categories"
                    value={selected === 0 ? 'Everything' : `${selected} selected`}
                    disabled={!detecting}
                    icon={<Icon name="List" size={16} color={theme.colors.textSecondary} />}
                    onPress={onPickCategories}
                />
                <InfoRow
                    label="Confidence threshold"
                    value={`${Math.round(shield.piiDetectionConfidenceThreshold * 100)}%`}
                />
            </Group>

            <Group
                title="When something is found"
                footer="Replacing keeps the conversation working; stopping is stricter and more interruptive."
            >
                {PII_ACTIONS.map((action) => (
                    <OptionRow
                        key={action.id}
                        label={action.label}
                        description={action.description}
                        selected={shield.piiDetectionAction === action.id}
                        disabled={!detecting}
                        onPress={() => onChange({ piiDetectionAction: action.id })}
                    />
                ))}
            </Group>

            <Group
                title="If the detector is down"
                footer="This only bites when a detector is installed but unreachable. On a server with none installed, messages are never held back."
            >
                {PII_FAILURE_MODES.map((mode) => (
                    <OptionRow
                        key={mode.id}
                        label={mode.label}
                        description={mode.description}
                        selected={shield.piiFailureMode === mode.id}
                        disabled={!shield.enabled}
                        onPress={() => onChange({ piiFailureMode: mode.id })}
                    />
                ))}
            </Group>
        </>
    );
}
