/**
 * One app screen, runnable: its blocks, or — when the phone can draw none of
 * them — what it is built from, plus the version it runs.
 */

import React from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { EmptyState, Text } from '@/shared/ui';

import { AppRunner } from './AppRunner';
import type { AppPlan } from '../model/appDefinition';
import type { StudioAppRuntime } from '../model/types';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        content: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.xxxl, gap: theme.spacing.lg },
        version: { paddingTop: theme.spacing.sm },
    });

export function AppBody({
    app,
    plan,
    refreshing,
    onRefresh,
}: {
    app: StudioAppRuntime;
    plan: AppPlan;
    refreshing: boolean;
    onRefresh: () => void;
}) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    return (
        <ScrollView
            contentContainerStyle={styles.content}
            keyboardShouldPersistTaps="handled"
            refreshControl={
                <RefreshControl
                    refreshing={refreshing}
                    onRefresh={onRefresh}
                    tintColor={theme.colors.accentPrimary}
                    colors={[theme.colors.accentPrimary]}
                />
            }
        >
            {plan.blocks.length === 0 ? (
                <EmptyState
                    icon="Monitor"
                    title="Nothing to fill in here"
                    message={
                        plan.unsupported.length > 0
                            ? `This screen is built from ${plan.unsupported.join(', ')} — parts the phone cannot draw. Open the app in a browser to use it.`
                            : 'This screen has no form or button on it.'
                    }
                />
            ) : (
                <AppRunner appId={app.id} draft={app.draft === true} plan={plan} />
            )}

            {app.appVersion !== null ? (
                <View style={styles.version}>
                    <Text variant="label" tone="tertiary">
                        {`Published version ${app.appVersion}${app.draft ? ' · draft preview' : ''}`}
                    </Text>
                </View>
            ) : null}
        </ScrollView>
    );
}
