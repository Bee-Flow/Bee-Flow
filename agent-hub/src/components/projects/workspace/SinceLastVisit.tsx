// "Since your last visit": what other people changed in the project while the
// reader was away, one row per item with who (and whether the AI helped), how
// much, and when; plus the team chats with messages they have not read.
//
// Quiet by design: the reader's own changes never appear, runs of small edits
// fold into one line, a first visit shows nothing at all, and nothing here
// pops up or moves while somebody reads. "Show changes" opens the item's
// history on the comparison between the version the reader last saw and now.

import { ChevronRight, FileText, Mic, NotebookPen, Users } from 'lucide-react';
import React, { Suspense, useMemo, useState } from 'react';
import {
    useMarkAllSeen, useMarkItemSeen, useProjectChangesQuery, versionsBaseUrl, type ChangeGroup, type ChangeItemType,
} from '../../../api/queries/projectChanges';
import { hasUnread, useProjectChatsQuery, type TeamChat } from '../../../api/queries/projectChats';
import { useProjectMembersQuery, type ProjectRole } from '../../../api/queries/projects';
import useRelativeTime from '../../../hooks/useRelativeTime';
import useTranslation from '../../../hooks/useTranslation';
import { lazy as lazyWithReload } from '../../../utils/lazyWithReload';
import { AiChip, AvatarStack } from '../../versions/VersionList';
import { contributorLine, contributorSummary, statsText } from '../../versions/versionText';
import type { VersionHistoryPanelProps } from '../../versions/VersionHistoryPanel';
import { kindColorVar } from '../../shared/kindColors';
import { canEditProject } from './types';
import { Card, GhostButton, LoadingRow } from './workspaceUi';

const VersionHistoryPanel = lazyWithReload(() => import('../../versions/VersionHistoryPanel')) as unknown as React.ComponentType<VersionHistoryPanelProps>;

type Glyph = React.ComponentType<{ className?: string; style?: React.CSSProperties; 'aria-hidden'?: boolean | 'true' }>;

const ICON: Record<ChangeItemType, { Icon: Glyph; style: React.CSSProperties }> = {
    document: { Icon: FileText, style: { color: kindColorVar('document') } },
    notebook: { Icon: NotebookPen, style: { color: 'var(--text-secondary)' } },
    meeting: { Icon: Mic, style: { color: kindColorVar('meeting') } },
};

export interface SinceLastVisitProps {
    projectId: string;
    role: ProjectRole;
    currentUserId?: string | null;
    onOpenItem: (type: ChangeItemType, id: string) => void;
    onOpenChat: (chatId: string) => void;
    /**
     * Whether an item of this type can be opened here at all (a notebook
     * cannot for a reader who may not use notebooks). Absent: every type.
     */
    canOpen?: (type: ChangeItemType) => boolean;
}

function useWhat() {
    const { t } = useTranslation();
    return (g: ChangeGroup): string | null => {
        if (g.kinds.includes('removed') && !g.item.available) return t('project_home.since.moved_out', 'Moved out of the project');
        if (g.kinds.includes('added')) return t('project_home.since.new', 'New in the project');
        if (g.kinds.includes('restored')) return t('project_home.since.restored', 'An earlier version was restored');
        if (g.kinds.includes('renamed') && !g.kinds.includes('edited')) return t('project_home.since.renamed', 'Renamed');
        if (g.kinds.includes('named') && !g.kinds.includes('edited')) return t('project_home.since.named', 'A version was named');
        return null;
    };
}

function titleOf(t: (k: string, f: string) => string, g: ChangeGroup): string {
    if (g.item.title) return g.item.title;
    if (!g.item.available) {
        if (g.item.type === 'document') return t('project_home.since.gone_document', 'A document that is no longer here');
        if (g.item.type === 'notebook') return t('project_home.since.gone_notebook', 'A notebook that is no longer here');
        return t('project_home.since.gone_meeting', 'A meeting that is no longer here');
    }
    return t('project_home.untitled', 'Untitled');
}

