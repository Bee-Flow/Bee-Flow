/**
 * Edit a note's tags: remove one with a tap, type new ones (commas split
 * them), or pick from the tags already used elsewhere — the vocabulary the
 * library's chips count, so a tag is spelled the same way twice.
 */

import React, { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { FormSheet } from '@/shared/patterns';
import { Chip, Icon, Text, TextField } from '@/shared/ui';

import { useSetTags, useTranscriptionTags } from '../hooks/library';
import { useOnOpen } from '../hooks/useOnOpen';
import { addTags, removeTag, sameTags, suggestedTags, withTag } from '../model/tags';

const styles = StyleSheet.create({
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
    stack: { gap: 8 },
});

/** Enough to choose from without turning the sheet into a second library. */
const MAX_SUGGESTIONS = 12;

export function TagsSheet({
    visible,
    noteId,
    tags,
    onClose,
}: {
    visible: boolean;
    noteId: string;
    tags: readonly string[];
    onClose: () => void;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const save = useSetTags(noteId);
    const vocabulary = useTranscriptionTags(visible);
    const [draft, setDraft] = useState<string[]>([...tags]);
    const [input, setInput] = useState('');
    const { reset } = save;

    // Re-seed when the sheet opens, not on every refetch while it is open.
    useOnOpen(visible, () => {
        setDraft([...tags]);
        setInput('');
    });
    // The last save's error belongs to the last opening.
    useEffect(() => {
        if (visible) reset();
    }, [visible, reset]);

    // Whatever is still typed counts too: nobody expects to press Enter first.
    const next = addTags(draft, input);
    const suggestions = suggestedTags(vocabulary.data ?? [], next).slice(0, MAX_SUGGESTIONS);
    const submit = () => save.mutate(next, { onSuccess: onClose });

    return (
        <FormSheet
            visible={visible}
            onClose={onClose}
            title={t('meetings.add_tag', 'Add tag')}
            submitLabel={t('common.save', 'Save')}
            onSubmit={submit}
            canSubmit={!sameTags(next, tags)}
            submitting={save.isPending}
            error={save.error}
        >
            {draft.length > 0 ? (
                <View style={styles.chips}>
                    {draft.map((tag) => (
                        <Chip
                            key={tag}
                            label={tag}
                            selected
                            icon={<Icon name="X" size={12} color={theme.colors.textSecondary} />}
                            accessibilityHint={t('meetings.remove_tag', 'Remove tag {tag}', { tag })}
                            onPress={() => setDraft(removeTag(draft, tag))}
                        />
                    ))}
                </View>
            ) : null}
            <TextField
                value={input}
                onChangeText={setInput}
                placeholder={t('meetings.add_tag_placeholder', 'Add tag…')}
                autoCapitalize="none"
                returnKeyType="done"
                onSubmitEditing={() => {
                    setDraft(addTags(draft, input));
                    setInput('');
                }}
            />
            {suggestions.length > 0 ? (
                <View style={styles.stack}>
                    <Text variant="label" tone="tertiary">
                        {t('mobile.recording.tags_used_elsewhere', 'Used on other meetings')}
                    </Text>
                    <View style={styles.chips}>
                        {suggestions.map((tag) => (
                            <Chip key={tag} label={tag} onPress={() => setDraft(withTag(draft, tag))} />
                        ))}
                    </View>
                </View>
            ) : null}
        </FormSheet>
    );
}
