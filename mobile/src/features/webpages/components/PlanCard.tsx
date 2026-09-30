/**
 * A plan the builder proposed in "Propose first" mode, waiting for an
 * answer: its title and summary, the files it will touch and why, and
 * Approve & build / Reject — the web's WebpagePlanCard. Docked above the
 * composer rather than inline, so the answer is always in reach of a thumb.
 */

import React from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { WebpagePlan, WebpagePlanStep } from '@/shared/stream';
import { Badge, Button, Card, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        dock: { paddingHorizontal: theme.spacing.md, paddingBottom: theme.spacing.sm },
        body: { gap: theme.spacing.sm },
        steps: { maxHeight: 180 },
        step: { flexDirection: 'row', gap: theme.spacing.sm, paddingVertical: theme.spacing.xs },
        stepText: { flex: 1, gap: 2 },
        actions: { flexDirection: 'row', gap: theme.spacing.sm },
        grow: { flex: 1 },
    });

function StepRow({ step }: { step: WebpagePlanStep }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const actions = {
        edit: t('common.edit', 'Edit'),
        create: t('common.create', 'Create'),
        rewrite: t('mobile.webpages.plan.rewrite', 'Rewrite'),
    };
    return (
        <View style={styles.step}>
            <Badge label={actions[step.action]} tone={step.action === 'rewrite' ? 'warning' : 'neutral'} />
            <View style={styles.stepText}>
                <Text variant="code" numberOfLines={1}>
                    {step.file}
                </Text>
                {step.why ? (
                    <Text variant="caption" tone="secondary">
                        {step.why}
                    </Text>
                ) : null}
            </View>
        </View>
    );
}

export function PlanCard({
    plan,
    onApprove,
    onReject,
}: {
    plan: WebpagePlan;
    onApprove: () => void;
    onReject: () => void;
}) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.dock}>
            <Card>
                <View style={styles.body}>
                    <Text variant="label" tone="tertiary">
                        {t('mobile.webpages.plan.heading', 'Proposed plan')}
                    </Text>
                    <Text variant="subheading">{plan.title}</Text>
                    {plan.summary ? (
                        <Text variant="caption" tone="secondary">
                            {plan.summary}
                        </Text>
                    ) : null}
                    <ScrollView style={styles.steps} nestedScrollEnabled>
                        {plan.steps.map((step, i) => (
                            <StepRow key={`${step.file}-${i}`} step={step} />
                        ))}
                    </ScrollView>
                    <View style={styles.actions}>
                        <Button
                            label={t('mobile.webpages.plan.reject', 'Reject')}
                            variant="secondary"
                            onPress={onReject}
                            style={styles.grow}
                        />
                        <Button
                            label={t('mobile.webpages.plan.approve', 'Approve & build')}
                            onPress={onApprove}
                            style={styles.grow}
                        />
                    </View>
                </View>
            </Card>
        </View>
    );
}
