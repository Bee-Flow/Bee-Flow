/** A note's tags as chips, with the owner's way to change them (agent-hub TagRow.jsx). */

import React from 'react';
import { StyleSheet, View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { Badge, Button } from '@/shared/ui';

const styles = StyleSheet.create({
    row: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6 },
});

export function MeetingTags({
    tags,
    onEdit,
}: {
    tags: readonly string[];
    /** Present for the owner only: the route answers 404 to anyone else. */
    onEdit?: () => void;
}) {
    const t = useTranslation();
    if (!tags.length && !onEdit) return null;
    return (
        <View style={styles.row}>
            {tags.map((tag) => (
                <Badge key={tag} label={tag} />
            ))}
            {onEdit ? (
                <Button
                    label={t('meetings.add_tag', 'Add tag')}
                    variant="ghost"
                    size="sm"
                    iconName={tags.length ? 'Pen' : 'Plus'}
                    onPress={onEdit}
                />
            ) : null}
        </View>
    );
}
