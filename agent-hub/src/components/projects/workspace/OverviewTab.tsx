// Overview: the project's home. Simple by default — say what the project is,
// start something (the composer), see what moved lately — with every deeper
// view one click away in the tabs.

import { FileText, House, Mic, NotebookPen, Sparkles, Users } from 'lucide-react';
import React, { useMemo } from 'react';
import { useProjectChatsQuery } from '../../../api/queries/projectChats';
import { useProjectResourcesQuery, useProjectThreadsQuery } from '../../../api/queries/projects';
import useRelativeTime from '../../../hooks/useRelativeTime';
import useTranslation from '../../../hooks/useTranslation';
import { kindColorVar } from '../../shared/kindColors';
import { InstructionsCard, KnowledgeCard, MembersCard, QuickActions, type OpenTab } from './OverviewCards';
import { mergeRecent, type RecentEntry, type RecentKind } from './overviewRecent';
import ProjectComplianceHint from './ProjectComplianceHint';
import ProjectComposer from './ProjectComposer';
import SinceLastVisit from './SinceLastVisit';
import { projectIcon, projectTileStyle } from './projectVisuals';
import { StudioSectionHeader } from './studioParts';
import { normalizeWorkspaceTab, type OpenThreadTarget, type StartChat, type WorkspaceTabProps } from './types';
import { Card, LoadingRow } from './workspaceUi';

export interface OverviewTabProps extends WorkspaceTabProps {
    onOpenTab: OpenTab;
    onStartChat: StartChat;
    onOpenThread: (thread: OpenThreadTarget) => void;
}

type Glyph = React.ComponentType<{ className?: string; style?: React.CSSProperties; 'aria-hidden'?: boolean | 'true' }>;

const RECENT_ICON: Record<RecentKind, { Icon: Glyph; style: React.CSSProperties }> = {
    team_chat: { Icon: Users, style: { color: 'var(--accent-primary)' } },
    ai_chat: { Icon: Sparkles, style: { color: kindColorVar('agent') } },
    document: { Icon: FileText, style: { color: kindColorVar('document') } },
    notebook: { Icon: NotebookPen, style: { color: 'var(--text-secondary)' } },
    meeting: { Icon: Mic, style: { color: kindColorVar('meeting') } },
};

function useKindLabel() {
    const { t } = useTranslation();
    return (kind: RecentKind): string => {
        switch (kind) {
            case 'team_chat': return t('project_home.recent.team_chat', 'Team chat');
            case 'ai_chat': return t('project_home.recent.ai_chat', 'AI chat');
            case 'document': return t('project_home.recent.document', 'Document');
            case 'notebook': return t('project_home.recent.notebook', 'Notebook');
            default: return t('project_home.recent.meeting', 'Meeting');
        }
    };
}

/**
 * One entry. `onOpen` null: shown, but not a way in (a notebook for a reader
 * who may not use notebooks), and it says so.
 */
function RecentRow({ entry, onOpen }: { entry: RecentEntry; onOpen: ((e: RecentEntry) => void) | null }) {
    const { t } = useTranslation();
    const rel = useRelativeTime();
    const kindLabel = useKindLabel();
    const { Icon, style } = RECENT_ICON[entry.kind];
    const body = (
        <>
            <Icon className="w-4 h-4 mt-0.5 flex-shrink-0" style={style} aria-hidden="true" />
            <span className="flex-1 min-w-0">
                <span className="block text-[12.5px] font-medium text-[var(--text-primary)] truncate">
                    {entry.title || t('project_home.untitled', 'Untitled')}
                </span>
                <span className="block text-[11px] text-[var(--text-tertiary)]">
                    {kindLabel(entry.kind)}{entry.at ? ` · ${rel(entry.at)}` : ''}
                    {!onOpen && ` · ${t('project_home.recent.notebook_closed', 'You cannot open notebooks')}`}
                </span>
            </span>
        </>
    );
    const testId = `recent-${entry.kind}-${entry.id}`;
    return (
        <li>
            {onOpen ? (
                <button
                    type="button"
                    onClick={() => onOpen(entry)}
                    data-testid={testId}
                    className="w-full flex items-start gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-[var(--bg-tertiary)]"
                >
                    {body}
                </button>
            ) : (
                <div data-testid={testId} className="w-full flex items-start gap-2.5 rounded-lg px-2 py-1.5">{body}</div>
            )}
        </li>
    );
}

