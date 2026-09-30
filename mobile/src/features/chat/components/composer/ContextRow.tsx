/**
 * The row above the input: only what is ON, each chip tappable to remove.
 *
 * Renders nothing when there is nothing on, which is the point — an empty
 * composer is an empty composer, not a row of dormant switches. (There is no
 * web-search chip: the same switch sits in the ＋ sheet, and two controls for
 * one setting on a six-inch screen is worse than one where the web keeps it.)
 */

import React from 'react';
import { View } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { ChatContext } from '@/features/chat/model/types';
import { Chip, Icon } from '@/shared/ui';

const makeStyles = (theme: Theme) => ({
    row: { flexDirection: 'row' as const, flexWrap: 'wrap' as const, gap: theme.spacing.sm },
});

export function ContextRow({
    context,
    bases,
    activeSkillCount,
    onChange,
    onOpen,
}: {
    context: ChatContext;
    /** Names for the attached ids; a base still loading shows as "Knowledge base". */
    bases: { id: string; name: string }[];
    activeSkillCount: number;
    onChange: (next: ChatContext) => void;
    onOpen: () => void;
    /** See the `sources` note on ComposerProps. */
    sources?: boolean;
}) {
    const t = useTranslation();
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const nameOf = (id: string) => bases.find((b) => b.id === id)?.name ?? t('agent_studio.can_use.kb_unnamed', 'Knowledge base');

    // Nothing attached, nothing to draw. This row is a child of the composer
    // card, which lays its children out with a `gap` — so an empty <View> is
    // not free, it buys a blank line above the message box.
    if (context.knowledgeBaseIds.length === 0 && activeSkillCount === 0) return null;

    return (
        <View accessibilityLabel={t('mobile.chat.context_row', 'What this chat can use')} style={styles.row}>
            {context.knowledgeBaseIds.map((id) => (
                <Chip
                    key={id}
                    label={nameOf(id)}
                    selected
                    accessibilityHint={t('mobile.chat.kb_remove_hint', 'Removes this knowledge base from the chat')}
                    onPress={() =>
                        onChange({ ...context, knowledgeBaseIds: context.knowledgeBaseIds.filter((v) => v !== id) })
                    }
                    icon={<Icon name="X" size={12} color={theme.colors.accentText} />}
                />
            ))}
            {activeSkillCount > 0 ? (
                <Chip
                    label={
                        activeSkillCount === 1
                            ? t('mobile.chat.skill_count_one', '1 skill')
                            : t('mobile.chat.skill_count', '{count} skills', { count: activeSkillCount })
                    }
                    selected
                    accessibilityHint={t('mobile.chat.context_open_hint', 'Opens what this chat can use')}
                    onPress={onOpen}
                    icon={<Icon name="Zap" size={12} color={theme.colors.accentText} />}
                />
            ) : null}
        </View>
    );
}
