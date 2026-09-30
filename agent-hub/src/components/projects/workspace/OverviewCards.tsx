// The overview's supporting cards: quick actions under the composer, and the
// right-hand column (instructions, members, knowledge). Each card is a door
// into a tab; none of them edits anything in place.

import { BookOpen, FileText, Mic, NotebookPen, Upload, UserPlus } from 'lucide-react';
import React from 'react';
import {
    useProjectMembersQuery, useProjectResourcesQuery, type Project, type ProjectRole,
} from '../../../api/queries/projects';
import { useProjectFilesQuery } from '../../../api/queries/projectContent';
import useTranslation from '../../../hooks/useTranslation';
import { kindColorVar } from '../../shared/kindColors';
import { useProjectLive } from './ProjectLiveContext';
import { canEditProject, type WorkspaceIntent, type WorkspaceTabId } from './types';
import { Avatar, Card, GhostButton, SectionLabel } from './workspaceUi';

export type OpenTab = (tab: WorkspaceTabId, sub?: string | null, intent?: WorkspaceIntent | null) => void;

type Glyph = React.ComponentType<{ className?: string; style?: React.CSSProperties; strokeWidth?: number; 'aria-hidden'?: boolean | 'true' }>;

interface QuickAction {
    id: string;
    Icon: Glyph;
    /** The kind colour of the glyph, as a style object (the tile recipe). */
    iconStyle: React.CSSProperties;
    title: string;
    description: string;
    tab: WorkspaceTabId;
    intent: WorkspaceIntent;
}

function useQuickActions(role: ProjectRole, notebooksEnabled: boolean): QuickAction[] {
    const { t } = useTranslation();
    if (!canEditProject(role)) return [];
    const actions: QuickAction[] = [
        { id: 'document', Icon: FileText, iconStyle: { color: kindColorVar('document') }, tab: 'documents', intent: 'create', title: t('project_home.quick.document', 'New document'), description: t('project_home.quick.document_desc', 'Write together: a plan, a brief, minutes.') },
        { id: 'notebook', Icon: NotebookPen, iconStyle: { color: 'var(--accent-primary)' }, tab: 'notebooks', intent: 'create', title: t('project_home.quick.notebook', 'New notebook'), description: t('project_home.quick.notebook_desc', 'Notes, research and AI answers side by side.') },
        { id: 'meeting', Icon: Mic, iconStyle: { color: kindColorVar('meeting') }, tab: 'meetings', intent: 'capture', title: t('project_home.quick.meeting', 'Add a meeting'), description: t('project_home.quick.meeting_desc', 'Record or upload a meeting and keep the notes here.') },
        { id: 'files', Icon: Upload, iconStyle: { color: kindColorVar('kb') }, tab: 'knowledge', intent: 'upload', title: t('project_home.quick.files', 'Upload files'), description: t('project_home.quick.files_desc', 'The AI uses them in every chat in this project.') },
    ];
    if (!notebooksEnabled) actions.splice(actions.findIndex((a) => a.id === 'notebook'), 1);
    if (role === 'owner') {
        actions.push({ id: 'invite', Icon: UserPlus, iconStyle: { color: 'var(--text-secondary)' }, tab: 'members', intent: 'invite', title: t('project_home.quick.invite', 'Invite people'), description: t('project_home.quick.invite_desc', 'Work on this project together.') });
    }
    return actions;
}

export function QuickActions({ role, onOpenTab, notebooksEnabled = true }: { role: ProjectRole; onOpenTab: OpenTab; notebooksEnabled?: boolean }) {
    const { t } = useTranslation();
    const actions = useQuickActions(role, notebooksEnabled);
    if (actions.length === 0) return null;
    return (
        <section aria-labelledby="project-quick-actions">
            <SectionLabel id="project-quick-actions">{t('project_home.quick.title', 'Add to this project')}</SectionLabel>
            <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {actions.map(({ id, Icon, iconStyle, title, description, tab, intent }) => (
                    <button
                        key={id}
                        type="button"
                        onClick={() => onOpenTab(tab, null, intent)}
                        data-testid={`quick-${id}`}
                        className="flex items-start gap-3 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3.5 py-3 text-left transition-colors hover:border-[var(--border-default)]"
                    >
                        <Icon className="w-4 h-4 flex-shrink-0 mt-0.5" style={iconStyle} strokeWidth={1.75} aria-hidden="true" />
                        <span className="flex-1 min-w-0">
                            <span className="block text-[13px] font-medium text-[var(--text-primary)]">{title}</span>
                            <span className="line-clamp-2 text-[11.5px] leading-snug mt-0.5 text-[var(--text-tertiary)]">{description}</span>
                        </span>
                    </button>
                ))}
            </div>
        </section>
    );
}

