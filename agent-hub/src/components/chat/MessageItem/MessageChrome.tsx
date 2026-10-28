// The pieces around a message's body: the sender tile, the guardrail warning,
// the feedback form, and the privacy line and actions under a user message.
// Split out of MessageItem without a change in behaviour.
import { Bot, Pencil } from 'lucide-react';
import type { ClipboardEvent } from 'react';
import type { ChatMessage } from './messageTypes';
import PrivacyLine from './PrivacyLine';
import { findTurnTokenMap, messageTextOf, normaliseScanWarnings } from './privacyLine';
import { isImageAvatar, resolveAvatarSrc } from '@/utils/agentAvatar';
import { TokenisedBadge } from './jsChildren';

type Translate = (key: string, fallback?: string | Record<string, unknown>, params?: Record<string, unknown>) => string;

/**
 * C9 — the assistant's sender tile. It sits BESIDE the answer, not above it:
 * it marks the left edge of the column the answer stands in and lets the text
 * itself run without a bubble.
 *
 * One tile, two fillings. When the turn carries its own agent (multi-agent:
 * `respondingAgentAvatar`) that is its face; otherwise the bot icon. Before
 * C9 that agent face sat in a second, smaller circle ABOVE the bubble — two
 * avatars for one speaker. The name does stay there, since a name is not an
 * avatar. User and tool messages get no tile: the bubble on the right and the
 * full-width card already say who is speaking.
 */
export function AssistantAvatar({ avatar }: { avatar?: string | null }) {
    return (
        <div
            data-testid="assistant-avatar"
            aria-hidden="true"
            className="w-[26px] h-[26px] rounded-lg flex-shrink-0 grid place-items-center overflow-hidden text-[13px] leading-none select-none [background:color-mix(in_srgb,var(--type-ai)_14%,transparent)] [color:var(--type-ai)]!"
        >
            {isImageAvatar(avatar) ? (
                <img src={resolveAvatarSrc(avatar) as string} alt="" className="w-full h-full object-cover" />
            ) : avatar ? avatar : <Bot className="w-3.5 h-3.5" />}
        </div>
    );
}

/** A message the guardrail is about to redact or delete. */
export function GuardrailWarning({ msg, t }: { msg: ChatMessage; t: Translate }) {
    return (
        <div className="mb-3 px-4 py-3 rounded-xl bg-red-600 border-2 border-red-400 text-white text-sm font-semibold flex items-center gap-3 shadow-lg" data-testid="msg-guardrail-warning">
            <span className="text-xl">🛡️</span>
            <div>
                <div className="font-bold">
                    {msg.willRedact ? t('chat.guardrail_content_violation') : t('chat.guardrail_message_violation')}
                </div>
                <div className="text-xs text-white/70 mt-0.5">
                    {msg.willRedact
                        ? t('chat.guardrail_will_redact', { seconds: msg.deleteIn || 5 })
                        : t('chat.guardrail_will_delete', { seconds: msg.deleteIn || 5 })
                    }
                </div>
            </div>
        </div>
    );
}

/**
 * Copy the selection without the bubble's background colours, so a pasted
 * answer does not carry the chat's theme into a document.
 */
export function copyWithoutBackground(e: ClipboardEvent) {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    const frag = range.cloneContents();
    const wrapper = document.createElement('div');
    wrapper.appendChild(frag);
    wrapper.querySelectorAll<HTMLElement>('*').forEach(el => {
        el.style.removeProperty('background-color');
        el.style.removeProperty('background');
    });
    wrapper.style.removeProperty('background-color');
    wrapper.style.removeProperty('background');
    e.clipboardData.setData('text/html', wrapper.innerHTML);
    e.clipboardData.setData('text/plain', sel.toString());
    e.preventDefault();
}

export interface FeedbackFormProps {
    t: Translate;
    feedbackComment: string;
    setFeedbackComment: (v: string) => void;
    includeConversation: boolean;
    setIncludeConversation: (v: boolean) => void;
    handleFeedbackSubmit: () => void;
    handleFeedbackSkip: () => void;
}

