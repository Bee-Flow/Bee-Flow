/**
 * A run's step-by-step history.
 *
 * The canvas (flow-editor components/canvas) shows you a flow; this shows
 * what that flow DID, in order, with the clock and
 * the error attached to each node. The two are answering different questions,
 * which is why this is not a shrunken canvas.
 *
 * Three details come straight from the server and are worth naming:
 *   - The step list is the whole JOURNEY (getRunStepsForChain), so an automation
 *     that paused on a form and continued in a child run reads as one
 *     timeline rather than two with holes.
 *   - `definition` is the snapshot AS IT WAS at run time, so a step's label
 *     here is the label it had then — not today's, and not "unknown step".
 *     A step is titled by that label (model/stepLabels.ts), a flowlet's
 *     inner step `call_1/act_9f2c` by its own, and one without a label by
 *     its kind — never by its id or its tool's identifier.
 *   - `parentStepId` is non-null for sub-steps recorded inside a loop or a
 *     called Step, which is why rows indent instead of flattening.
 */

import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { InlineMarkdown } from '@/shared/markdown';
import { Divider, Icon, Text } from '@/shared/ui';

import { StatusIcon } from './StatusPill';
import { ValuePreview } from './ValuePreview';
import { statusLabel, tokenForStep } from '../model/status';
import { runStepNames, runStepTitle } from '../model/stepLabels';
import { stepTypeName } from '../model/stepNames';
import { formatDuration } from '../model/time';
import type { AutomationDefinition, AutomationRunStep } from '../model/types';
import { describeValue } from '../model/values';

export function RunTimeline({
    steps,
    definition,
}: {
    steps: AutomationRunStep[];
    definition: AutomationDefinition | null;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const names = useMemo(() => runStepNames(definition, t), [definition, t]);

    if (steps.length === 0) {
        return (
            <View style={styles.empty}>
                <Text variant="caption" tone="tertiary">
                    {t(
                        'mobile.automations.timeline.no_steps',
                        'This run recorded no steps. That usually means it stopped at the trigger — the run’s own error, above, is the whole story.',
                    )}
                </Text>
            </View>
        );
    }

    return (
        <View>
            {steps.map((step, index) => (
                <View key={`${step.runId}:${step.stepId}:${index}`}>
                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                    <StepRow
                        step={step}
                        index={index}
                        title={runStepTitle(step, names, t)}
                        nested={Boolean(step.parentStepId)}
                    />
                </View>
            ))}
        </View>
    );
}

/**
 * The step's second line: what kind of step, its status word, retries,
 * branch. The kind is left out when the title already IS the kind (a step
 * the definition does not name), so a row never reads "Action / Action".
 */
function stepMeta(step: AutomationRunStep, title: string, word: string, t: TranslateFn): string {
    // The engine's own identifier used to be printed here verbatim —
    // "integration_action", "knowledge_write" — in a vocabulary the web
    // builder spent a release getting off its canvas. Same run, two readings.
    const kind = stepTypeName(step.stepType);
    return [
        kind === title ? null : kind,
        word,
        (step.attempts ?? 1) > 1 ? t('mobile.automations.timeline.attempts', '{n} attempts', { n: step.attempts ?? 1 }) : null,
        step.branchIndex !== null ? t('mobile.automations.timeline.branch', 'branch {n}', { n: step.branchIndex + 1 }) : null,
    ]
        .filter(Boolean)
        .join(' · ');
}

function stepDuration(step: AutomationRunStep): number | null {
    return step.startedAt && step.finishedAt
        ? new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime()
        : null;
}

function StepError({ step }: { step: AutomationRunStep }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.error}>
            <InlineMarkdown value={step.error ?? ''} variant="caption" tone="error" selectable />
            {/* Only present on older Nextcloud rows; newer errors
                already carry "<cause> — <remediation>" inline. */}
            {step.errorRemediation ? (
                <Text variant="caption" tone="warning">
                    {step.errorRemediation}
                </Text>
            ) : null}
            {step.errorClass ? (
                <Text variant="label" tone="tertiary">
                    {step.errorClass}
                </Text>
            ) : null}
        </View>
    );
}

