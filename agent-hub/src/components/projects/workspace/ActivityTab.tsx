// Activity: what happened in the project, newest first, in sentences.
// The feed is live — ProjectLiveProvider invalidates it on every durable
// event — and pages further back with "Load more".
//
// "Changes only" reads the project's change log instead (notebooks,
// documents and meetings: edited, created, renamed, moved, restored), one row
// per editing session, with the item's title as the reader may see it now.

import { Activity, Sparkles } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { useProjectChangeLogQuery } from '../../../api/queries/projectChanges';
import {
    useProjectActivityQuery, useProjectMembersQuery, type ProjectMembers,
} from '../../../api/queries/projects';
import useRelativeTime from '../../../hooks/useRelativeTime';
import useTranslation from '../../../hooks/useTranslation';
import {
    activityCategory, changeMeta, describeActivity, type ActivityCategory, type ActivityEntry, type ActivityNames,
} from './activityText';
import { FilterPills, StudioSectionHeader } from './studioParts';
import type { WorkspaceTabProps } from './types';
import { Avatar, ErrorText, LoadingRow, SecondaryButton } from './workspaceUi';

type Filter = 'all' | 'changes' | ActivityCategory;

/** The pages of either feed, as the body renders them. */
interface FeedLike {
    isPending: boolean;
    isError: boolean;
    refetch: () => unknown;
    hasNextPage: boolean;
    isFetchingNextPage: boolean;
    fetchNextPage: () => unknown;
}

function namesFrom(data: ProjectMembers | undefined, currentUserId: string | null | undefined): ActivityNames {
    return {
        person: (id) => {
            const p = id ? data?.people?.[id] : undefined;
            return p ? (p.name || null) : null;
        },
        group: (id) => (id ? data?.groups?.[id]?.name || null : null),
        currentUserId,
    };
}

function ActivityRow({ item, names }: { item: ActivityEntry; names: ActivityNames }) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const actorName = item.actorId ? names.person(item.actorId) : null;
    const meta = changeMeta(item, t);
    const withAi = item.action === 'content.edited' && (item.details as Record<string, unknown> | undefined)?.aiAssisted === true;
    return (
        <li className="flex items-start gap-3 px-3.5 py-2.5 border-b border-[var(--border-subtle)] last:border-b-0" data-testid="activity-row">
            <Avatar name={actorName || (item.actorKind === 'ai' ? t('project_home.activity.ai_name', 'AI') : '?')} size="sm" />
            <div className="flex-1 min-w-0">
                <p className="text-[13px] text-[var(--text-primary)] m-0">{describeActivity(item, names, t)}</p>
                {(meta || withAi) && (
                    <p className="m-0 mt-0.5 flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)]" data-testid="activity-meta">
                        {withAi && <Sparkles className="w-3 h-3 text-[var(--accent-primary)]" aria-label={t('project_home.activity.with_ai', 'With AI')} />}
                        {meta}
                    </p>
                )}
            </div>
            <time
                dateTime={item.createdAt}
                title={item.createdAt ? new Date(item.createdAt).toLocaleString() : undefined}
                className="flex-shrink-0 text-[11px] text-[var(--text-tertiary)] tabular-nums"
            >
                {rel(item.createdAt)}
            </time>
        </li>
    );
}

function useFilterOptions() {
    const { t } = useTranslation();
    return [
        { value: 'all' as Filter, label: t('project_home.activity.filter_all', 'All') },
        { value: 'changes' as Filter, label: t('project_home.activity.filter_changes', 'Changes only') },
        { value: 'chats' as Filter, label: t('project_home.activity.filter_chats', 'Chats') },
        { value: 'content' as Filter, label: t('project_home.activity.filter_content', 'Content') },
        { value: 'people' as Filter, label: t('project_home.activity.filter_people', 'People') },
        { value: 'project' as Filter, label: t('project_home.activity.filter_project', 'Project') },
    ];
}

function ActivityBody({ items, names, filter, feed }: {
    items: ActivityEntry[];
    names: ActivityNames;
    filter: Filter;
    feed: FeedLike;
}) {
    const { t } = useTranslation();
    if (feed.isPending) return <LoadingRow label={t('project_home.activity.loading', 'Loading activity…')} />;
    if (feed.isError) {
        return (
            <div className="space-y-2" data-testid="activity-error">
                <ErrorText>{t('project_home.activity.load_failed', 'Could not load the activity of this project.')}</ErrorText>
                <SecondaryButton onClick={() => feed.refetch()}>{t('project_home.retry', 'Try again')}</SecondaryButton>
            </div>
        );
    }
    const shown = filter === 'all' || filter === 'changes' ? items : items.filter((i) => activityCategory(i.action) === filter);
    let empty: string;
    if (filter === 'changes') empty = t('project_home.activity.empty_changes', 'No changes to notebooks, documents or meetings yet.');
    else if (items.length === 0) empty = t('project_home.activity.empty', 'Nothing has happened here yet. Chats, documents and new members will show up here.');
    else empty = t('project_home.activity.empty_filter', 'Nothing of this kind in the loaded activity.');
    return (
        <>
            {shown.length === 0 ? (
                <p className="px-3 py-2.5 rounded-lg text-sm bg-[var(--bg-secondary)] text-[var(--text-tertiary)] m-0" data-testid="activity-empty">
                    {empty}
                </p>
            ) : (
                <ol className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] overflow-hidden m-0 p-0 list-none">
                    {shown.map((item) => <ActivityRow key={item.id} item={item} names={names} />)}
                </ol>
            )}
            {feed.hasNextPage && (
                <div className="flex justify-center">
                    <SecondaryButton onClick={() => feed.fetchNextPage()} busy={feed.isFetchingNextPage} data-testid="activity-more">
                        {t('project_home.activity.load_more', 'Load more')}
                    </SecondaryButton>
                </div>
            )}
        </>
    );
}

export default function ActivityTab({ projectId, currentUser }: WorkspaceTabProps) {
    const { t } = useTranslation();
    const [filter, setFilter] = useState<Filter>('all');
    const changesOnly = filter === 'changes';
    const all = useProjectActivityQuery(projectId);
    const changes = useProjectChangeLogQuery(projectId, changesOnly);
    const feed = changesOnly ? changes : all;
    const members = useProjectMembersQuery(projectId);
    const options = useFilterOptions();
    const names = useMemo(() => namesFrom(members.data, currentUser?.id), [members.data, currentUser?.id]);
    const items: ActivityEntry[] = useMemo(() => (feed.data?.pages || []).flatMap((p) => p.items), [feed.data]);

    return (
        <div className="h-full flex flex-col min-h-0" data-testid="project-activity-tab">
            <StudioSectionHeader icon={Activity} title={t('project_home.tab.activity', 'Activity')} />
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className="max-w-3xl mx-auto px-6 py-6 space-y-4">
                    <FilterPills
                        value={filter}
                        onChange={setFilter}
                        options={options}
                        ariaLabel={t('project_home.activity.filter', 'Show activity about')}
                        testId="activity-filter"
                    />
                    <ActivityBody items={items} names={names} filter={filter} feed={feed} />
                </div>
            </div>
        </div>
    );
}
