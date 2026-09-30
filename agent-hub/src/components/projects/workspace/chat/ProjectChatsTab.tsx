// The Chats tab of a project workspace: every conversation of the project in
// one list — team chats, AI chats members shared, and the caller's own AI
// chats filed here that are still private — with a filter, "New chat", and
// Share / Stop sharing for the chats the caller owns. With `sub` set (a team
// chat id) the tab shows that chat instead.

import { Archive, MessageSquare, Plus, Search, RotateCcw } from 'lucide-react';
import React, { useCallback, useMemo, useState } from 'react';
import { useShareThread } from '../../../../api/queries/projects';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import EmptyState from '../../../shared/EmptyState';
import SegmentedControl from '../../../shared/SegmentedControl';
import { toast } from '../../../shared/Toast';
import useConfirm from '../../../shared/useConfirm';
import { projectErrorText } from '../projectErrorText';
import { StudioSectionHeader } from '../studioParts';
import { THREAD_SEP } from '../tasks/taskLinks';
import { useTaskDialog } from '../tasks/useTaskDialog';
import { canEditProject, type ChatsTabProps } from '../types';
import { GhostButton, INPUT_CLASS, LoadingRow, Notice, PrimaryButton } from '../workspaceUi';
import ChatListRow, { type ChatRowContext } from './ChatListRow';
import { useChatPeople } from './chatPeople';
import NewChatComposer, { type NewChatMode } from './NewChatComposer';
import { hasUnread } from '../../../../api/queries/projectChats';
import ProjectTeamChat from './ProjectTeamChat';
import { useChatList, type ChatListFilter, type ChatListItem } from './useChatList';
import { useAnsweringIds } from './useTeamChatLive';

type ListSources = ReturnType<typeof useChatList>['sources'];

/** Share asks first (sharing re-encrypts the chat for the project); stopping does not. */
function useShareFlow(projectId: string) {
    const { t } = useTranslation();
    const { confirm, confirmDialog } = useConfirm();
    const { mutate } = useShareThread(projectId);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const onShare = useCallback(async (item: ChatListItem, share: boolean) => {
        if (item.kind !== 'ai') return;
        if (share) {
            const ok = await confirm({
                title: t('project_chat.share_title', 'Share this chat with the project?'),
                description: t('project_chat.share_body', 'Every member can then read it, and editors can continue it. It is encrypted with the project key instead of your own; your other chats stay private.'),
                confirmLabel: t('project_chat.share', 'Share with members'),
                cancelLabel: t('project_chat.cancel', 'Cancel'),
            });
            if (!ok) return;
        }
        setBusyKey(item.key);
        mutate({ conversationId: item.id, type: item.type, share }, {
            onError: e => toast.error(projectErrorText(t, e)),
            onSettled: () => setBusyKey(null),
        });
    }, [confirm, mutate, t]);
    return { onShare, busyKey, confirmDialog };
}

function SourceErrors({ sources }: { sources: ListSources }) {
    const { t } = useTranslation();
    const failed: Array<{ key: string; text: string; retry: () => void }> = [];
    if (sources.team.isError) failed.push({ key: 'team', text: t('project_chat.team_failed', 'Could not load the team chats.'), retry: () => sources.team.refetch() });
    if (sources.threads.isError) failed.push({ key: 'threads', text: t('project_chat.shared_failed', 'Could not load the shared AI chats.'), retry: () => sources.threads.refetch() });
    if (sources.mine.isError) failed.push({ key: 'mine', text: t('project_chat.mine_failed', 'Could not load your own chats in this project.'), retry: () => sources.mine.refetch() });
    if (!failed.length) return null;
    return (
        <div className="space-y-2">
            {failed.map(f => (
                <Notice key={f.key} tone="error" role="alert" testId={`chats-error-${f.key}`}
                    action={<GhostButton onClick={f.retry}><RotateCcw className="w-3 h-3" aria-hidden="true" />{t('project_chat.retry', 'Try again')}</GhostButton>}>
                    {f.text}
                </Notice>
            ))}
        </div>
    );
}

function emptyCopy(filter: ChatListFilter, canEdit: boolean, t: TranslateFn) {
    if (filter === 'team') return { title: t('project_chat.empty_team_title', 'No team chats yet'), body: t('project_chat.empty_team_body', 'A team chat is where members talk things through. The AI answers when someone mentions it.') };
    if (filter === 'ai') return { title: t('project_chat.empty_ai_title', 'No AI chats here yet'), body: t('project_chat.empty_ai_body', 'AI chats you start in this project use its instructions and knowledge. Share one to work on it together.') };
    return {
        title: t('project_chat.empty_title_all', 'No chats in this project yet'),
        body: canEdit
            ? t('project_chat.empty_unified', 'Start a conversation with your project members. Mention @AI whenever you need help.')
            : t('project_chat.empty_body_viewer', 'Chats the members start or share will show up here.'),
    };
}

