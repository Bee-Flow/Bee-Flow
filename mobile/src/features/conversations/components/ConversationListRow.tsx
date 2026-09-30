/**
 * One row of the conversation list: a direct chat (pinned or not), or an agent
 * chat with the same avatar the Agents screen draws, so a row here is
 * recognisably the same thing as a row there. Like the drawer's chat row, a
 * long-press or the trailing "more" button opens rename, pin and delete
 * (ConversationMenu).
 */

import { useRouter } from 'expo-router';
import React, { useContext } from 'react';

import { timeAgo, useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { AgentAvatar } from '@/features/agents';
import { Icon, IconButton, ListRow } from '@/shared/ui';

import { ConversationMenuContext } from './ConversationMenu';
import type { ConversationRow } from '../model/grouping';

export function ConversationListRow({ item }: { item: ConversationRow }) {
    const theme = useTheme();
    const router = useRouter();
    const t = useTranslation();
    const openMenu = useContext(ConversationMenuContext);
    const title = item.title || t('mobile.chats.untitled', 'Untitled chat');
    const menu = {
        onLongPress: () => openMenu(item),
        trailing: (
            <IconButton
                icon={<Icon name="Ellipsis" size={16} color={theme.colors.textTertiary} />}
                accessibilityLabel={t('mobile.nav.chat_actions', 'Actions for {title}', { title })}
                onPress={() => openMenu(item)}
            />
        ),
        testID: `conversation-${item.id}`,
    };

    if ('agent_id' in item) {
        return (
            <ListRow
                title={title}
                subtitle={item.agent_name ?? t('chat.composer.agent_fallback', 'Agent')}
                meta={timeAgo(item.updated_at)}
                leading={
                    <AgentAvatar
                        name={item.agent_name ?? t('chat.composer.agent_fallback', 'Agent')}
                        avatar={item.agent_avatar}
                        size={28}
                    />
                }
                onPress={() =>
                    router.push(`/agents/${encodeURIComponent(item.agent_id)}?c=${encodeURIComponent(item.id)}`)
                }
                {...menu}
            />
        );
    }

    return (
        <ListRow
            title={title}
            meta={timeAgo(item.updated_at)}
            leading={
                item.pinned ? (
                    <Icon name="Bookmark" size={16} color={theme.colors.accentText} />
                ) : (
                    <Icon name="MessageCircle" size={16} color={theme.colors.textMuted} />
                )
            }
            onPress={() => router.push(`/chat/${item.id}`)}
            {...menu}
        />
    );
}
