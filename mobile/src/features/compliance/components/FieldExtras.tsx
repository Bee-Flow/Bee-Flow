/**
 * What a registry field may add under its input: a live preview line, a
 * warning read from the server for the current value (in the warning tone),
 * and a 'Pick a file' button that reads a text file into the field.
 */

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, Text, useToast } from '@/shared/ui';

import { useRaw } from '../hooks/queries';
import type { FieldSpec, FieldValue } from '../model/types';

/** Read one picked text file; null when the person cancelled. */
export async function pickTextFile(mimeTypes: readonly string[]): Promise<string | null> {
    const result = await DocumentPicker.getDocumentAsync({ type: [...mimeTypes], copyToCacheDirectory: true, multiple: false });
    const asset = result.canceled ? null : result.assets[0];
    return asset ? new File(asset.uri).text() : null;
}

function RemoteWarning({ spec, value }: { spec: FieldSpec; value: FieldValue | undefined }) {
    const t = useTranslation();
    const warn = spec.remoteWarning;
    const path = warn ? warn.path(value) : null;
    const query = useRaw(path, Boolean(path));
    const text = warn && query.data !== undefined ? warn.select(query.data, t) : null;
    if (!text) return null;
    return (
        <Text testID={`field-${spec.key}-warning`} variant="label" tone="warning">
            {text}
        </Text>
    );
}

function FileImport({ spec, onChange }: { spec: FieldSpec; onChange: (next: FieldValue) => void }) {
    const t = useTranslation();
    const { toast } = useToast();
    const [busy, setBusy] = useState(false);
    const types = spec.fileImport?.mimeTypes ?? [];
    const pick = async () => {
        setBusy(true);
        try {
            const text = await pickTextFile(types);
            if (text !== null) onChange(text);
        } catch (err) {
            toast(describeError(err).message, 'error');
        } finally {
            setBusy(false);
        }
    };
    return (
        <Button
            testID={`field-${spec.key}-file`}
            size="sm"
            variant="secondary"
            iconName="FileUp"
            loading={busy}
            label={t('mobile.compliance.field_pick_file', 'Pick a file')}
            onPress={() => void pick()}
        />
    );
}

export function FieldExtras({ spec, value, onChange }: { spec: FieldSpec; value: FieldValue | undefined; onChange: (next: FieldValue) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const preview = spec.preview?.(value, t) ?? null;
    if (!preview && !spec.remoteWarning && !spec.fileImport) return null;
    return (
        <View style={styles.extras}>
            {spec.fileImport ? <FileImport spec={spec} onChange={onChange} /> : null}
            {preview ? (
                <Text testID={`field-${spec.key}-preview`} variant="label" tone="secondary">
                    {preview}
                </Text>
            ) : null}
            {spec.remoteWarning ? <RemoteWarning spec={spec} value={value} /> : null}
        </View>
    );
}

const makeStyles = (theme: Theme) => StyleSheet.create({ extras: { gap: theme.spacing.xs, alignItems: 'flex-start', paddingBottom: theme.spacing.xs } });
