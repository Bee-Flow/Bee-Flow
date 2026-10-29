/** The add sheet's first page: one row per door (file, scan, photo, link, text). */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Divider, Icon, ListRow, Text, type IconName } from '@/shared/ui';

import type { UploadFile } from '../api/upload';
import { pickDocuments, pickImages } from '../model/pickers';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        footnote: { paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md },
    });

/** Hands the picked files on, unless the person backed out of the picker. */
const deliver = (pick: () => Promise<UploadFile[]>, onFiles: (files: UploadFile[]) => void) => () => {
    void pick().then((files) => {
        if (files.length) onFiles(files);
    });
};

export function AddSourceMenu({
    accepts,
    onFiles,
    onScan,
    onUrl,
    onText,
}: {
    accepts?: string;
    onFiles: (files: UploadFile[]) => void;
    onScan: () => void;
    onUrl: () => void;
    /** Omitted when the target takes no pasted text. */
    onText?: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const icon = (name: IconName) => (
        <Icon name={name} size={20} color={theme.colors.textMuted} />
    );

    return (
        <View>
            <ListRow
                title={t('mobile.knowledge.door_file', 'Choose a file')}
                subtitle={accepts}
                leading={icon('FilePlus')}
                onPress={deliver(pickDocuments, onFiles)}
            />
            <Divider inset={theme.spacing.lg} />
            <ListRow
                title={t('mobile.knowledge.door_scan', 'Scan with the camera')}
                subtitle={t('mobile.knowledge.door_scan_hint', 'Photograph a page — several, if it has several')}
                leading={icon('Camera')}
                onPress={onScan}
            />
            <Divider inset={theme.spacing.lg} />
            <ListRow
                title={t('mobile.knowledge.door_photo', 'Pick a photo')}
                subtitle={t('mobile.knowledge.door_photo_hint', "From this device's gallery")}
                leading={icon('Image')}
                onPress={deliver(pickImages, onFiles)}
            />
            <Divider inset={theme.spacing.lg} />
            <ListRow
                title={t('mobile.knowledge.door_link', 'Add a link')}
                subtitle={t('mobile.knowledge.door_link_hint', 'A web page, fetched and kept as text')}
                leading={icon('Link')}
                onPress={onUrl}
            />
            {onText ? (
                <>
                    <Divider inset={theme.spacing.lg} />
                    <ListRow
                        title={t('knowledge.kind.text', 'Paste text')}
                        subtitle={t('mobile.knowledge.door_text_hint', 'When you have the words but not the file')}
                        leading={icon('TextAlignStart')}
                        onPress={onText}
                    />
                </>
            ) : null}

            <Text variant="label" tone="tertiary" style={styles.footnote}>
                {t(
                    'mobile.knowledge.door_footnote',
                    'Everything you add is processed on your own server. Text extraction and embedding happen in the background, so a large file stays “processing” for a while.',
                )}
            </Text>
        </View>
    );
}
