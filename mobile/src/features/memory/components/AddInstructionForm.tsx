/** Tell Bee Flow something to always remember, as a standing instruction. */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Banner, Button, TextField, useToast } from '@/shared/ui';

import { useAddInstruction } from '../hooks/mutations';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        form: { paddingHorizontal: theme.spacing.lg, gap: theme.spacing.md },
        buttons: { flexDirection: 'row', gap: theme.spacing.sm },
        half: { flex: 1 },
    });

export function AddInstructionForm({ onClose }: { onClose: () => void }) {
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const [draft, setDraft] = useState('');
    const add = useAddInstruction({
        onSuccess: () => {
            toast('Saved', 'success');
            setDraft('');
            onClose();
        },
    });

    return (
        <View style={styles.form}>
            <TextField
                label="Always remember"
                value={draft}
                onChangeText={setDraft}
                multiline
                maxLines={5}
                autoFocus
                placeholder="Answer in Dutch unless I write in English."
                hint="Stored as an instruction. Every agent that reads your memory will see it."
            />
            <View style={styles.buttons}>
                <Button
                    label="Save"
                    onPress={() => add.mutate(draft.trim())}
                    loading={add.isPending}
                    disabled={draft.trim().length < 3}
                    style={styles.half}
                />
                <Button
                    label="Cancel"
                    variant="ghost"
                    onPress={() => {
                        onClose();
                        setDraft('');
                    }}
                    style={styles.half}
                />
            </View>
            {add.isError ? <Banner tone="error">{describeError(add.error).message}</Banner> : null}
        </View>
    );
}
