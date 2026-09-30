/**
 * The fields of one custom tier, in the web's order: icon and name, the
 * description shown in the tier picker, the model and its EU override,
 * "Available for", then max tokens and temperature.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Chip, Group, SettingRow, Stepper, Text, TextField } from '@/shared/ui';

import { MAX_TOKENS, TASK_TYPES, taskTypeLabel, type TierDraft } from '../model/tiers';
import type { ModelOption } from '../model/types';

export function TierFields({
    draft,
    id,
    models,
    errors,
    onChange,
    onPickModel,
}: {
    draft: TierDraft;
    /** The id the tier will be saved under (the label's slug). */
    id: string;
    models: readonly ModelOption[];
    errors: { label?: string; maxTokens?: string };
    onChange: (next: TierDraft) => void;
    onPickModel: (field: 'modelId' | 'euModelId') => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const set = <K extends keyof TierDraft>(key: K, value: TierDraft[K]) => onChange({ ...draft, [key]: value });
    const modelName = (modelId: string, none: string) => {
        if (!modelId) return none;
        const m = models.find((x) => x.id === modelId);
        return m ? `${m.name} (${m.providerName})` : modelId;
    };
    const toggleTask = (key: string) =>
        set(
            'allowedTaskTypes',
            draft.allowedTaskTypes.includes(key)
                ? draft.allowedTaskTypes.filter((k) => k !== key)
                : [...draft.allowedTaskTypes, key],
        );

    return (
        <View style={styles.fields}>
            <View style={styles.nameRow}>
                <TextField
                    testID="tier-icon"
                    label={t('mobile.orgPeople.tier_icon', 'Icon')}
                    value={draft.icon}
                    maxLength={4}
                    onChangeText={(v) => set('icon', v)}
                    containerStyle={styles.icon}
                />
                <TextField
                    testID="tier-label"
                    label={t('mobile.orgPeople.tier_name', 'Tier name')}
                    value={draft.label}
                    error={errors.label}
                    onChangeText={(v) => set('label', v)}
                    containerStyle={styles.name}
                />
            </View>
            <Text variant="code" tone="tertiary">
                {id}
            </Text>
            <TextField
                testID="tier-description"
                label={t('mobile.orgPeople.tier_description', 'Short description (shown in tier picker)')}
                value={draft.description}
                onChangeText={(v) => set('description', v)}
            />
            <Group>
                <SettingRow
                    testID="tier-model"
                    label={t('mobile.orgPeople.tier_model', 'Model')}
                    value={modelName(draft.modelId, t('mobile.orgPeople.not_configured', 'Not configured'))}
                    onPress={() => onPickModel('modelId')}
                />
                <SettingRow
                    testID="tier-eu-model"
                    label={t('mobile.orgPeople.tier_eu_model', 'EU override (optional)')}
                    value={modelName(draft.euModelId, t('mobile.orgPeople.same_as_main', 'Same as main model'))}
                    onPress={() => onPickModel('euModelId')}
                />
            </Group>
            <Text variant="label" tone="tertiary">
                {t('mobile.orgPeople.available_for', 'Available for').toUpperCase()}
            </Text>
            <View style={styles.chips}>
                {TASK_TYPES.map((key) => (
                    <Chip
                        key={key}
                        testID={`task-${key}`}
                        label={taskTypeLabel(key, t)}
                        selected={draft.allowedTaskTypes.includes(key)}
                        onPress={() => toggleTask(key)}
                    />
                ))}
            </View>
            <TextField
                testID="tier-max-tokens"
                label={t('mobile.orgPeople.max_tokens', 'Max Tokens')}
                keyboardType="number-pad"
                value={draft.maxTokens}
                error={errors.maxTokens}
                hint={`${MAX_TOKENS.min}–${MAX_TOKENS.max}`}
                onChangeText={(v) => set('maxTokens', v)}
            />
            <Stepper
                testID="tier-temperature"
                label={t('mobile.orgPeople.temperature', 'Temperature')}
                value={draft.temperature}
                min={0}
                max={2}
                step={0.1}
                format={(v) => v.toFixed(1)}
                onChange={(v) => set('temperature', v)}
            />
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        fields: { gap: theme.spacing.md },
        nameRow: { flexDirection: 'row', gap: theme.spacing.sm },
        icon: { width: 72 },
        name: { flex: 1 },
        chips: { flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm },
    });
