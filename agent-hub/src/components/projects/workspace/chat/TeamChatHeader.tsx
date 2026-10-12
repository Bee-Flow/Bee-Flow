// The 48px Studio header of an open team chat: back to the list, the name
// (renamed in place by editors), when the AI answers and as which agent (and,
// in Auto, whether feedback paused it; in a mode the organisation has since
// withdrawn, that it acts as "On mention"), and a menu for rename, archive and
// delete. Viewers see the settings, not the controls.

import { Building2, MoreHorizontal, PauseCircle, Search, Users } from 'lucide-react';
import React, { useRef, useState } from 'react';
import type { ComponentType } from 'react';
import type { ProjectRole } from '../../../../api/queries/projects';
import {
    useDeleteProjectChat, useTeamChatAiPolicy, useUpdateProjectChat, type TeamChat, type TeamChatPatch,
} from '../../../../api/queries/projectChats';
import { useTranslation } from '../../../../hooks/useTranslation';
import AnchoredMenuJs from '../../../shared/AnchoredMenu';
import { toast } from '../../../shared/Toast';
import useConfirm from '../../../shared/useConfirm';
import type { AgentSummary } from '../homeQueries';
import { projectErrorText } from '../projectErrorText';
import { StudioSectionHeader } from '../studioParts';
import ItemViewers from '../ItemViewers';
import { SelectField } from '../workspaceUi';
import AiModeSelector, { aiModeBadge, aiModeHint, effectiveMode } from './AiModeSelector';

// A .jsx module whose `= null` defaults would type the props as null-only.
const AnchoredMenu = AnchoredMenuJs as unknown as ComponentType<Record<string, unknown>>;

const MENU_ITEM = 'w-full text-left px-3 py-1.5 text-[13px] rounded-md text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)] focus:bg-[var(--item-hover-bg)] outline-none';

export interface TeamChatHeaderProps {
    projectId: string;
    chat: TeamChat;
    role: ProjectRole;
    currentUserId: string | null;
    agents: AgentSummary[];
    onBack: () => void;
    onDeleted: () => void;
    /** Make a task about this chat. */
    onCreateTask?: () => void;
    /** Opens and closes the search row under the header. */
    onToggleSearch?: () => void;
    searchOpen?: boolean;
}

function AgentSelect({ chat, agents, onChange }: { chat: TeamChat; agents: AgentSummary[]; onChange: (agentId: string | null) => void }) {
    const { t } = useTranslation();
    const known = !chat.agentId || agents.some(a => a.id === chat.agentId);
    return (
        <SelectField
            value={chat.agentId || ''}
            onChange={e => onChange(e.target.value || null)}
            aria-label={t('project_chat.agent_label', 'Who answers')}
            className="max-w-[11rem]" wrapperClassName="relative inline-block flex-shrink-0"
        >
            <option value="">{t('project_chat.ai_assistant', 'AI assistant')}</option>
            {!known && <option value={chat.agentId || ''} disabled>{t('project_chat.agent_other', 'An agent chosen by a colleague')}</option>}
            {agents.map(a => <option key={a.id} value={a.id}>{a.name || a.id}</option>)}
        </SelectField>
    );
}

/** "Paused" while "not helpful" feedback holds the AI back in an Auto chat. */
export function AutoPausedChip({ chat, now = Date.now() }: { chat: TeamChat; now?: number }) {
    const { t, locale } = useTranslation();
    const until = chat.autoPausedUntil ? Date.parse(chat.autoPausedUntil) : NaN;
    if (chat.aiMode !== 'auto' || !Number.isFinite(until) || until <= now) return null;
    const when = new Date(until).toLocaleString(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
    const why = t('project_participation.paused_title', 'After "Not helpful" feedback the AI stopped joining by itself here. It joins again from {time}. You can still ask it with @ai.', { time: when });
    return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border border-[var(--border-default)] text-[var(--text-secondary)] whitespace-nowrap"
            title={why} data-testid="team-chat-auto-paused">
            <PauseCircle className="w-3 h-3" aria-hidden="true" />
            {t('project_participation.paused', 'Paused')}
            <span className="sr-only">{why}</span>
        </span>
    );
}

/** "Limited" while the organisation no longer allows the chat's own mode: it then acts as "On mention". */
export function ModeWithdrawnChip({ chat }: { chat: TeamChat }) {
    const { t } = useTranslation();
    if (effectiveMode(chat) === chat.aiMode) return null;
    const why = t('project_chat.ai_mode_withdrawn_title', 'Your organisation no longer allows this mode here, so the AI only answers when someone mentions it.');
    return (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border border-[var(--border-default)] text-[var(--text-secondary)] whitespace-nowrap"
            title={why} data-testid="team-chat-mode-withdrawn">
            <Building2 className="w-3 h-3" aria-hidden="true" />
            {t('project_chat.ai_mode_withdrawn', 'Limited')}
            <span className="sr-only">{why}</span>
        </span>
    );
}

