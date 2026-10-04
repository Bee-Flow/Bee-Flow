/**
 * What the validator says about this step, at the top of its settings — the
 * web's SettingsForm banner and ValidationLine: what KIND of problem it is
 * before the list ("Fix this before the automation can run" / "Worth checking"),
 * and each sentence with the step ids swapped for the names the author typed
 * (humanizeIssueText), so the line names the same step the pill did.
 */

import React from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { humanizeIssueText, type StepIssues, type ValidationIssue } from '@/features/flow-editor/model';
import { Text, tint } from '@/shared/ui';

function Line({ issue, labels, tone }: { issue: ValidationIssue; labels: Map<string, string>; tone: 'error' | 'warning' }) {
    const message = humanizeIssueText(String(issue.message ?? ''), labels);
    const hint = issue.hint ? humanizeIssueText(String(issue.hint), labels) : null;
    return (
        <View>
            <Text variant="caption" tone={tone}>
                {message}
            </Text>
            {hint ? (
                <Text variant="caption" tone="tertiary">
                    {`→ ${hint}`}
                </Text>
            ) : null}
        </View>
    );
}

export function IssueList({ issues, labels }: { issues: StepIssues; labels: Map<string, string> }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    if (!issues.errors.length && !issues.warnings.length) return null;
    return (
        <View style={styles.box} accessibilityLiveRegion="polite" testID="step-issues">
            {issues.errors.length ? (
                <Text variant="caption" weight="semibold" tone="error">
                    {t('automations.builder.fix_before_run', 'Fix this before the automation can run:')}
                </Text>
            ) : null}
            {issues.errors.map((e, i) => (
                <Line key={`e${i}`} issue={e} labels={labels} tone="error" />
            ))}
            {issues.warnings.length ? (
                <Text variant="caption" weight="semibold" tone="warning">
                    {t('automations.builder.worth_checking', 'Worth checking:')}
                </Text>
            ) : null}
            {issues.warnings.map((w, i) => (
                <Line key={`w${i}`} issue={w} labels={labels} tone="warning" />
            ))}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: {
        gap: theme.spacing.xs,
        padding: theme.spacing.md,
        borderRadius: theme.radii.md,
        backgroundColor: tint(theme.colors.error, 6),
        borderWidth: 1,
        borderColor: tint(theme.colors.error, 20),
    } satisfies ViewStyle,
});
