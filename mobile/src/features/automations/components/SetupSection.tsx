/**
 * How the routine is set up: on/off, what starts it, and its flow — each
 * with the place to change it. A schedule has its own quick picker; any other
 * trigger, and the steps, open in the flow editor.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Card, Divider, Section, Text } from '@/shared/ui';

import { ActivationRow } from './ActivationRow';
import { TriggerRow } from './TriggerRow';
import { describeTrigger } from '../model/trigger';
import type { Automation } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        flow: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
        },
        text: { flex: 1, gap: 2 },
    });

export function SetupSection({
    automation,
    activation,
    onEditSchedule,
}: {
    automation: Automation;
    activation: { pending: boolean; error: unknown; onChange: (next: boolean) => void };
    onEditSchedule: () => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const router = useRouter();
    const trigger = automation.definition?.trigger ?? null;
    const stepCount = automation.definition?.steps?.length ?? 0;
    const editFlow = () => router.push(`/automations/${automation.id}/build`);

    return (
        <Section title={t('mobile.automations.setup', 'Setup')}>
            <Card padded={false}>
                <ActivationRow automation={automation} {...activation} />

                <Divider inset={theme.spacing.lg} />

                <TriggerRow
                    label={t('routine_editor.section.trigger', 'Trigger')}
                    value={describeTrigger(trigger)}
                    onEdit={trigger?.kind === 'schedule' ? onEditSchedule : editFlow}
                />

                <Divider inset={theme.spacing.lg} />

                <View style={styles.flow}>
                    <View style={styles.text}>
                        <Text variant="body">{t('mobile.automations.flow', 'Flow')}</Text>
                        <Text variant="caption" tone="tertiary">
                            {stepCount > 0
                                ? t('mobile.automations.flow_steps', '{n} steps · version {version}', { n: stepCount, version: automation.version })
                                : t('mobile.automations.flow_version', 'Version {version}', { version: automation.version })}
                        </Text>
                    </View>
                    <Button
                        label={t('mobile.automations.edit_flow', 'Edit flow')}
                        variant="secondary"
                        iconName="Workflow"
                        onPress={editFlow}
                        accessibilityHint={t('mobile.automations.edit_flow_hint', 'Opens its steps: add, change, reorder and test them')}
                    />
                </View>
            </Card>
        </Section>
    );
}
