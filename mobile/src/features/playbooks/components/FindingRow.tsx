/**
 * One thing the compliance review found — the web's FindingRow without its
 * "Resolve with AI" (whose fixes write through builders the phone does not
 * have): the severity in the phase's own words, what it is about, why it
 * matters, what to do, where to go, and — until the review is registered —
 * whether to track it in the risk register.
 */

import { useRouter } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Badge, Button, Switch, Text } from '@/shared/ui';

import { artRecord, textOf } from '../model/artifacts';
import { severityWord } from '../model/complianceView';

type Loose = Record<string, unknown>;

/** Where the finding sends you on the phone: always a native screen. */
function destination(finding: Loose): string | null {
    const target = artRecord(finding, 'target');
    const id = textOf(target, 'id');
    if (!id) return null;
    const kind = textOf(target, 'kind');
    if (kind === 'automation') return `/automations/${encodeURIComponent(id)}`;
    if (kind === 'app') return `/apps/${encodeURIComponent(id)}`;
    if (kind === 'table') return `/datatables/${encodeURIComponent(id)}`;
    return null;
}

export function FindingRow({ finding, keep }: { finding: Loose; keep: { on: boolean; onChange: (on: boolean) => void } | null }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const router = useRouter();
    const severity = textOf(finding, 'severity');
    const to = destination(finding);
    const where = [textOf(finding, 'subject'), [textOf(finding, 'framework'), textOf(finding, 'article')].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
    return (
        <View style={styles.row} testID={`playbook-finding-${textOf(finding, 'code')}`}>
            <View style={styles.head}>
                <Badge label={severityWord(severity, t)} tone={severity === 'high' ? 'error' : severity === 'medium' ? 'warning' : 'neutral'} />
                <Text variant="label" tone="tertiary" style={styles.grow}>
                    {finding.source === 'ai' ? t('playbooks.compliance.by_ai', 'noticed by the AI') : t('playbooks.compliance.by_rule', 'from the facts')}
                </Text>
            </View>
            <Text variant="caption" weight="semibold">
                {textOf(finding, 'title')}
            </Text>
            {where ? (
                <Text variant="label" tone="tertiary">
                    {where}
                </Text>
            ) : null}
            {textOf(finding, 'why') ? (
                <Text variant="caption" tone="secondary">
                    {textOf(finding, 'why')}
                </Text>
            ) : null}
            {textOf(finding, 'fix') ? (
                <Text variant="caption">{`${t('playbooks.compliance.fix', 'What to do')}: ${textOf(finding, 'fix')}`}</Text>
            ) : null}
            <View style={styles.actions}>
                {to ? (
                    <Button
                        size="sm"
                        variant="ghost"
                        label={t('playbooks.compliance.goto', 'Take me there')}
                        onPress={() => router.push(to)}
                    />
                ) : null}
                {keep ? (
                    <View style={styles.keep}>
                        <Text variant="label" tone="secondary" style={styles.grow}>
                            {t('playbooks.compliance.keep', 'Track this in the risk register')}
                        </Text>
                        <Switch value={keep.on} onValueChange={keep.onChange} accessibilityLabel={t('playbooks.compliance.keep', 'Track this in the risk register')} />
                    </View>
                ) : null}
            </View>
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        gap: theme.spacing[1],
        padding: theme.spacing[3],
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgPrimary,
    },
    head: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing[2] },
    actions: { gap: theme.spacing[1.5] },
    keep: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing[2] },
    grow: { flex: 1 },
});
