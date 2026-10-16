// The sidebar's "Chats" section: the conversations, grouped by date. Split out
// of Sidebar.jsx without a change in behaviour.
import { Pin } from 'lucide-react';
import ConvRowJs from './ConvRow';
import type { ConvRowProps } from './ConvRow';
import { agentBadgeFor, conversationActions, groupConversationsByDate } from './sidebarConversations';
import type { SidebarAgent, SidebarConversation } from './sidebarConversations';
import { SECTION_LBL } from './sidebarTokens';

type Translate = (key: string, fallback?: string) => string;

// ConvRow is JavaScript; these are the props this list hands it.
const ConvRow = ConvRowJs;

/** What ConvRow's menu does with a conversation (rename, pin, label, file). */
export type ConvRowHandlers = Required<Pick<ConvRowProps, 'conversationLabels' | 'projects'>>
    & Pick<ConvRowProps, 'activeProjectId' | 'onRenameConversation' | 'onPinConversation' | 'onLabelConversation' | 'onDeleteLabel' | 'onEditLabel' | 'onCreateLabel' | 'onMoveToProject' | 'onShareToProject'>;

export interface RecentChatsProps {
    t: Translate;
    isOpen: boolean;
    convs: SidebarConversation[];
    /** Whether an agent or direct chat is chosen: the empty list says "no chats yet", not "pick one". */
    hasChatTarget: boolean;
    actions: ReturnType<typeof conversationActions>;
    agents: SidebarAgent[];
    rowHandlers: ConvRowHandlers;
}

export default function RecentChats({ t, isOpen, convs, hasChatTarget, actions, agents, rowHandlers }: RecentChatsProps) {
    return (
        <div className={`flex flex-col ${isOpen ? '' : 'hidden'}`}>
            <div className="flex items-center justify-between px-3 h-9 select-none">
                <span className={SECTION_LBL}>{t('sidebar.chats')}</span>
                {convs.length > 0 && (
                    <span className="text-[10px] text-[var(--text-tertiary)] font-medium tabular-nums">{convs.length}</span>
                )}
            </div>

            <div className="px-1.5 pb-1">
                {isOpen ? (convs.length === 0 ? (
                    <p className="px-3 py-2 text-[12px] text-[var(--text-tertiary)]">
                        {hasChatTarget ? t('sidebar.no_chats_yet') : t('sidebar.select_agent_to_begin')}
                    </p>
                ) : (
                    groupConversationsByDate(convs, t).map(group => (
                        <div key={group.label} className="mt-3 first:mt-0">
                            <h3 className={`px-3 py-1 text-[10px] font-bold uppercase tracking-widest ${group.isPinned ? 'text-[var(--accent-primary)]' : 'text-gray-500'}`}>
                                {group.isPinned && <Pin className="w-2.5 h-2.5 inline mr-1 -mt-0.5 -rotate-45" />}
                                {group.label}
                            </h3>
                            <div className="space-y-px">
                                {group.items.map(c => (
                                    <ConvRow
                                        key={c.id}
                                        conv={c}
                                        t={t}
                                        active={actions.convIsActive(c)}
                                        selectConv={actions.selectConv}
                                        deleteConv={actions.deleteConv}
                                        {...rowHandlers}
                                        agentBadge={actions.isAllChats ? agentBadgeFor(c, agents) : null}
                                    />
                                ))}
                            </div>
                        </div>
                    ))
                )) : null}
            </div>
        </div>
    );
}
