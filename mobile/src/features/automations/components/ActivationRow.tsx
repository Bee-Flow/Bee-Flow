/**
 * The on/off switch of a routine, and — when activation is refused — the
 * reasons. Activation re-validates the whole flow strictly, so a refusal is a
 * real list of problems, not a hiccup.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
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

function stateLine(automation: Automation): string {
    if (!automation.isActive) return 'Paused — it will not fire on its own';
    return automation.nextRunAt
        ? `Next run ${absoluteTime(automation.nextRunAt).toLowerCase()}`
        : 'Armed and waiting for its trigger';
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
    return (
        <>
            <View style={styles.row}>
                <View style={styles.text}>
                    <Text variant="body">Automation is on</Text>
                    <Text variant="caption" tone="tertiary">
                        {stateLine(automation)}
                    </Text>
                </View>
                {pending ? (
                    <Spinner />
                ) : (
                    <Switch
                        value={automation.isActive}
                        onValueChange={onChange}
                        accessibilityLabel="Automation is on"
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
