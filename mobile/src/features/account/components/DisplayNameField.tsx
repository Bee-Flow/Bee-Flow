/**
 * The display name, editable in place: colleagues see it on shared chats and
 * in the member list. The save button appears only once there is a real change.
 */

import React, { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { describeError } from '@/core/api/errors';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Button, TextField, useToast } from '@/shared/ui';

import { useUpdateProfile } from '../hooks/mutations';
import { nameChanged } from '../model/profile';

export function DisplayNameField({ current }: { current: string }) {
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const [name, setName] = useState(current);
    const save = useUpdateProfile();
    const dirty = nameChanged(name, current);

    const saveName = () =>
        save.mutate(
            { displayName: name.trim() },
            { onSuccess: () => toast('Name updated', 'success') },
        );

    return (
        <View style={styles.field}>
            <TextField
                label="Display name"
                value={name}
                onChangeText={setName}
                autoCapitalize="words"
                maxLength={200}
                returnKeyType="done"
                onSubmitEditing={() => dirty && saveName()}
                error={save.isError ? describeError(save.error).message : null}
            />
            {dirty ? (
                <Button label="Save name" onPress={saveName} loading={save.isPending} fullWidth />
            ) : null}
        </View>
    );
}

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        field: { padding: theme.spacing.lg, gap: theme.spacing.md },
    });
