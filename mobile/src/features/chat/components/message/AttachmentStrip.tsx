/**
 * The files a message was sent with, as badges under its text. An upload the
 * server imported as a spreadsheet document gets a button that hands its
 * workbook to the share sheet (model/importedSheet.ts); the web opens the
 * same document in its side panel, which the phone does not have.
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useFileHandOff } from '@/features/chat/hooks/useFileHandOff';
import { importedWorkbookName, importedWorkbookPath, XLSX_MIME } from '@/features/chat/model/importedSheet';
import type { Attachment, ChatMessage } from '@/features/chat/model/types';
import { Badge, Button } from '@/shared/ui';


const makeStyles = (theme: Theme) => ({
    strip: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: 6, marginTop: theme.spacing.sm },
    imported: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: 6 },
});

function ImportedSheet({ attachment, documentId }: { attachment: Attachment; documentId: string }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { busy, share } = useFileHandOff();
    const name = attachment.name || t('chat.msg.attachment', 'Attachment');
    return (
        <View style={styles.imported}>
            <Badge label={name} tone="neutral" />
            <Button
                label={t('mobile.chat.share_or_save', 'Share or save…')}
                iconName="Share2"
                size="sm"
                variant="secondary"
                loading={busy}
                accessibilityHint={t('mobile.chat.imported_sheet_hint', 'Opens {name} as an Excel workbook in another app', { name })}
                onPress={() => share(importedWorkbookPath(documentId), importedWorkbookName(name), XLSX_MIME)}
            />
        </View>
    );
}

export function AttachmentStrip({ attachments }: { attachments: NonNullable<ChatMessage['attachments']> }) {
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.strip}>
            {attachments.map((a, i) => (a.documentId
                ? <ImportedSheet key={a.id ?? i} attachment={a} documentId={a.documentId} />
                : <Badge key={a.id ?? i} label={a.name} tone="neutral" />))}
        </View>
    );
}
