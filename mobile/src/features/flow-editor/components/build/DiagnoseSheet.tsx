/**
 * The trigger's health check — the web's TriggerDiagnosePanel: each check of
 * POST /:id/diagnose-trigger (the integration, the credentials, the
 * subscription, a recent match) with its verdict, message and detail, then
 * what to do next.
 */

import React from 'react';
import { View, type TextStyle, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { CheckStatus, TriggerCheck, TriggerDiagnosis } from '@/features/flow-editor/api';
import { Icon, Sheet, Spinner, Text, type IconName } from '@/shared/ui';

const GLYPH: Record<CheckStatus, { icon: IconName; tone: 'success' | 'warning' | 'error' | 'tertiary' }> = {
    ok: { icon: 'CheckCircle2', tone: 'success' },
    warn: { icon: 'TriangleAlert', tone: 'warning' },
    error: { icon: 'CircleAlert', tone: 'error' },
    skipped: { icon: 'CheckCircle2', tone: 'tertiary' },
};

/** The closing sentence: the web panel's, per trigger kind. */
export function diagnosisVerdict(result: TriggerDiagnosis, t: TranslateFn): string {
    if (!result.ok) return t('mobile.flow.diagnose.failed', 'One or more checks failed — fix the highlighted issue and re-run the diagnose.');
    if (result.kind.startsWith('nextcloud.')) {
        return t('mobile.flow.diagnose.ok_nextcloud', 'No critical issues found. Trigger the matching Nextcloud action (e.g. upload a file) to confirm the run fires.');
    }
    if (result.kind.startsWith('gmail.')) return t('mobile.flow.diagnose.ok_gmail', 'No critical issues found. Send a matching email to confirm the run fires.');
    return t('mobile.flow.diagnose.ok', 'No critical issues found.');
}

function CheckRow({ check }: { check: TriggerCheck }) {
    const styles = useThemedStyles(makeStyles);
    const glyph = GLYPH[check.status];
    const color = glyph.tone === 'tertiary' ? styles.muted.color : styles[glyph.tone].color;
    return (
        <View style={styles.check} testID={`diagnose-${check.name}`}>
            <Icon name={glyph.icon} size={16} color={color} />
            <View style={styles.body}>
                <Text variant="label" tone="tertiary" style={styles.name}>
                    {check.name}
                </Text>
                <Text variant="body">{check.message}</Text>
                {check.detail != null ? (
                    <Text variant="code" tone="secondary" selectable>
                        {JSON.stringify(check.detail, null, 2)}
                    </Text>
                ) : null}
            </View>
        </View>
    );
}

export function DiagnoseSheet({ visible, onClose, result, loading, error }: { visible: boolean; onClose: () => void; result: TriggerDiagnosis | null; loading: boolean; error: unknown }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <Sheet visible={visible} onClose={onClose} title={t('mobile.flow.diagnose.title', 'Trigger diagnose')}>
            {loading ? (
                <View style={styles.loading}>
                    <Spinner />
                    <Text variant="caption" tone="secondary">
                        {t('mobile.flow.diagnose.probing', 'Probing the trigger pipeline…')}
                    </Text>
                </View>
            ) : null}
            {error && !loading ? <Text tone="error">{describeError(error).message}</Text> : null}
            {result && !loading ? (
                <View style={styles.list}>
                    <Text variant="caption" tone="tertiary">
                        {t('mobile.flow.diagnose.kind', 'Trigger kind: {kind}', { kind: result.kind })}
                    </Text>
                    {result.checks.map((c) => (
                        <CheckRow key={c.name} check={c} />
                    ))}
                    <Text variant="caption" tone="tertiary">
                        {diagnosisVerdict(result, t)}
                    </Text>
                </View>
            ) : null}
        </Sheet>
    );
}

const makeStyles = (theme: Theme) => ({
    loading: { flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm, paddingVertical: theme.spacing.md } satisfies ViewStyle,
    list: { gap: theme.spacing.sm } satisfies ViewStyle,
    check: {
        flexDirection: 'row', gap: theme.spacing.sm, padding: theme.spacing.sm, borderRadius: theme.radii.md,
        borderWidth: 1, borderColor: theme.colors.borderDefault, backgroundColor: theme.colors.bgSecondary,
    } satisfies ViewStyle,
    body: { flex: 1, minWidth: 0, gap: 2 } satisfies ViewStyle,
    name: { textTransform: 'uppercase', letterSpacing: 0.5 } satisfies TextStyle,
    success: { color: theme.colors.successInk },
    warning: { color: theme.colors.warningInk },
    error: { color: theme.colors.errorInk },
    muted: { color: theme.colors.textTertiary },
});
