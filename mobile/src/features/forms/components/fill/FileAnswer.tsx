/**
 * A file question. The file uploads the moment it is chosen and only its
 * DESCRIPTOR is kept as the answer: the bytes never travel with the
 * submission, so a refused submit never means choosing the file again.
 * Too large is said before anything is sent.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { FileAnswer as FileValue, FillUploadFile } from '@/features/forms/model/fillTypes';
import { fileSize } from '@/features/forms/model/fillValues';
import { pickFormFile } from '@/features/forms/model/pickFile';
import { Button, Icon, IconButton, ProgressBar, Text } from '@/shared/ui';

import { AnswerRow } from './AnswerRow';
import { labelOf, type AnswerProps } from './types';

function Attached({ file, onRemove, disabled }: { file: FileValue; onRemove: () => void; disabled: boolean }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    return (
        <View style={styles.attached}>
            <Icon name="Paperclip" size={16} color={styles.glyph.color} />
            <View style={styles.name}>
                <Text variant="body" numberOfLines={1}>
                    {file.filename}
                </Text>
                {file.size ? (
                    <Text variant="caption" tone="tertiary">
                        {fileSize(file.size)}
                    </Text>
                ) : null}
            </View>
            <IconButton
                icon={<Icon name="X" size={16} />}
                accessibilityLabel={t('forms.share.audience_remove', 'Remove {name}', { name: file.filename })}
                onPress={onRemove}
                disabled={disabled}
            />
        </View>
    );
}

export function FileAnswer({ field, value, error, disabled, onChange, onError, actions }: AnswerProps) {
    const t = useTranslation();
    const [progress, setProgress] = useState<number | null>(null);
    const file = value && typeof value === 'object' && !Array.isArray(value) && value.kind === 'form_upload' ? value : null;

    const send = async (picked: FillUploadFile) => {
        if (!actions.upload) return;
        if (picked.size > field.maxSizeMb * 1024 * 1024) {
            onError(t('mobile.forms.fill.file_too_large', 'That file is larger than {mb} MB.', { mb: field.maxSizeMb }));
            return;
        }
        setProgress(0);
        try {
            const up = await actions.upload(field, picked, setProgress);
            onChange({ kind: 'form_upload', fileId: up.fileId, filename: up.filename || picked.name, size: up.size ?? picked.size });
        } catch (err) {
            onError(describeError(err).message);
        } finally {
            setProgress(null);
        }
    };
    const choose = async () => {
        const picked = await pickFormFile(field.accept);
        if (picked) await send(picked);
    };

    return (
        <AnswerRow label={labelOf(field)} help={field.help} error={error}>
            {file ? <Attached file={file} onRemove={() => onChange(null)} disabled={disabled} /> : null}
            {!file && progress === null ? (
                <Button
                    variant="secondary"
                    iconName="Paperclip"
                    label={t('mobile.forms.fill.choose_file', 'Choose a file (max {mb} MB)', { mb: field.maxSizeMb })}
                    onPress={() => void choose()}
                    disabled={disabled || !actions.upload}
                    testID={`fill-${field.name}`}
                />
            ) : null}
            {progress !== null ? <ProgressBar fraction={progress} label={t('mobile.forms.fill.uploading', 'Uploading…')} /> : null}
        </AnswerRow>
    );
}

const makeStyles = (theme: Theme) => ({
    attached: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing.sm,
        paddingLeft: theme.spacing.md,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        borderRadius: theme.radii.md,
    } satisfies ViewStyle,
    name: { flex: 1, minWidth: 0 } satisfies ViewStyle,
    glyph: { color: theme.colors.accentPrimary },
});
