/**
 * What the shield found in each attachment, page by page, and — in amber —
 * which ones it could only partly check, because the rest was left out of
 * what the AI received.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { countsLine, incompleteReasonOf, INCOMPLETE_WORDS } from '@/features/chat/model/privacyPanel';
import type { PrivacyAttachment } from '@/features/chat/model/types';
import { Text } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    list: { gap: theme.spacing.xs, marginTop: theme.spacing.xs },
    page: { paddingLeft: theme.spacing.lg },
});

export function PrivacyAttachmentList({ attachments }: { attachments: readonly PrivacyAttachment[] }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.list}>
            <Text variant="caption" tone="tertiary">
                {t('privacy.from_attachments', 'From attachments:')}
            </Text>
            {attachments.map((att, index) => {
                const found = countsLine(att.byCategory);
                const reason = incompleteReasonOf(att);
                const pages =
                    Number.isFinite(att.scannedPages) && Number.isFinite(att.totalPages)
                        ? ` ${t('dlp.attachment_scanned_partial', 'Scanned {scanned} of {total} pages', { scanned: att.scannedPages ?? 0, total: att.totalPages ?? 0 })}`
                        : '';
                return (
                    <View key={`${att.filename ?? 'file'}-${index}`}>
                        <Text variant="caption">
                            {`• ${att.filename || t('dlp.attachment_unnamed', 'attachment')}${found ? ` — ${found}` : ''}`}
                        </Text>
                        {reason ? (
                            <Text variant="caption" tone="warning">
                                {`⚠ ${t(INCOMPLETE_WORDS[reason].i18nKey, INCOMPLETE_WORDS[reason].en)}${pages}`}
                            </Text>
                        ) : null}
                        {Object.entries(att.pages ?? {}).map(([page, byCategory]) => (
                            <Text key={page} variant="caption" tone="secondary" style={styles.page}>
                                {`p.${page} — ${countsLine(byCategory)}`}
                            </Text>
                        ))}
                    </View>
                );
            })}
        </View>
    );
}
