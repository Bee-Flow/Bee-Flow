/**
 * Chats — the conversations shared INTO the project by their owners (the
 * web's Chats tab). Bounded by the query (50 threads). Agent conversations
 * are counted, not listed: GET /api/projects/:id/threads returns no agent id
 * for them (stores/agent/sharedConversations.listProjectThreads), and the
 * agent chat (/agents/<agentId>?c=<id>) cannot open one without it — the web
 * row is a dead click for the same reason (AgentHub onOpenThread wants
 * `thread.agentId`). When the server adds it, route them there.
 *
 * Sharing re-encrypts a conversation for the project, which only its owner
 * can do, from the conversation itself — so there is no "share" here.
 */

import { useRouter } from 'expo-router';
import React from 'react';

import { describeError } from '@/core/api/errors';
import { useTranslation } from '@/core/i18n';
import { useTheme } from '@/core/theme/ThemeProvider';
import { relativeTime } from '@/shared/lib/time';
import { openRoute } from '@/shared/navigation';
import { cardRows, type Block } from '@/shared/patterns';
import { Banner, Button, Icon, ListRow, LoadingState } from '@/shared/ui';

import { Strip } from './Strip';
import { block, TabBlocks } from './TabBlocks';
import { useProjectThreads } from '../hooks/queries';
import type { ProjectThread } from '../model/types';
import { byCount } from '../model/words';

function ChatRow({ thread }: { thread: ProjectThread }) {
    const t = useTranslation();
    const theme = useTheme();
    const router = useRouter();
    return (
        <ListRow
            title={thread.title || t('mobile.projects.untitled_chat', 'Untitled chat')}
            meta={thread.updatedAt ? relativeTime(thread.updatedAt) : undefined}
            leading={<Icon name="MessageCircle" size={16} color={theme.colors.textMuted} />}
            onPress={() => router.push(`/chat/${encodeURIComponent(thread.id)}`)}
        />
    );
}

export function ChatsTab({ id }: { id: string }) {
    const t = useTranslation();
    const router = useRouter();
    const threads = useProjectThreads(id);
    if (threads.isLoading) return <LoadingState />;

    const all = threads.data ?? [];
    const chats = all.filter((thread) => thread.type === 'direct');
    const agentChats = all.length - chats.length;
    const a = { count: agentChats };
    const blocks: Block[] = [
        ...(threads.isError ? [block('error', () => <Banner tone="error">{describeError(threads.error).message}</Banner>, 'none')] : []),
        ...(chats.length === 0 && !threads.isError
            ? [block('none', () => <Strip tone="quiet">{t('projects.no_shared_threads', 'No shared conversations yet. Share one to work on it together.')}</Strip>, 'none')]
            : cardRows({ key: 'chats', rows: chats, rowKey: (thread) => thread.id, render: (thread) => <ChatRow thread={thread} />, gap: 'none' })),
        ...(agentChats > 0
            ? [block('agents', () => (
                  <Strip tone="muted">
                      {byCount(agentChats, t('mobile.projects.agent_chats_shared', '{count} agent conversation is also shared here.', a), t('mobile.projects.agent_chats_shared_plural', '{count} agent conversations are also shared here.', a))}
                  </Strip>
              ), 'inner')]
            : []),
        block('hint', () => <Strip tone="quiet">{t('projects.shared_threads_editor_hint', 'Everyone in this project can read these. Editors can reply.')}</Strip>, 'inner'),
        block('open-chat', () => (
            <Button label={t('mobile.projects.open_chat', 'Open a chat')} variant="secondary" iconName="MessageSquare" onPress={() => openRoute(router, '/')} fullWidth />
        )),
    ];
    return <TabBlocks blocks={blocks} onRefresh={() => threads.refetch()} />;
}
