/**
 * The "New" menu as a bottom sheet — the web's NewMenu.jsx on a phone: the AI
 * row first (tinted in the AI colour), then one item per kind this person may
 * make, under its Build / AI / Bundle heading, in its kind's colour. A locked
 * kind stays listed, disabled, with the reason — a signpost, not a door.
 * Choosing an item closes the sheet, then opens the create flow (model/newMenu.ts
 * says where each one goes); the AI row hands over to the host's `onDescribe`,
 * which opens the Describe-it sheet.
 */

import React from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';

import { lockHint } from '@/core/access';
import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, KindTile, SectionLabel, Sheet, Text, tint } from '@/shared/ui';

import { useOpenTarget } from '../hooks/useOpenTarget';
import { plainTarget } from '../model/links';
import type { NewMenuEntry } from '../model/newMenu';

export interface NewMenuSheetProps {
    visible: boolean;
    onClose: () => void;
    entries: readonly NewMenuEntry[];
    /** The AI row: the host swaps this sheet for the Describe-it one. */
    onDescribe: () => void;
}

type Item = Extract<NewMenuEntry, { type: 'item' | 'ai' }>;

export function NewMenuSheet({ visible, onClose, entries, onDescribe }: NewMenuSheetProps) {
    const t = useTranslation();
    const open = useOpenTarget();
    const choose = (entry: Item) => {
        onClose();
        if (entry.type === 'ai') onDescribe();
        else open(plainTarget(entry.target));
    };
    return (
        <Sheet visible={visible} onClose={onClose} title={t('studio.new.button', 'New')}>
            {entries.map((entry) =>
                entry.type === 'heading' ? (
                    <SectionLabel key={entry.id} label={t(entry.category.labelKey, entry.category.labelFallback)} />
                ) : (
                    <NewMenuRow key={entry.id} entry={entry} onChoose={choose} />
                ),
            )}
        </Sheet>
    );
}

function NewMenuRow({ entry, onChoose }: { entry: Item; onChoose: (entry: Item) => void }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const ai = entry.type === 'ai';
    const locked = entry.type === 'item' ? entry.locked : null;
    const hint = locked ? lockHint(locked, t) : undefined;
    return (
        <Pressable
            onPress={() => onChoose(entry)}
            disabled={Boolean(locked)}
            accessibilityRole="menuitem"
            accessibilityHint={hint}
            accessibilityState={{ disabled: Boolean(locked) }}
            testID={`new-menu-${entry.id}`}
            style={({ pressed }) => [styles.row, ai ? styles.ai : null, pressed ? styles.pressed : null, locked ? styles.locked : null]}
        >
            {entry.type === 'item' ? (
                <KindTile kind={entry.kind} icon={entry.kind ? undefined : entry.icon} size={28} />
            ) : (
                <Icon name="Sparkles" size={18} color={theme.colors.typeAi} />
            )}
            <View style={styles.words}>
                <Text variant="body" weight={ai ? 'semibold' : 'regular'} style={ai ? styles.aiText : null} numberOfLines={2}>
                    {t(entry.labelKey, entry.labelFallback)}
                </Text>
                {hint ? (
                    <Text variant="label" tone="tertiary">
                        {hint}
                    </Text>
                ) : null}
            </View>
            {locked ? <Icon name="Lock" size={14} color={theme.colors.textTertiary} /> : null}
        </Pressable>
    );
}

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[3],
        minHeight: theme.minTouch,
        paddingHorizontal: theme.spacing[3],
        borderRadius: theme.radii.sm,
    } satisfies ViewStyle,
    ai: { backgroundColor: tint(theme.colors.typeAi, 10), marginBottom: theme.spacing[1] } satisfies ViewStyle,
    aiText: { color: theme.colors.typeAi },
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    locked: { opacity: 0.6 } satisfies ViewStyle,
    words: { flex: 1, gap: 2 } satisfies ViewStyle,
});
