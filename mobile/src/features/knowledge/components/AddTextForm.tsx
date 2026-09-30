/**
 * The paste-text door of the add sheet: for when you have the words but not
 * the file. Controlled by AddSourceBody, like the link door.
 */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, TextField } from '@/shared/ui';

const makeStyles = (theme: Theme) => StyleSheet.create({ form: { gap: theme.spacing.lg } });

export interface TextDraft {
    text: string;
    name: string;
}

export function AddTextForm({
    draft,
    onChange,
    busy,
    onText,
    onBack,
}: {
    draft: TextDraft;
    onChange: (next: TextDraft) => void;
    busy: boolean;
    onText: (text: string, name: string) => void;
    onBack: () => void;
}) {
    const styles = useThemedStyles(makeStyles);

    return (
        <View style={styles.form}>
            <TextField
                label="Title"
                value={draft.name}
                onChangeText={(name) => onChange({ ...draft, name })}
                placeholder="Meeting notes"
            />
            <TextField
                label="Text"
                value={draft.text}
                onChangeText={(text) => onChange({ ...draft, text })}
                multiline
                maxLines={10}
                placeholder="Paste anything you want this to know about."
            />
            <Button
                label="Add text"
                fullWidth
                loading={busy}
                disabled={draft.text.trim().length < 3}
                onPress={() => {
                    onText(draft.text.trim(), draft.name.trim() || 'Pasted text');
                    onChange({ text: '', name: '' });
                }}
            />
            <Button label="Back" variant="ghost" onPress={onBack} />
        </View>
    );
}