function ChatMenu({ canEdit, canDelete, archived, onRename, onArchive, onDelete, onCreateTask }: {
    onCreateTask?: () => void;
    canEdit: boolean;
    canDelete: boolean;
    archived: boolean;
    onRename: () => void;
    onArchive: () => void;
    onDelete: () => void;
}) {
    const { t } = useTranslation();
    const anchorRef = useRef<HTMLButtonElement | null>(null);
    const [open, setOpen] = useState(false);
    const run = (action: () => void) => { setOpen(false); action(); };
    if (!canEdit && !canDelete) return null;
    return (
        <>
            <button ref={anchorRef} type="button" onClick={() => setOpen(o => !o)} aria-haspopup="menu" aria-expanded={open}
                aria-label={t('project_chat.chat_actions', 'Chat actions')} title={t('project_chat.chat_actions', 'Chat actions')}
                className="grid place-items-center w-8 h-8 rounded-lg flex-shrink-0 text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]">
                <MoreHorizontal className="w-4 h-4" aria-hidden="true" />
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="right" width={200} role="menu"
                aria-label={t('project_chat.chat_actions', 'Chat actions')} className="p-1">
                {canEdit && onCreateTask && <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => run(onCreateTask)}>{t('project_tasks.from_chat', 'Make a task from this chat')}</button>}
                {canEdit && <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => run(onRename)}>{t('project_chat.rename', 'Rename')}</button>}
                {canEdit && (
                    <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => run(onArchive)}>
                        {archived ? t('project_chat.unarchive', 'Restore from archive') : t('project_chat.archive', 'Archive')}
                    </button>
                )}
                {canDelete && (
                    <button type="button" role="menuitem" className={`${MENU_ITEM} text-[var(--error-ink)]`} onClick={() => run(onDelete)}>
                        {t('project_chat.delete_chat', 'Delete chat')}
                    </button>
                )}
            </AnchoredMenu>
        </>
    );
}

function useHeaderActions({ projectId, chat, onDeleted }: TeamChatHeaderProps) {
    const { t } = useTranslation();
    const update = useUpdateProjectChat(projectId, chat.id);
    const remove = useDeleteProjectChat(projectId);
    const { confirm, confirmDialog } = useConfirm();
    const patch = (body: TeamChatPatch) => update.mutate(body, { onError: e => toast.error(projectErrorText(t, e)) });
    const onDelete = async () => {
        const ok = await confirm({
            title: t('project_chat.delete_chat_title', 'Delete this team chat?'),
            description: t('project_chat.delete_chat_body', 'All its messages are deleted for everyone in the project. This cannot be undone.'),
            confirmLabel: t('project_chat.delete', 'Delete'),
            cancelLabel: t('project_chat.cancel', 'Cancel'),
            destructive: true,
        });
        if (ok) remove.mutate(chat.id, { onSuccess: onDeleted, onError: e => toast.error(projectErrorText(t, e)) });
    };
    return { patch, onDelete, confirmDialog };
}

export default function TeamChatHeader(props: TeamChatHeaderProps) {
    const { t } = useTranslation();
    const { chat, role, currentUserId, agents, onBack } = props;
    const canEdit = role === 'owner' || role === 'editor';
    // Deleting needs editor rights; then the creator may, and the owner always.
    const canDelete = role === 'owner' || (canEdit && !!currentUserId && chat.createdBy === currentUserId);
    const [renameRequest, setRenameRequest] = useState(0);
    const { patch, onDelete, confirmDialog } = useHeaderActions(props);
    const policy = useTeamChatAiPolicy(props.projectId);
    const extras = (
        <div className="flex items-center gap-2 min-w-0">
            {/* The header's action cluster never shrinks, so on a narrow header the controls scroll
                sideways in a capped box instead of squeezing the title out; the menu stays in reach. */}
            <div className="flex items-center gap-2 min-w-0 @max-[900px]/objhead:max-w-[14rem] @max-[900px]/objhead:overflow-x-auto custom-scrollbar">
                {props.onToggleSearch && (
                    <button type="button" onClick={props.onToggleSearch} aria-pressed={!!props.searchOpen}
                        aria-label={t('project_chat.search_in_chat', 'Search in this chat')} title={t('project_chat.search_in_chat', 'Search in this chat')}
                        data-testid="team-chat-search-toggle"
                        className={`grid place-items-center w-8 h-8 rounded-lg flex-shrink-0 hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)] ${props.searchOpen ? 'text-[var(--accent-primary)]' : 'text-[var(--text-secondary)]'}`}>
                        <Search className="w-4 h-4" aria-hidden="true" />
                    </button>
                )}
                <details className="relative">
                    <summary className="cursor-pointer text-xs text-[var(--text-secondary)] rounded-lg border border-[var(--border-default)] px-2 py-1.5">{aiModeBadge(effectiveMode(chat), t)}</summary>
                    <div className="fixed z-50 right-4 mt-2 max-w-[calc(100vw-2rem)] rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] shadow-lg p-3 space-y-3">
                        <AiModeSelector value={chat.aiMode} readOnly={!canEdit} policy={policy} onChange={aiMode => patch({ aiMode })} />
                        <p className="text-xs text-[var(--text-secondary)]">{aiModeHint(effectiveMode(chat), t)}</p>
                        {canEdit && chat.aiMode !== 'off' && <AgentSelect chat={chat} agents={agents} onChange={agentId => patch({ agentId })} />}
                    </div>
                </details>
                <ItemViewers type="chat" id={chat.id} />
                <AutoPausedChip chat={chat} />
                <ModeWithdrawnChip chat={chat} />
            </div>
            <ChatMenu canEdit={canEdit} canDelete={canDelete} archived={chat.archived}
                onCreateTask={props.onCreateTask} onRename={() => setRenameRequest(n => n + 1)} onArchive={() => patch({ archived: !chat.archived })} onDelete={onDelete} />
        </div>
    );
    return (
        <>
            <StudioSectionHeader
                icon={Users}
                title={chat.title || t('project_chat.untitled_team_chat', 'Team chat')}
                onRename={canEdit ? (title: string) => patch({ title: title.slice(0, 200) }) : undefined}
                renameRequest={renameRequest}
                statusChip={chat.archived ? t('project_chat.archived', 'Archived') : undefined}
                extras={extras}
                onBack={onBack}
                backLabel={t('project_chat.back_to_chats', 'Back to chats')}
                testId="team-chat-header"
            />
            {confirmDialog}
        </>
    );
}