/** The optional comment after a thumbs up/down. */
export function FeedbackForm(p: FeedbackFormProps) {
    const { t } = p;
    return (
        <div className="mt-2 p-3 rounded-lg bg-[var(--bg-tertiary)] border border-[var(--border-subtle)] animate-fade-in">
            <textarea
                value={p.feedbackComment}
                onChange={(e) => p.setFeedbackComment(e.target.value)}
                placeholder={t('chat.msg.feedback_placeholder', 'Any additional feedback? (optional)')}
                className="w-full text-xs p-2 rounded-md bg-[var(--bg-primary)] border border-[var(--border-subtle)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] resize-none focus:outline-none focus:border-[var(--accent-primary)] transition-colors"
                rows={2}
            />
            <label className="flex items-center gap-2 mt-2 cursor-pointer select-none">
                <input
                    type="checkbox"
                    checked={p.includeConversation}
                    onChange={(e) => p.setIncludeConversation(e.target.checked)}
                    className="w-3.5 h-3.5 rounded accent-[var(--accent-primary)] cursor-pointer"
                />
                <span className="text-[11px] text-[var(--text-secondary)]">
                    {t('chat.msg.feedback_include', 'Include conversation')} <span className="text-[var(--text-tertiary)]">{t('chat.msg.feedback_include_hint', '— helps us reproduce the issue')}</span>
                </span>
            </label>
            <div className="flex items-center gap-2 mt-2">
                <button
                    onClick={p.handleFeedbackSubmit}
                    className="px-3 py-1 text-[11px] font-semibold rounded-md bg-[var(--accent-primary)] text-white hover:brightness-110 transition-all"
                >
                    {t('chat.msg.feedback_submit', 'Submit')}
                </button>
                <button
                    onClick={p.handleFeedbackSkip}
                    className="px-3 py-1 text-[11px] font-medium rounded-md text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition-colors"
                >
                    {t('chat.msg.feedback_skip', 'Skip')}
                </button>
            </div>
        </div>
    );
}

/**
 * PII / DLP — visible confirmation that the user's message had sensitive
 * values replaced with placeholders before reaching the LLM.
 * `dlpRedactedCount` is set by the DLP path, `piiTokenizedCount` by the legacy
 * Azure-PII path; take the max.
 *
 * C7: the line shows the placeholder ITSELF where the token map is there (it
 * lands on the ANSWER, hence the look-ahead in allMessages) and says honestly
 * that it cannot show it where the map is missing. The blue "N items
 * redacted" pill is gone with that: it was the counter form — a claim
 * without evidence.
 *
 * Amber "scan incomplete" warnings surface any large upload whose unscanned
 * part was passed unredacted (fail_open) — never silent. The pill stays
 * clickable beside the line, BUT the line carries the pass-through itself too
 * (`scanIncomplete`): "the real value stayed here" next to half a check is a
 * reassurance about something that was not measured, and the line is the
 * sentence people read. `normaliseScanWarnings` reads an unknown shape as "we
 * do not know", never as "there was nothing".
 */
export function UserPrivacyRow({ msg, allMessages, idx, t }: { msg: ChatMessage; allMessages: ChatMessage[]; idx: number; t: Translate }) {
    const scanWarnings = normaliseScanWarnings(msg.piiScanWarnings);
    const count = Math.max(msg.dlpRedactedCount || 0, msg.piiTokenizedCount || 0);
    if (!count && scanWarnings.length === 0) return null;
    return (
        <div data-testid="privacy-row" className="mt-1 mr-1 flex justify-end items-center gap-2 flex-wrap">
            <PrivacyLine
                count={count}
                messageText={messageTextOf(msg)}
                tokenMap={findTurnTokenMap(allMessages, idx)}
                scanIncomplete={scanWarnings.length > 0}
                t={t}
            />
            <TokenisedBadge warnings={scanWarnings} t={t} />
        </div>
    );
}

/** The edit pencil and the time under a user message. */
export function UserMessageMeta({ msg, canEdit, onEdit, t }: { msg: ChatMessage; canEdit: boolean; onEdit: () => void; t: Translate }) {
    return (
        <div className="mt-1.5 text-[10px] text-[var(--text-tertiary)] flex items-center gap-1 mr-1 justify-end">
            {canEdit && (
                <button
                    onClick={onEdit}
                    className="p-1 rounded hover:bg-white/10 text-[var(--text-tertiary)] hover:text-[var(--text-secondary)] transition-colors"
                    title={t('chat.msg.edit_message', 'Edit message')}
                >
                    <Pencil className="w-3 h-3" />
                </button>
            )}
            {msg.timestamp && (
                <span className="opacity-70">{new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            )}
        </div>
    );
}