function ChatRows({ items, ctx, answering, label }: { items: ChatListItem[]; ctx: ChatRowContext; answering: ReadonlySet<string>; label: string }) {
    return (
        <ul className="list-none m-0 p-0 rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] overflow-hidden" aria-label={label}>
            {items.map(item => <ChatListRow key={item.key} item={item} ctx={ctx} answering={answering.has(item.id)} />)}
        </ul>
    );
}

/** Archived team chats, on request. A list that failed to load says so and offers a retry: never "none". */
function ArchivedSection({ show, onToggle, items, source, ctx, answering }: {
    show: boolean; onToggle: () => void; items: ChatListItem[]; source: ListSources['archived']; ctx: ChatRowContext; answering: ReadonlySet<string>;
}) {
    const { t } = useTranslation();
    const loading = source.isPending;
    const failed = source.isError && !items.length;
    return (
        <section className="space-y-2">
            <GhostButton onClick={onToggle} aria-expanded={show} data-testid="chats-archived-toggle">
                <Archive className="w-3.5 h-3.5" aria-hidden="true" />
                {show ? t('project_chat.hide_archived', 'Hide archived team chats') : t('project_chat.show_archived', 'Show archived team chats')}
            </GhostButton>
            {show && loading && <LoadingRow label={t('project_chat.loading', 'Loading chats…')} />}
            {show && failed && (
                <Notice tone="error" role="alert" testId="chats-error-archived"
                    action={<GhostButton onClick={() => source.refetch()}><RotateCcw className="w-3 h-3" aria-hidden="true" />{t('project_chat.retry', 'Try again')}</GhostButton>}>
                    {t('project_chat.archived_failed', 'Could not load the archived team chats.')}
                </Notice>
            )}
            {show && !loading && !failed && !items.length && (
                <p className="m-0 px-3 py-2.5 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-tertiary)]">{t('project_chat.no_archived', 'No archived team chats.')}</p>
            )}
            {show && items.length > 0 && <ChatRows items={items} ctx={ctx} answering={answering} label={t('project_chat.archived_list', 'Archived team chats')} />}
        </section>
    );
}

type ConversationFilter = 'all' | 'unread' | 'shared' | 'private';
function visibleChats(items: ChatListItem[], filter: ConversationFilter, search = '') {
    const needle = search.trim().toLocaleLowerCase();
    return items.filter(i => (!needle || `${i.title} ${i.kind === 'team' ? i.chat.lastMessage?.excerpt || '' : ''}`.toLocaleLowerCase().includes(needle))
        && (filter === 'all' || (filter === 'unread' && i.kind === 'team' && hasUnread(i.chat))
            || (filter === 'shared' && (i.kind === 'team' || i.shared)) || (filter === 'private' && i.kind === 'ai' && !i.shared)));
}
function FilterBar({ filter, onChange, items, loading }: { filter: ConversationFilter; onChange: (f: ConversationFilter) => void; items: ChatListItem[]; loading: boolean }) {
    const { t } = useTranslation();
    return <SegmentedControl size="sm" value={filter} onChange={onChange} ariaLabel={t('project_chat.filter_label', 'Show')}
        options={[
            { value: 'all', label: t('project_chat.filter_all', 'All'), badge: loading ? null : items.length },
            { value: 'unread', label: t('project_chat.filter_unread', 'Unread'), badge: loading ? null : visibleChats(items, 'unread').length },
            { value: 'shared', label: t('project_chat.filter_shared', 'Shared') },
            { value: 'private', label: t('project_chat.private', 'Private') },
        ]} />;
}

/** Loading, the rows, or an empty state that explains the feature — never "empty" when a source failed. */
function ChatsBody({ list, filter, search, canEdit, ctx, answering, onNew }: {
    list: ReturnType<typeof useChatList>; filter: ConversationFilter; search: string; canEdit: boolean;
    ctx: ChatRowContext; answering: ReadonlySet<string>; onNew: () => void;
}) {
    const { t } = useTranslation();
    const visible = visibleChats(list.items, filter, search);
    if (visible.length) return <ChatRows items={visible} ctx={ctx} answering={answering} label={t('project_chat.title', 'Chats')} />;
    if (!list.settled) return <LoadingRow label={t('project_chat.loading', 'Loading chats…')} />;
    if (list.failed) return null;
    if (search || filter !== 'all') return <EmptyState icon={<Search className="w-7 h-7" />} title={t('project_chat.no_matches', 'No conversations match')} description={t('project_chat.try_filter', 'Try another search or show all conversations.')} />;
    const empty = emptyCopy('all', canEdit, t);
    return (
        <EmptyState icon={<MessageSquare className="w-8 h-8" />} title={empty.title} description={empty.body}
            action={canEdit ? <PrimaryButton onClick={onNew}>{t('project_chat.new_chat', 'New chat')}</PrimaryButton> : undefined} />
    );
}

