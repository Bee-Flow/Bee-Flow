/**
 * The meeting's action items, with a checkbox the owner can tap. A bounded
 * list (what one meeting produced), so it renders inline above the transcript.
 */

import React from 'react';

import { useTheme } from '@/core/theme/ThemeProvider';
import { Card, Icon, ListRow, Section } from '@/shared/ui';

import type { ActionItem } from '../model/types';

export function ActionItemsSection({
    items,
    onToggle,
}: {
    items: ActionItem[];
    /** Absent when the viewer does not own the note. */
    onToggle?: (index: number) => void;
}) {
    const theme = useTheme();
    if (items.length === 0) return null;
    return (
        <Section title="Action items">
            <Card padded={false}>
                {items.map((item, index) => (
                    <ListRow
                        key={`${index}-${item.text}`}
                        title={item.text}
                        wrapTitle
                        subtitle={[item.assignee, item.due, item.timestamp].filter(Boolean).join(' · ')}
                        onPress={onToggle ? () => onToggle(index) : undefined}
                        chevron={false}
                        leading={
                            <Icon
                                name={item.done ? 'SquareCheckBig' : 'Square'}
                                size={18}
                                color={item.done ? theme.colors.success : theme.colors.textMuted}
                            />
                        }
                    />
                ))}
            </Card>
        </Section>
    );
}