function ChangeRow({ group, people, currentUserId, onOpen, onShowChanges }: {
    group: ChangeGroup;
    people: Record<string, { name?: string }>;
    currentUserId?: string | null;
    /** null: the item cannot be opened here (a notebook for a reader without notebooks). */
    onOpen: (() => void) | null;
    onShowChanges: (() => void) | null;
}) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const what = useWhat()(group);
    const { Icon, style } = ICON[group.item.type];
    const line = contributorLine(t, group.contributors, people, currentUserId);
    const stats = group.kinds.includes('edited') ? statsText(t, group.stats) : null;
    return (
        <li className="flex items-start gap-2.5 px-2 py-2 rounded-lg hover:bg-[var(--bg-secondary)]" data-testid={`since-${group.item.type}-${group.item.id}`}>
            <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" style={style} aria-hidden="true" />
            <div className="flex-1 min-w-0">
                <p className="m-0 flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--text-primary)]">
                    <span className="truncate">{titleOf(t, group)}</span>
                    {group.unread && (
                        <span className="w-1.5 h-1.5 rounded-full flex-shrink-0 bg-[var(--accent-primary)]" role="img" aria-label={t('project_home.since.unread', 'Not seen yet')} data-testid="since-unread" />
                    )}
                </p>
                <p className="m-0 mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-[var(--text-tertiary)]">
                    {line.people.length > 0 && <AvatarStack names={line.people.map((p) => p.name)} />}
                    <span>{contributorSummary(t, line)}</span>
                    {line.ai && <AiChip />}
                    {what && <span>· {what}</span>}
                    {stats && <span className="tabular-nums">· {stats}</span>}
                    {group.lastChangedAt && <span>· {rel(group.lastChangedAt)}</span>}
                </p>
            </div>
            <div className="flex-shrink-0 flex items-center gap-1">
                {onShowChanges && <GhostButton onClick={onShowChanges} data-testid="since-show-changes">{t('project_home.since.show_changes', 'Show changes')}</GhostButton>}
                {group.item.available && onOpen && <GhostButton onClick={onOpen} data-testid="since-open">{t('project_home.since.open', 'Open')}</GhostButton>}
            </div>
        </li>
    );
}

function ChatRow({ chat, onOpen }: { chat: TeamChat; onOpen: () => void }) {
    const { t } = useTranslation();
    const n = typeof chat.unread === 'number' ? chat.unread : null;
    return (
        <li>
            <button type="button" onClick={onOpen} className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left hover:bg-[var(--bg-secondary)]" data-testid={`since-chat-${chat.id}`}>
                <Users className="w-4 h-4 flex-shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />
                <span className="flex-1 min-w-0 truncate text-[12.5px] font-medium text-[var(--text-primary)]">
                    {chat.unreadable || !chat.title ? t('project_home.since.a_team_chat', 'A team chat') : chat.title}
                </span>
                <span className="flex-shrink-0 text-[11.5px] text-[var(--text-tertiary)]">
                    {n ? t('project_home.since.new_messages', '{n} new messages', { n }) : t('project_home.since.new_messages_some', 'New messages')}
                </span>
            </button>
        </li>
    );
}

/**
 * Where the history opens: on the version the reader last saw, compared with
 * now (should that version no longer be kept, the state of the moment they saw
 * it stands in); or, when they never saw one, on the latest change compared
 * with the version before it.
 */
interface Opened { type: ChangeItemType; id: string; compare: VersionHistoryPanelProps['initialCompare'] }

const SECTION_TITLE = (t: (k: string, f: string) => string) => t('project_home.since.title', 'Since your last visit');

/** The rows: team chats with unread messages, the changed items, the small edits folded. */
function SinceList({ groups, chats, people, currentUserId, onOpenItem, onOpenChat, onShowChanges, canOpen }: {
    groups: ChangeGroup[];
    chats: TeamChat[];
    people: Record<string, { name?: string }>;
    currentUserId?: string | null;
    onOpenItem: (type: ChangeItemType, id: string) => void;
    onOpenChat: (chatId: string) => void;
    onShowChanges: (g: ChangeGroup) => (() => void) | null;
    canOpen: (type: ChangeItemType) => boolean;
}) {
    const { t } = useTranslation();
    const [showMinor, setShowMinor] = useState(false);
    const major = groups.filter((g) => !g.minor);
    const minor = groups.filter((g) => g.minor);
    const row = (g: ChangeGroup) => (
        <ChangeRow
            key={`${g.item.type}-${g.item.id}`}
            group={g}
            people={people}
            currentUserId={currentUserId}
            onOpen={canOpen(g.item.type) ? () => onOpenItem(g.item.type, g.item.id) : null}
            onShowChanges={canOpen(g.item.type) ? onShowChanges(g) : null}
        />
    );
    if (!groups.length && !chats.length) {
        return <p className="m-0 text-[12.5px] text-[var(--text-tertiary)]" data-testid="since-nothing">{t('project_home.since.nothing', 'Nothing new. Everything others changed, you have already seen.')}</p>;
    }
    return (
        <ul className="m-0 p-0 list-none -mx-1 space-y-0.5">
            {chats.map((c) => <ChatRow key={c.id} chat={c} onOpen={() => onOpenChat(c.id)} />)}
            {major.map(row)}
            {minor.length > 0 && (showMinor ? minor.map(row) : (
                <li>
                    <button type="button" onClick={() => setShowMinor(true)} className="flex items-center gap-1.5 px-2 py-1.5 text-[11.5px] text-[var(--text-tertiary)] hover:text-[var(--text-secondary)]" data-testid="since-minor">
                        <ChevronRight className="w-3.5 h-3.5" aria-hidden="true" />
                        {t('project_home.since.small_edits', 'Small edits in {n} more items', { n: minor.length })}
                    </button>
                </li>
            ))}
        </ul>
    );
}

