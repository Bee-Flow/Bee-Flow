// What a task can point at, and how to say it: the documents and notebooks
// filed in the project, its team chats, and threads inside those chats. One
// hook answers "what is this link called" and "what can be linked".

import { BookOpen, FileText, MessageSquare, MessageSquareReply, Mic } from 'lucide-react';
import { useMemo } from 'react';
import { useProjectChatsQuery } from '../../../../api/queries/projectChats';
import { linkKey, type TaskLink } from '../../../../api/queries/projectTasks';
import { useProjectResourcesQuery } from '../../../../api/queries/projects';
import { useTranslation } from '../../../../hooks/useTranslation';

export const LINK_ICON = { document: FileText, notebook: BookOpen, meeting: Mic, chat: MessageSquare, thread: MessageSquareReply } as const;

export interface LinkOption { link: TaskLink; label: string }

/** `chat_thread` addresses a thread inside a chat in the workspace route; a bare id is the chat. */
export const THREAD_SEP = '_';

/** Where a link opens inside the project: the tab, and the item in it. */
export function routeOfLink(link: TaskLink): { tab: 'documents' | 'chats' | 'notebooks' | 'meetings'; sub: string } {
    if (link.kind === 'document') return { tab: 'documents', sub: link.id };
    if (link.kind === 'notebook') return { tab: 'notebooks', sub: link.id };
    if (link.kind === 'meeting') return { tab: 'meetings', sub: link.id };
    if (link.kind === 'thread') return { tab: 'chats', sub: `${link.chatId}${THREAD_SEP}${link.id}` };
    return { tab: 'chats', sub: link.id };
}

export function useTaskLinks(projectId: string) {
    const { t } = useTranslation();
    const resources = useProjectResourcesQuery(projectId);
    const chats = useProjectChatsQuery(projectId);
    return useMemo(() => {
        const untitledChat = t('project_chat.untitled_team_chat', 'Team chat');
        const options: LinkOption[] = [];
        for (const [kind, section] of [['document', resources.data?.documents], ['notebook', resources.data?.notebooks], ['meeting', resources.data?.meetings]] as const) {
            for (const it of section || []) {
                const name = typeof it.name === 'string' ? it.name : typeof it.title === 'string' ? it.title : '';
                if (typeof it.id === 'string' && name) options.push({ link: { kind, id: it.id }, label: name });
            }
        }
        for (const c of chats.data?.chats || []) options.push({ link: { kind: 'chat', id: c.id }, label: c.title || untitledChat });
        const byKey = new Map(options.map(o => [linkKey(o.link), o.label]));
        const chatTitle = (id: string) => byKey.get(`chat:${id}`) || untitledChat;
        const labelOf = (link: TaskLink): string => {
            if (link.kind === 'thread') return t('project_tasks.thread_in', 'Thread in {chat}', { chat: chatTitle(link.chatId) });
            return byKey.get(linkKey(link)) || (link.kind === 'notebook'
                ? t('project_chat.ref_notebook', 'Notebook')
                : link.kind === 'document' ? t('project_chat.ref_document', 'Document')
                    : link.kind === 'meeting' ? t('project_tasks.meeting', 'Meeting') : untitledChat);
        };
        return { options, labelOf };
    }, [resources.data, chats.data, t]);
}