function StepRow({
    step,
    index,
    title,
    nested,
}: {
    step: AutomationRunStep;
    index: number;
    title: string;
    nested: boolean;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    // The whole row, not just its status word: that is what separates a step
    // somebody switched off from one that ran and found nothing to do.
    const token = tokenForStep(step);
    const word = statusLabel(t, token);
    const failed = token.tone === 'error';
    // A failed step opens itself. Nobody taps a row to find out why something
    // broke when the answer could already be on screen.
    const [expanded, setExpanded] = useState(failed);

    // The RAW values travel to ValuePreview, which decides whether they are a
    // table, a record, a list or genuinely raw. Pre-stringifying here is what
    // made every output a JSON wall in the first place.
    const hasDetail = describeValue(step.output).kind !== 'empty' || describeValue(step.input).kind !== 'empty';
    const indent = theme.spacing.lg + (nested ? theme.spacing.xl : 0);

    return (
        <View>
            <Pressable
                onPress={hasDetail ? () => setExpanded((v) => !v) : undefined}
                disabled={!hasDetail}
                accessibilityRole={hasDetail ? 'button' : undefined}
                accessibilityState={{ expanded }}
                accessibilityLabel={
                    failed && step.error
                        ? t('mobile.automations.timeline.row_failed_a11y', 'Step {n}, {title}, {status}. Error: {error}', { n: index + 1, title, status: word, error: step.error })
                        : t('mobile.automations.timeline.row_a11y', 'Step {n}, {title}, {status}', { n: index + 1, title, status: word })
                }
                accessibilityHint={hasDetail ? t('mobile.automations.timeline.row_hint', 'Shows what this step sent and received') : undefined}
                style={({ pressed }) => [styles.row, { paddingLeft: indent }, pressed ? styles.pressed : null]}
            >
                <View style={styles.icon}>
                    <StatusIcon step={step} size={16} />
                </View>

                <View style={styles.text}>
                    <View style={styles.titleRow}>
                        <Text variant="body" weight="medium" numberOfLines={2} style={styles.flex}>
                            {title}
                        </Text>
                        <Text variant="label" tone="tertiary">
                            {formatDuration(stepDuration(step))}
                        </Text>
                    </View>

                    <Text variant="caption" tone="tertiary" numberOfLines={1}>
                        {stepMeta(step, title, word, t)}
                    </Text>

                    {step.error ? <StepError step={step} /> : null}
                </View>

                {hasDetail ? (
                    <Icon
                        name={expanded ? 'ChevronUp' : 'ChevronDown'}
                        size={18}
                        color={theme.colors.textMuted}
                        style={styles.chevron}
                    />
                ) : null}
            </Pressable>

            {expanded && hasDetail ? (
                <View style={[styles.detail, { paddingLeft: indent + 28 }]}>
                    <ValuePreview label={t('mobile.automations.timeline.sent', 'Sent')} value={step.input} />
                    <ValuePreview label={t('mobile.automations.timeline.received', 'Received')} value={step.output} />
                </View>
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        empty: { padding: theme.spacing.lg },
        row: {
            minHeight: 56,
            flexDirection: 'row',
            alignItems: 'flex-start',
            gap: theme.spacing.md,
            paddingVertical: theme.spacing.md,
            paddingRight: theme.spacing.lg,
            backgroundColor: 'transparent',
        },
        pressed: { backgroundColor: theme.colors.itemHoverBg },
        icon: { paddingTop: 2 },
        text: { flex: 1, gap: 2 },
        titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
        flex: { flex: 1 },
        chevron: { marginTop: 4 },
        error: {
            marginTop: theme.spacing.xs,
            padding: theme.spacing.sm,
            gap: theme.spacing.xs,
            borderRadius: theme.radii.sm,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.error,
            backgroundColor: theme.colors.itemHoverBg,
        },
        detail: { paddingRight: theme.spacing.lg, paddingBottom: theme.spacing.lg, gap: theme.spacing.md },
    });
