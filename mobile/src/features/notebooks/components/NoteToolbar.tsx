/**
 * The notes editor's formatting row, above the keyboard. Each button is a
 * Markdown edit (model/markdownEdit.ts) named in the web toolbar's words.
 * Lucide has no bold or italic glyph in the app's set, so those two are
 * letters in their own weight, as on most phone keyboards.
 */

import React from 'react';
import { Pressable, ScrollView, StyleSheet } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text, type IconName } from '@/shared/ui';

import type { MarkdownFormat } from '../model/markdownEdit';

const LETTER: Partial<Record<MarkdownFormat, string>> = { bold: 'B', italic: 'I' };
/** Pairs, not an object: these are glyph names, not words on screen. */
const GLYPH = new Map<MarkdownFormat, IconName>([
    ['heading', 'Type'],
    ['bullet', 'List'],
    ['numbered', 'ListOrdered'],
    ['task', 'ListChecks'],
    ['quote', 'Quote'],
]);
const ORDER: MarkdownFormat[] = ['heading', 'bold', 'italic', 'bullet', 'numbered', 'task', 'quote'];

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        row: { flexGrow: 0, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.colors.borderSubtle },
        content: { paddingHorizontal: theme.spacing.sm, gap: theme.spacing.xs, alignItems: 'center' },
        button: {
            minWidth: theme.minTouch,
            height: theme.minTouch,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: theme.radii.sm,
        },
        pressed: { backgroundColor: theme.colors.bgTertiary },
        bold: { fontWeight: '700' },
        italic: { fontStyle: 'italic' },
    });

function useLabels(): Record<MarkdownFormat, string> {
    const t = useTranslation();
    return {
        heading: t('notebooks.heading_2', 'Heading 2'),
        bold: t('notebooks.bold', 'Bold'),
        italic: t('notebooks.italic', 'Italic'),
        bullet: t('notebooks.bullet_list', 'Bullet list'),
        numbered: t('notebooks.numbered_list', 'Numbered list'),
        task: t('notebooks.task_list', 'Task list'),
        quote: t('notebooks.blockquote', 'Quote'),
    };
}

export function NoteToolbar({ onFormat }: { onFormat: (format: MarkdownFormat) => void }) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const labels = useLabels();
    return (
        <ScrollView
            horizontal
            keyboardShouldPersistTaps="always"
            showsHorizontalScrollIndicator={false}
            style={styles.row}
            contentContainerStyle={styles.content}
            accessibilityLabel={t('notebooks.toolbar', 'Editor toolbar')}
        >
            {ORDER.map((format) => {
                const glyph = GLYPH.get(format);
                return (
                    <Pressable
                        key={format}
                        onPress={() => onFormat(format)}
                        accessibilityRole="button"
                        accessibilityLabel={labels[format]}
                        style={({ pressed }) => [styles.button, pressed ? styles.pressed : null]}
                    >
                        {glyph ? (
                            <Icon name={glyph} size={18} color={theme.colors.textSecondary} />
                        ) : (
                            <Text variant="body" tone="secondary" style={format === 'bold' ? styles.bold : styles.italic}>
                                {LETTER[format]}
                            </Text>
                        )}
                    </Pressable>
                );
            })}
        </ScrollView>
    );
}
