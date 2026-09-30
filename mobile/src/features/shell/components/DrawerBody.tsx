/**
 * The drawer's scrolling middle — the web Sidebar's scroll region: the
 * secondary nav, Projects and My Agents scroll away above the chats, which
 * are grouped Pinned / Today / Yesterday / Last 30 days / Older under the
 * web's group headings (10px bold, widest tracking; Pinned in the accent,
 * behind a tilted pin).
 *
 * ONE virtualised SectionList for all of it: the chats can run to hundreds,
 * and everything above them rides along as the list's header, so there is a
 * single scroll and only the chat rows on screen are built. The header's own
 * lists are capped (DRAWER_LIST_CAP) for the same reason.
 */

import React, { useCallback, useState } from 'react';
import { SectionList, View, type SectionListData, type SectionListRenderItem, type TextStyle, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { ChatActions, useConversations, type ConversationSummary } from '@/features/chat';
import { Icon, Text } from '@/shared/ui';

import { ChatMenuContext, ChatRow } from './ChatRow';
import { DrawerListFooter, DrawerListHeader } from './DrawerListHeader';
import { groupChats, type ChatGroupId } from '../model/chatGroups';

interface ChatSection {
    id: ChatGroupId;
    data: ConversationSummary[];
}

const GROUP_LABEL: Record<ChatGroupId, [string, string]> = {
    pinned: ['sidebar.pinned', 'Pinned'],
    today: ['sidebar.today', 'Today'],
    yesterday: ['sidebar.yesterday', 'Yesterday'],
    month: ['sidebar.last_30_days', 'Last 30 days'],
    older: ['sidebar.older', 'Older'],
};

const keyOf = (chat: ConversationSummary) => chat.id;
const renderChat: SectionListRenderItem<ConversationSummary, ChatSection> = ({ item }) => <ChatRow conversation={item} />;

function GroupHeading({ id }: { id: ChatGroupId }) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const [key, fallback] = GROUP_LABEL[id];
    const pinned = id === 'pinned';
    return (
        <View style={styles.heading}>
            {pinned ? <Icon name="Pin" size={11} color={styles.pinned.color} style={styles.tilt} /> : null}
            <Text
                variant="label"
                weight="bold"
                style={[styles.headingText, pinned ? styles.pinned : null]}
                numberOfLines={1}
                accessibilityRole="header"
            >
                {t(key, fallback)}
            </Text>
        </View>
    );
}

const renderHeading = ({ section }: { section: SectionListData<ConversationSummary, ChatSection> }) => (
    <GroupHeading id={section.id} />
);

export function DrawerBody() {
    const styles = useThemedStyles(makeStyles);
    const chats = useConversations().data ?? [];
    const [target, setTarget] = useState<ConversationSummary | null>(null);
    const [menuOpen, setMenuOpen] = useState(false);
    const sections: ChatSection[] = groupChats(chats);
    // Read by every chat row: one function for the list's lifetime.
    const openMenu = useCallback((conversation: ConversationSummary) => {
        setTarget(conversation);
        setMenuOpen(true);
    }, []);

    return (
        <ChatMenuContext.Provider value={openMenu}>
            <SectionList
                sections={sections}
                keyExtractor={keyOf}
                renderItem={renderChat}
                renderSectionHeader={renderHeading}
                stickySectionHeadersEnabled={false}
                ListHeaderComponent={DrawerListHeader}
                ListFooterComponent={DrawerListFooter}
                contentContainerStyle={styles.content}
                initialNumToRender={20}
                testID="drawer-list"
            />
            {target ? (
                <ChatActions
                    key={target.id}
                    conversation={target}
                    menuOpen={menuOpen}
                    onCloseMenu={() => setMenuOpen(false)}
                    onClose={() => setTarget(null)}
                />
            ) : null}
        </ChatMenuContext.Provider>
    );
}

const makeStyles = (theme: Theme) => ({
    content: { paddingHorizontal: theme.spacing[2], paddingBottom: theme.spacing[4] } satisfies ViewStyle,
    heading: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.spacing[1],
        paddingHorizontal: theme.spacing[3],
        paddingTop: theme.spacing[3],
        paddingBottom: theme.spacing[1],
    } satisfies ViewStyle,
    // The web's text-[10px] font-bold uppercase tracking-widest (.1em), at the
    // phone's 11px floor; uppercase by style, so a screen reader reads a word.
    headingText: { color: theme.colors.textTertiary, textTransform: 'uppercase', letterSpacing: 1.1 } satisfies TextStyle,
    pinned: { color: theme.colors.accentText } satisfies TextStyle,
    tilt: { transform: [{ rotate: '-45deg' }] } satisfies ViewStyle,
});
