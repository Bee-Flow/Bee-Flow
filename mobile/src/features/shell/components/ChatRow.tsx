/**
 * One chat in the drawer — the web's ConvRow at a phone's touch height: the
 * title in the row's secondary ink at the web's 14px step (the phone's body
 * size), a tilted pin on a pinned chat, and a trailing "more" button
 * (long-press does the same) that opens rename, pin and delete.
 *
 * A list cell, so memoised: the list re-renders when the chats change, and a
 * row whose conversation did not change has nothing to redraw.
 */

import React, { createContext, memo, useContext } from 'react';
import { Pressable, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { ConversationSummary } from '@/features/chat';
import { Icon, IconButton, Text } from '@/shared/ui';

import { useDrawerActions } from '../hooks/drawerActions';

/** How a row asks for its menu; provided by the chat list so rows can be rendered outside it. */
export const ChatMenuContext = createContext<(conversation: ConversationSummary) => void>(() => undefined);

export const ChatRow = memo(function ChatRow({ conversation }: { conversation: ConversationSummary }) {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const { push } = useDrawerActions();
    const openMenu = useContext(ChatMenuContext);
    const title = conversation.title || t('sidebar.untitled_chat', 'Untitled Chat');
    return (
        <Pressable
            onPress={() => push(`/chat/${encodeURIComponent(conversation.id)}`)}
            onLongPress={() => openMenu(conversation)}
            accessibilityRole="link"
            accessibilityLabel={title}
            style={({ pressed }) => [styles.row, pressed ? styles.pressed : null]}
            testID={`drawer-chat-${conversation.id}`}
        >
            {conversation.pinned ? <Icon name="Pin" size={12} color={theme.colors.accentText} style={styles.tilt} /> : null}
            <Text variant="body" style={styles.title} numberOfLines={1}>
                {title}
            </Text>
            <IconButton
                icon={<Icon name="Ellipsis" size={16} color={theme.colors.textTertiary} />}
                accessibilityLabel={t('mobile.nav.chat_actions', 'Actions for {title}', { title })}
                onPress={() => openMenu(conversation)}
                style={styles.more}
            />
        </Pressable>
    );
});

const makeStyles = (theme: Theme) => ({
    row: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[1.5],
        minHeight: 44,
        paddingLeft: theme.spacing[3],
        borderRadius: theme.radii.sm,
    } satisfies ViewStyle,
    pressed: { backgroundColor: theme.colors.itemHoverBg } satisfies ViewStyle,
    title: { flex: 1, color: theme.colors.textSecondary } satisfies TextStyle,
    tilt: { transform: [{ rotate: '-45deg' }] } satisfies ViewStyle,
    // The row is the 44dp target; the button keeps its 48dp hit area without growing the row.
    more: { width: 40, height: 40 } satisfies ViewStyle,
});
