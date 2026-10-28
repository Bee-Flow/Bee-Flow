/**
 * The on/off switch of an automation, and — when activation is refused — the
 * reasons. Activation re-validates the whole flow strictly, so a refusal is a
 * real list of problems, not a hiccup.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Spinner, Switch, Text } from '@/shared/ui';

import { activationDetails } from '../model/definition';
import { absoluteTime } from '../model/time';
import type { Automation } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.md,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
            minHeight: theme.minTouch,
        },
        text: { flex: 1, gap: 2 },
        refusal: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.md },
        lines: { gap: 2 },
    });

function stateLine(t: TranslateFn, automation: Automation): string {
    if (!automation.isActive) return t('mobile.automations.state.paused', 'Paused — it will not fire on its own');
    return automation.nextRunAt
        ? t('mobile.automations.state.next_run', 'Next run {time}', { time: absoluteTime(automation.nextRunAt).toLowerCase() })
        : t('mobile.automations.state.armed', 'Armed and waiting for its trigger');
}

export function ActivationRow({
    automation,
    pending,
    error,
    onChange,
}: {
    automation: Automation;
    pending: boolean;
    error: unknown;
    onChange: (next: boolean) => void;
}) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    return (
        <>
            <View style={styles.row}>
                <View style={styles.text}>
                    <Text variant="body">{t('mobile.automations.is_on', 'Automation is on')}</Text>
                    <Text variant="caption" tone="tertiary">
                        {stateLine(t, automation)}
                    </Text>
                </View>
                {pending ? (
                    <Spinner />
                ) : (
                    <Switch
                        value={automation.isActive}
                        onValueChange={onChange}
                        accessibilityLabel={t('mobile.automations.is_on', 'Automation is on')}
                    />
                )}
            </View>

            {error ? (
                <View style={styles.refusal}>
                    <Banner tone="error">
                        <View style={styles.lines}>
                            <Text variant="caption">{describeError(error).message}</Text>
                            {activationDetails(error).map((line) => (
                                <Text key={line} variant="caption" tone="tertiary">
                                    • {line}
                                </Text>
                            ))}
                        </View>
                    </Banner>
                </View>
            ) : null}
        </>
    );
}
