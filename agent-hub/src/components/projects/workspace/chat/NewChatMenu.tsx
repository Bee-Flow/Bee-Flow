// "New chat" in the Chats tab header: a team chat with the members, a chat
// with the AI assistant, or a chat with one of the caller's agents. Picking
// one opens the new-chat form in that mode.

import { Bot, ChevronDown, Plus, Sparkles, Users } from 'lucide-react';
import React, { useRef, useState } from 'react';
import type { ComponentType } from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import AnchoredMenuJs from '../../../shared/AnchoredMenu';
import type { NewChatMode } from './NewChatComposer';

// A .jsx module whose `= null` defaults would type the props as null-only.
const AnchoredMenu = AnchoredMenuJs as unknown as ComponentType<Record<string, unknown>>;

// The Studio primary recipe (accent fill, accent ink), on a plain button so
// the menu can hand focus back to it.
const TRIGGER_CLASS = 'inline-flex items-center gap-1.5 h-8 px-3 rounded-[10px] text-xs font-semibold whitespace-nowrap '
    + 'bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] hover:bg-[var(--accent-primary-hover)] transition-colors '
    + 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent-primary)]';

export default function NewChatMenu({ onPick }: { onPick: (mode: NewChatMode) => void }) {
    const { t } = useTranslation();
    const anchorRef = useRef<HTMLButtonElement | null>(null);
    const [open, setOpen] = useState(false);
    const options: Array<{ mode: NewChatMode; Icon: ComponentType<{ className?: string }>; title: string; body: string }> = [
        { mode: 'team', Icon: Users, title: t('project_chat.new_team', 'Team chat'), body: t('project_chat.new_team_body', 'Talk with the members. The AI joins when you ask it.') },
        { mode: 'ai', Icon: Sparkles, title: t('project_chat.new_ai', 'AI chat'), body: t('project_chat.new_ai_body', 'Ask the AI assistant, with this project’s instructions and knowledge.') },
        { mode: 'agent', Icon: Bot, title: t('project_chat.new_agent', 'Agent chat'), body: t('project_chat.new_agent_body', 'Work with one of your agents inside this project.') },
    ];
    const pick = (mode: NewChatMode) => { setOpen(false); onPick(mode); };
    return (
        <>
            <button ref={anchorRef} type="button" className={TRIGGER_CLASS} onClick={() => setOpen(o => !o)}
                aria-haspopup="menu" aria-expanded={open} data-testid="new-chat-menu">
                <Plus className="w-3.5 h-3.5" aria-hidden="true" />
                {t('project_chat.new_chat', 'New chat')}
                <ChevronDown className="w-3 h-3" aria-hidden="true" />
            </button>
            <AnchoredMenu open={open} onClose={() => setOpen(false)} anchorRef={anchorRef} align="right" width={300} role="menu"
                aria-label={t('project_chat.new_chat', 'New chat')} className="p-1">
                {options.map(({ mode, Icon, title, body }) => (
                    <button key={mode} type="button" role="menuitem" onClick={() => pick(mode)} data-testid={`new-chat-${mode}`}
                        className="w-full flex items-start gap-2.5 px-2.5 py-2 rounded-lg text-left hover:bg-[var(--item-hover-bg)] focus:bg-[var(--item-hover-bg)] outline-none">
                        <Icon className="w-4 h-4 mt-0.5 flex-shrink-0 text-[var(--accent-primary)]" aria-hidden="true" />
                        <span className="min-w-0">
                            <span className="block text-[13px] font-medium text-[var(--text-primary)]">{title}</span>
                            <span className="block text-[11.5px] leading-snug text-[var(--text-tertiary)]">{body}</span>
                        </span>
                    </button>
                ))}
            </AnchoredMenu>
        </>
    );
}