export function InstructionsCard({ project, role, onOpenTab }: { project: Project; role: ProjectRole; onOpenTab: OpenTab }) {
    const { t } = useTranslation();
    const text = (project.customInstructions || '').trim();
    const canEdit = canEditProject(role);
    return (
        <Card
            title={t('project_home.overview.instructions', 'Instructions')}
            testId="overview-instructions"
            action={canEdit ? (
                <GhostButton onClick={() => onOpenTab('settings')}>
                    {text ? t('project_home.overview.edit', 'Edit') : t('project_home.overview.add', 'Add')}
                </GhostButton>
            ) : undefined}
        >
            {text ? (
                <p className="text-[12.5px] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap line-clamp-6 m-0">{text}</p>
            ) : (
                <p className="text-[12.5px] text-[var(--text-tertiary)] m-0">
                    {t('project_home.overview.no_instructions', 'No instructions yet. Tell the AI how to work in this project: tone, audience, what to keep in mind.')}
                </p>
            )}
        </Card>
    );
}

export function MembersCard({ role, projectId, onOpenTab }: { role: ProjectRole; projectId: string; onOpenTab: OpenTab }) {
    const { t } = useTranslation();
    const members = useProjectMembersQuery(projectId);
    const { online } = useProjectLive();
    const data = members.data;
    const people = data ? [data.ownerId, ...data.members.filter((m) => m.sharedWithType === 'user').map((m) => m.sharedWithId)] : [];
    const total = data ? data.members.length + 1 : null;
    return (
        <Card
            title={t('project_home.overview.members', 'Members')}
            testId="overview-members"
            action={<GhostButton onClick={() => onOpenTab('members')}>{t('project_home.overview.see_all', 'See all')}</GhostButton>}
        >
            {members.isError && <p className="text-[12.5px] text-[var(--text-tertiary)] m-0">{t('project_home.overview.members_failed', 'Could not load the members.')}</p>}
            {data && (
                <div className="flex items-center gap-3">
                    <div className="flex -space-x-1.5">
                        {people.slice(0, 6).map((id) => (
                            <Avatar key={id} name={data.people[id]?.name} size="sm" online={online.includes(id)} onlineLabel={t('project_home.online', 'Online')} />
                        ))}
                    </div>
                    <span className="text-[12px] text-[var(--text-tertiary)]">
                        {t('project_home.overview.member_count', '{n} in total', { n: total })}
                        {online.length > 0 && ` · ${t('project_home.overview.online_count', '{n} online', { n: online.length })}`}
                    </span>
                </div>
            )}
            {role === 'owner' && (
                <GhostButton className="mt-2 -ml-1.5" onClick={() => onOpenTab('members', null, 'invite')} data-testid="overview-invite">
                    <UserPlus className="w-3.5 h-3.5" aria-hidden="true" />
                    {t('project_home.quick.invite', 'Invite people')}
                </GhostButton>
            )}
        </Card>
    );
}

function CountLine({ label, value }: { label: string; value: React.ReactNode }) {
    return (
        <div className="flex items-center justify-between text-[12.5px]">
            <span className="text-[var(--text-secondary)]">{label}</span>
            <span className="tabular-nums text-[var(--text-tertiary)]">{value}</span>
        </div>
    );
}

export function KnowledgeCard({ project, onOpenTab }: { project: Project; onOpenTab: OpenTab }) {
    const { t } = useTranslation();
    const files = useProjectFilesQuery(project.id);
    const resources = useProjectResourcesQuery(project.id);
    const unknown = t('project_home.overview.unknown', 'not available');
    const loading = '…';
    const kbs = Array.isArray(resources.data?.knowledgeBases) ? resources.data!.knowledgeBases!.length : (project.knowledgeBaseIds?.length ?? null);
    const filesValue = files.isPending ? loading : files.isError ? unknown : files.data.files.length;
    return (
        <Card
            title={t('project_home.overview.knowledge', 'Knowledge')}
            testId="overview-knowledge"
            action={<GhostButton onClick={() => onOpenTab('knowledge')}>{t('project_home.overview.open', 'Open')}</GhostButton>}
        >
            <div className="space-y-1.5">
                <CountLine label={t('project_home.overview.files', 'Files')} value={filesValue} />
                <CountLine label={t('project_home.overview.kbs', 'Knowledge bases')} value={kbs ?? unknown} />
                <CountLine
                    label={t('project_home.overview.memory', 'Project memory')}
                    value={project.extractMemories ? t('project_home.overview.memory_on', 'On') : t('project_home.overview.memory_off', 'Off')}
                />
            </div>
            <p className="flex items-center gap-1.5 text-[11.5px] text-[var(--text-tertiary)] mt-2 m-0">
                <BookOpen className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
                {t('project_home.overview.knowledge_hint', 'Every chat in this project can use it.')}
            </p>
        </Card>
    );
}
