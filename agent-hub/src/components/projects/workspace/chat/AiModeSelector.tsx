// When the AI answers in a team chat: never, when someone mentions it, on its
// own when it can help, or after every message. One control for the chat
// header and the "new team chat" form, and one wording for the badge in the
// chat list. A mode the organisation does not allow is shown but cannot be
// picked (the chat's current mode always can, so nothing changes under you).

import { Sparkles } from 'lucide-react';
import React from 'react';
import type { TeamChat, TeamChatAiMode, TeamChatAiPolicy } from '../../../../api/queries/projectChats';
import { useTranslation, type TranslateFn } from '../../../../hooks/useTranslation';
import SegmentedControl from '../../../shared/SegmentedControl';

export const AI_MODES: readonly TeamChatAiMode[] = Object.freeze(['off', 'mention', 'auto', 'always']);

/** The short name of a mode, as the segmented control shows it. */
export function aiModeLabel(mode: TeamChatAiMode, t: TranslateFn): string {
    if (mode === 'off') return t('project_chat.ai_mode_off', 'Off');
    if (mode === 'always') return t('project_chat.ai_mode_always', 'Always');
    if (mode === 'auto') return t('project_chat.ai_mode_auto', 'Auto');
    return t('project_chat.ai_mode_mention', 'On mention');
}

/** One line on what a mode does, for the option's tooltip. */
export function aiModeHint(mode: TeamChatAiMode, t: TranslateFn): string {
    if (mode === 'off') return t('project_chat.ai_mode_off_hint', 'The AI never answers');
    if (mode === 'always') return t('project_chat.ai_mode_always_hint', 'The AI answers every message');
    if (mode === 'auto') return t('project_chat.ai_mode_auto_hint', 'AI joins when it can help');
    return t('project_chat.ai_mode_mention_hint', 'The AI answers when someone mentions it');
}

/** The mode as a sentence-sized badge ("AI on mention"), for lists. */
export function aiModeBadge(mode: TeamChatAiMode, t: TranslateFn): string {
    if (mode === 'off') return t('project_chat.ai_badge_off', 'AI off');
    if (mode === 'always') return t('project_chat.ai_badge_always', 'AI answers every message');
    if (mode === 'auto') return t('project_chat.ai_badge_auto', 'AI joins when it can help');
    return t('project_chat.ai_badge_mention', 'AI on mention');
}

/** The mode the chat acts in now: its own, or `mention` when the organisation withdrew it. */
export function effectiveMode(chat: Pick<TeamChat, 'aiMode' | 'effectiveAiMode'>): TeamChatAiMode {
    return chat.effectiveAiMode || chat.aiMode;
}

/** May this mode be picked now? The current one always may. */
export function modeAllowed(mode: TeamChatAiMode, current: TeamChatAiMode, policy: TeamChatAiPolicy | null | undefined): boolean {
    if (mode === current || !policy) return true;
    if (mode === 'auto') return policy.autoAllowed;
    if (mode === 'always') return policy.alwaysAllowed;
    return true;
}

export default function AiModeSelector({ value, onChange, readOnly = false, disabled = false, policy = null }: {
    value: TeamChatAiMode;
    onChange: (mode: TeamChatAiMode) => void;
    readOnly?: boolean;
    disabled?: boolean;
    /** What the organisation allows; null while unknown (the server still checks). */
    policy?: TeamChatAiPolicy | null;
}) {
    const { t } = useTranslation();
    const label = t('project_chat.ai_mode_label', 'When the AI answers');
    if (readOnly) {
        return (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] border border-[var(--border-default)] text-[var(--text-secondary)] whitespace-nowrap"
                title={label} data-testid="team-chat-ai-mode-readonly">
                <Sparkles className="w-3 h-3" aria-hidden="true" />
                {aiModeBadge(value, t)}
            </span>
        );
    }
    const notAllowed = t('project_chat.ai_mode_not_allowed', 'Your organisation does not allow this');
    return (
        <div className="inline-flex items-center gap-1.5 flex-shrink-0" title={label}>
            <Sparkles className="w-3.5 h-3.5 text-[var(--text-tertiary)]" aria-hidden="true" />
            <SegmentedControl
                size="sm"
                ariaLabel={label}
                value={value}
                onChange={onChange}
                disabled={disabled}
                options={AI_MODES.map((mode) => {
                    const allowed = modeAllowed(mode, value, policy);
                    return {
                        value: mode,
                        label: <span title={allowed ? aiModeHint(mode, t) : notAllowed}>{aiModeLabel(mode, t)}</span>,
                        disabled: !allowed,
                    };
                })}
            />
        </div>
    );
}