function RecentList({ projectId, onOpen }: { projectId: string; onOpen: (e: RecentEntry) => ((e: RecentEntry) => void) | null }) {
    const { t } = useTranslation();
    const teamChats = useProjectChatsQuery(projectId);
    const threads = useProjectThreadsQuery(projectId);
    const resources = useProjectResourcesQuery(projectId);
    const sources = [teamChats, threads, resources];
    const entries = useMemo(
        () => mergeRecent({ teamChats: teamChats.data?.chats, threads: threads.data, resources: resources.data }),
        [teamChats.data, threads.data, resources.data],
    );
    const pending = sources.every((q) => q.isPending);
    const failed = sources.filter((q) => q.isError).length;

    let body: React.ReactNode;
    if (pending) body = <LoadingRow label={t('project_home.loading', 'Loading…')} />;
    else if (failed === sources.length) body = <p className="text-[12.5px] text-[var(--text-tertiary)] m-0" role="alert">{t('project_home.recent.failed', 'Could not load what happened recently.')}</p>;
    else if (entries.length === 0) body = <p className="text-[12.5px] text-[var(--text-tertiary)] m-0" data-testid="recent-empty">{t('project_home.recent.empty', 'Nothing here yet. Start a chat above, or add a document or a meeting.')}</p>;
    else body = <ul className="m-0 p-0 list-none -mx-1">{entries.map((e) => <RecentRow key={`${e.kind}-${e.id}`} entry={e} onOpen={onOpen(e)} />)}</ul>;

    return (
        <Card title={t('project_home.recent.title', 'Recent in this project')} testId="overview-recent">
            {body}
            {failed > 0 && failed < sources.length && (
                <p className="text-[11px] text-[var(--warning-ink)] mt-2 m-0" data-testid="recent-partial">
                    {t('project_home.recent.partial', 'Some items could not be loaded, so this list may be incomplete.')}
                </p>
            )}
        </Card>
    );
}

function ProjectHeading({ name, description, icon, color }: { name: string; description?: string; icon?: string; color?: string }) {
    return (
        <div className="flex items-start gap-3">
            <span style={projectTileStyle(color, 44)} aria-hidden="true">{projectIcon(icon)}</span>
            <div className="min-w-0">
                <h1 className="text-[22px] font-semibold text-[var(--text-primary)] m-0 truncate">{name}</h1>
                {description && <p className="mt-1 text-[13px] text-[var(--text-tertiary)] m-0 line-clamp-2">{description}</p>}
            </div>
        </div>
    );
}

export default function OverviewTab({
    projectId, project, role, currentUser, onOpenTab, onStartChat, onOpenThread, onNavigate, notebooksEnabled = true,
}: OverviewTabProps) {
    const { t } = useTranslation();
    const openRecent = (e: RecentEntry) => {
        if (e.kind === 'team_chat') onOpenTab('chats', e.id);
        else if (e.kind === 'ai_chat') onOpenThread({ id: e.id, type: e.threadType || 'direct', agentId: e.agentId ?? null });
        else if (e.kind === 'document') onOpenTab('documents', e.id);
        else if (e.kind === 'meeting') onOpenTab('meetings', e.id);
        else if (notebooksEnabled) onNavigate(`notebooks/${e.id}`);
    };
    // A notebook opens in the notebook editor, which refuses a reader who
    // may not use notebooks: for them it is not a way in.
    const opensKind = (kind: RecentKind) => kind !== 'notebook' || notebooksEnabled;

    return (
        <div className="h-full flex flex-col min-h-0" data-testid="project-overview-tab">
            <StudioSectionHeader icon={House} title={t('project_home.tab.overview', 'Overview')} />
            <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
                <div className="max-w-5xl mx-auto px-6 py-6 space-y-5">
                    <ProjectHeading name={project.name} description={project.description} icon={project.icon} color={project.color} />
                    <ProjectComplianceHint projectId={projectId} role={role} here="overview" onOpenTab={(tab) => onOpenTab(normalizeWorkspaceTab(tab))} />
                    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
                        <div className="space-y-5 min-w-0">
                            <ProjectComposer project={project} role={role} onStartChat={onStartChat} onOpenTeamChat={(id) => onOpenTab('chats', id)} />
                            <SinceLastVisit
                                projectId={projectId}
                                role={role}
                                currentUserId={currentUser?.id}
                                onOpenItem={(type, id) => openRecent({ kind: type, id, title: '', at: null })}
                                canOpen={opensKind}
                                onOpenChat={(id) => onOpenTab('chats', id)}
                            />
                            <QuickActions role={role} onOpenTab={onOpenTab} notebooksEnabled={notebooksEnabled} />
                            <RecentList projectId={projectId} onOpen={(e) => (opensKind(e.kind) ? openRecent : null)} />
                        </div>
                        <aside className="space-y-3 min-w-0" aria-label={t('project_home.overview.aside', 'About this project')}>
                            <InstructionsCard project={project} role={role} onOpenTab={onOpenTab} />
                            <MembersCard role={role} projectId={projectId} onOpenTab={onOpenTab} />
                            <KnowledgeCard project={project} onOpenTab={onOpenTab} />
                        </aside>
                    </div>
                </div>
            </div>
        </div>
    );
}