function useRowContext(props: ChatsTabProps, canEdit: boolean, share: ReturnType<typeof useShareFlow>) {
    const people = useChatPeople(props.projectId, props.currentUser);
    const { onOpenSub, onOpenThread } = props;
    return useMemo<ChatRowContext>(() => ({
        nameOf: people.nameOf, canShare: canEdit, busyKey: share.busyKey, onShare: share.onShare,
        onOpen: item => (item.kind === 'team' ? onOpenSub(item.id) : onOpenThread({ id: item.id, type: item.type, agentId: item.agentId })),
    }), [people.nameOf, canEdit, share.busyKey, share.onShare, onOpenSub, onOpenThread]);
}

function ChatsOverview(props: ChatsTabProps) {
    const { t } = useTranslation();
    const canEdit = canEditProject(props.role);
    const [filter, setFilter] = useState<ConversationFilter>('all');
    const [search, setSearch] = useState('');
    const [mode, setMode] = useState<NewChatMode | null>(props.intent === 'create' && canEdit ? 'team' : null);
    const [showArchived, setShowArchived] = useState(false);
    const list = useChatList(props.projectId, props.currentUser?.id || null, showArchived);
    const answering = useAnsweringIds();
    const share = useShareFlow(props.projectId);
    const ctx = useRowContext(props, canEdit, share);

    return (
        <div className="h-full flex flex-col min-h-0" data-testid="project-chats-tab">
            <StudioSectionHeader icon={MessageSquare} title={t('project_chat.title', 'Chats')} testId="project-chats-header"
                statusChip={list.loading ? null : String(list.items.length)} primary={canEdit ? <PrimaryButton onClick={() => setMode('team')}><Plus className="w-4 h-4" />{t('project_chat.new_chat', 'New chat')}</PrimaryButton> : undefined} />
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className="max-w-6xl mx-auto px-4 sm:px-8 py-6 space-y-5">
                    {mode && canEdit && (
                        <NewChatComposer mode={mode} project={props.project} onModeChange={setMode} onClose={() => setMode(null)}
                            onStartChat={props.onStartChat} onOpenTeamChat={id => props.onOpenSub(id)} />
                    )}
                    <div className="flex flex-wrap items-center gap-3 justify-between">
                        <div><h2 className="text-xl font-semibold m-0">{t('project_chat.conversations', 'Conversations')}</h2><p className="text-sm text-[var(--text-secondary)] mt-1">{t('project_chat.overview_hint', 'Your team, decisions and AI help in one place.')}</p></div>
                        <label className="relative w-full sm:w-72"><Search className="absolute left-3 top-3 w-4 h-4 text-[var(--text-tertiary)]" /><input type="search" value={search} onChange={e => setSearch(e.target.value)} className={`${INPUT_CLASS} pl-9`} placeholder={t('project_chat.search', 'Search conversations')} aria-label={t('project_chat.search', 'Search conversations')} /></label>
                    </div>
                    <FilterBar filter={filter} onChange={setFilter} items={list.items} loading={list.loading} />
                    <SourceErrors sources={list.sources} />
                    <ChatsBody list={list} filter={filter} search={search} canEdit={canEdit} ctx={ctx} answering={answering}
                        onNew={() => setMode('team')} />
                    {filter !== 'private' && (
                        <ArchivedSection show={showArchived} onToggle={() => setShowArchived(v => !v)} items={list.archivedItems}
                            source={list.sources.archived} ctx={ctx} answering={answering} />
                    )}
                </div>
            </div>
            {share.confirmDialog}
        </div>
    );
}

/** The route's sub-item: a chat id, or `chat_thread` to open a thread of it as well. */
function OpenTeamChat(props: ChatsTabProps & { sub: string }) {
    const [chatId, threadId] = props.sub.split(THREAD_SEP);
    const tasks = useTaskDialog(props);
    // Keyed by chat: moving to another chat starts clean (draft, reply, read marker).
    return (
        <>
            <ProjectTeamChat key={props.sub} projectId={props.projectId} project={props.project} role={props.role} currentUser={props.currentUser}
                chatId={chatId} initialThreadId={threadId || null} onBack={() => props.onOpenSub(null)} onNavigate={props.onNavigate}
                onOpenItem={(ref) => props.onOpenTab?.(ref.kind === 'notebook' ? 'notebooks' : ref.kind === 'meeting' ? 'meetings' : 'documents', ref.id)}
                onCreateTask={(links, title, description) => tasks.openNew(links, title, description)} />
            {tasks.dialog}
        </>
    );
}

export default function ProjectChatsTab(props: ChatsTabProps) {
    if (props.sub) return <OpenTeamChat {...props} sub={props.sub} />;
    return <ChatsOverview {...props} />;
}
