/**
 * The next phase's brief — what the builder will be told. It is read far
 * more often than edited, so it opens rendered, with Edit one tap away. The
 * server may recompose it while the card is open (a redrawn design changes
 * the app's brief): a new brief from the server replaces the box, unless the
 * person has typed in it since.
 */

import React, { useState } from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Markdown } from '@/shared/markdown';
import { Button, Text, TextField } from '@/shared/ui';

/** What a brief may grow to (routes/playbooks/contract.js MAX_BRIEF: 1200 + 1800 + 600). */
const MAX_BRIEF = 3600;

export function BriefBox({ label, brief, value, onChange }: { label: string; brief: string; value: string; onChange: (text: string) => void }) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const [editing, setEditing] = useState(false);
    return (
        <View style={styles.box}>
            <View style={styles.head}>
                <Text variant="label" tone="secondary" style={styles.grow}>
                    {label}
                </Text>
                {!editing ? (
                    <Button size="sm" variant="ghost" iconName="Pencil" label={t('playbooks.handoff.brief_edit', 'Edit')} onPress={() => setEditing(true)} testID="playbook-brief-edit" />
                ) : null}
            </View>
            {editing ? (
                <TextField value={value} onChangeText={onChange} multiline maxLines={12} maxLength={MAX_BRIEF} autoCorrect={false} hint={`${value.length}/${MAX_BRIEF}`} testID="playbook-next-brief" />
            ) : (
                <View style={styles.preview} testID="playbook-brief-preview">
                    <Markdown value={value || brief} />
                </View>
            )}
        </View>
    );
}

const makeStyles = (theme: Theme) => ({
    box: { gap: theme.spacing[1.5] },
    head: { flexDirection: 'row' as const, alignItems: 'center' as const, gap: theme.spacing[2] },
    grow: { flex: 1 },
    preview: {
        maxHeight: 280,
        overflow: 'hidden' as const,
        padding: theme.spacing[3],
        borderRadius: theme.radii.sm,
        borderWidth: 1,
        borderColor: theme.colors.borderDefault,
        backgroundColor: theme.colors.bgPrimary,
    },
});