/** An item's history, opened on "what changed since I last looked"; marks the item seen. */
function useShowChanges(projectId: string) {
    const markItem = useMarkItemSeen(projectId);
    const [opened, setOpened] = useState<Opened | null>(null);
    const showChanges = (g: ChangeGroup) => {
        const base = versionsBaseUrl(g.item.type, g.item.id);
        if (!base || !g.item.available || !(g.kinds.includes('edited') || g.kinds.includes('restored'))) return null;
        return () => {
            let compare: Opened['compare'] = null;
            if (g.seenVersionId && g.seenVersionId !== g.latestVersionId) compare = { from: g.seenVersionId, to: 'current', at: g.seenAt };
            else if (g.latestVersionId) compare = { from: g.latestVersionId };
            setOpened({ type: g.item.type, id: g.item.id, compare });
            markItem.mutate({ type: g.item.type, id: g.item.id, versionId: g.latestVersionId });
        };
    };
    return { opened, close: () => setOpened(null), showChanges };
}

function HistoryDrawer({ opened, projectId, role, currentUserId, onClose }: {
    opened: Opened;
    projectId: string;
    role: ProjectRole;
    currentUserId?: string | null;
    onClose: () => void;
}) {
    const base = versionsBaseUrl(opened.type, opened.id);
    if (!base) return null;
    return (
        <Suspense fallback={null}>
            <VersionHistoryPanel
                baseUrl={base}
                canEdit={canEditProject(role)}
                projectId={projectId}
                currentUserId={currentUserId}
                initialCompare={opened.compare}
                onClose={onClose}
            />
        </Suspense>
    );
}

const ANY_TYPE = () => true;

export default function SinceLastVisit({ projectId, role, currentUserId, onOpenItem, onOpenChat, canOpen = ANY_TYPE }: SinceLastVisitProps) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const changes = useProjectChangesQuery(projectId, 'visit');
    const chats = useProjectChatsQuery(projectId);
    const members = useProjectMembersQuery(projectId);
    const markAll = useMarkAllSeen(projectId);
    const history = useShowChanges(projectId);
    const unreadChats = useMemo(() => (chats.data?.chats || []).filter((c) => !c.archived && hasUnread(c)), [chats.data]);

    if (changes.isPending) return <Card title={SECTION_TITLE(t)} testId="overview-since"><LoadingRow label={t('project_home.loading', 'Loading…')} /></Card>;
    if (changes.isError) {
        return (
            <Card title={SECTION_TITLE(t)} testId="overview-since">
                <p role="alert" className="m-0 text-[12.5px] text-[var(--text-tertiary)]" data-testid="since-failed">
                    {t('project_home.since.failed', 'Could not load what changed since your last visit.')}{' '}
                    <button type="button" className="underline" onClick={() => changes.refetch()}>{t('project_home.retry', 'Try again')}</button>
                </p>
            </Card>
        );
    }
    const { groups, prevVisitAt } = changes.data;
    // A first visit has no "last visit": say nothing rather than list the project's whole past.
    if (!prevVisitAt && unreadChats.length === 0) return null;

    return (
        <Card
            title={SECTION_TITLE(t)}
            testId="overview-since"
            action={groups.some((g) => g.unread) ? (
                <GhostButton onClick={() => markAll.mutate()} disabled={markAll.isPending} data-testid="since-mark-all">
                    {t('project_home.since.mark_all', 'Mark all as seen')}
                </GhostButton>
            ) : undefined}
        >
            {prevVisitAt && <p className="m-0 -mt-1 mb-2 text-[11px] text-[var(--text-tertiary)]">{t('project_home.since.when', 'Your last visit was {when}.', { when: rel(prevVisitAt) })}</p>}
            <SinceList
                groups={groups}
                chats={unreadChats}
                people={members.data?.people || {}}
                currentUserId={currentUserId}
                onOpenItem={onOpenItem}
                onOpenChat={onOpenChat}
                onShowChanges={history.showChanges}
                canOpen={canOpen}
            />
            {markAll.isError && <p role="alert" className="m-0 mt-2 text-[11.5px] text-[var(--error-ink)]">{t('project_home.since.mark_failed', 'Could not mark everything as seen. Try again.')}</p>}
            {history.opened && <HistoryDrawer opened={history.opened} projectId={projectId} role={role} currentUserId={currentUserId} onClose={history.close} />}
        </Card>
    );
}
