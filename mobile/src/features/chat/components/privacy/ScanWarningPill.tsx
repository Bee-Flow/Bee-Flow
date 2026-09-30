/**
 * The amber "Scan incomplete" beside a question (the web's TokenisedBadge):
 * part of an upload could not be checked. A tap lists which file, how much of
 * it was scanned and why the rest was not.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { INCOMPLETE_WORDS, incompleteReasonOf } from '@/features/chat/model/privacyPanel';
import type { ScanWarning } from '@/features/chat/model/types';
import { Chip, Sheet, Text } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    item: { gap: theme.spacing.xxs, marginBottom: theme.spacing.md },
});

export function ScanWarningPill({ warnings }: { warnings: readonly ScanWarning[] }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [open, setOpen] = useState(false);
    if (warnings.length === 0) return null;

    const title = t('dlp.badge_scan_incomplete', 'Scan incomplete');
    return (
        <>
            <Chip
                label={title}
                tone="warning"
                onPress={() => setOpen(true)}
                accessibilityHint={t(
                    'dlp.badge_scan_incomplete_tooltip',
                    'Some uploaded content could not be scanned and was sent to the AI unredacted.',
                )}
            />
            <Sheet visible={open} onClose={() => setOpen(false)} title={title}>
                {warnings.map((w, i) => {
                    const reason = incompleteReasonOf(w) ?? 'degraded';
                    const pages =
                        Number.isFinite(w.scannedPages) && Number.isFinite(w.totalPages)
                            ? ` — ${t('dlp.attachment_scanned_partial', 'Scanned {scanned} of {total} pages', { scanned: w.scannedPages ?? 0, total: w.totalPages ?? 0 })}`
                            : '';
                    return (
                        <View key={`${w.filename ?? 'file'}-${i}`} style={styles.item}>
                            <Text variant="body" weight="medium">
                                {`${w.filename || t('dlp.attachment_unnamed', 'attachment')}${pages}`}
                            </Text>
                            <Text variant="caption" tone="warning">
                                {`⚠ ${t(INCOMPLETE_WORDS[reason].i18nKey, INCOMPLETE_WORDS[reason].en)}`}
                            </Text>
                        </View>
                    );
                })}
            </Sheet>
        </>
    );
}
