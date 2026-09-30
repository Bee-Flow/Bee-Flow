/**
 * "Edit with AI", docked under the preview: what the builder is doing, a
 * plan waiting for an answer, and the composer. A turn's edits land in the
 * cached files, so the preview above refreshes itself when the turn ends.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Composer } from '@/features/chat';
import { Spinner, Text } from '@/shared/ui';

import { BuildNotices } from './BuildNotices';
import { PlanCard } from './PlanCard';
import type { Builder } from '../hooks/useBuilder';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        working: {
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            paddingHorizontal: theme.spacing.lg,
            paddingTop: theme.spacing.xs,
        },
    });

export function BuildDock({ builder, showActivity }: { builder: Builder; showActivity: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { chat, plan } = builder;

    return (
        <View>
            {chat.streaming && showActivity ? (
                <View style={styles.working} accessibilityLiveRegion="polite">
                    <Spinner size="small" />
                    <Text variant="caption" tone="secondary">
                        {t('mobile.webpages.preview.building', 'The preview refreshes when this turn finishes.')}
                    </Text>
                </View>
            ) : null}
            <BuildNotices store={chat.store} streaming={chat.streaming} />
            {plan ? (
                <PlanCard
                    plan={plan}
                    onApprove={() => chat.approvePlan(plan.planId)}
                    onReject={() => chat.rejectPlan(plan.planId)}
                />
            ) : null}
            <Composer
                onSend={chat.send}
                onStop={chat.stop}
                streaming={chat.streaming}
                settings={builder.settings}
                onSettingsChange={builder.setSettings}
                tiers={builder.tiers}
                sources={false}
                placeholder={t('webpages.chat.placeholder', 'Describe the webpage you want…')}
            />
        </View>
    );
}
