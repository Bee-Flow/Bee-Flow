import React from 'react';
import { useTranslation } from '../../../../hooks/useTranslation';
import MarkdownRenderer from '../../../renderers/MarkdownRenderer';
import { tierLabel } from '../../../licensing/tierMeta';
import BuilderThinkingBlock from './BuilderThinkingBlock';
import BuilderActivity from './BuilderActivity';

/**
 * Message bubble styled to match direct/agent chat:
 *   - 900px centered column (same as MessageItem outer container).
 *   - User: light grey #e8e8eb pill capped at 85%, bottom-right corner squared.
 *   - Assistant: no background — body sits directly on the chat surface, the
 *     same way direct chat renders so long markdown reads naturally instead
 *     of being trapped in a small grey bubble. Bottom-left corner squared
 *     to mirror the speech-bubble feel.
 *   - Markdown is rendered for assistant turns, and for a user turn that IS
 *     a document — a playbook hands the builder its brief as that first
 *     message: a heading, numbered steps, tool names in backticks. Read as
 *     plain text it is a grey wall; read as markdown it is the thing the room
 *     is meant to see (owner, 2026-09-16). A message someone TYPED stays
 *     plain text with its line breaks: without remark-breaks, markdown eats a
 *     single newline, and a typed list would lose the shape it was given.
 */
// A brief inside the user pill is a document, but a small one: the headings
// come down to the bubble's own size and the lists lose their fat margins.
const USER_MD = 'text-sm [&_p]:my-1 [&_p:first-child]:mt-0 [&_p:last-child]:mb-0 [&_ul]:my-1 [&_ol]:my-1 [&_ul]:pl-4 [&_ol]:pl-5 [&_li]:my-0.5 [&_h1]:text-sm [&_h2]:text-sm [&_h3]:text-xs [&_h1]:mt-0 [&_h2]:mt-0 [&_h1]:mb-1 [&_h2]:mb-1 [&_h3]:mb-1 [&_pre]:my-1';

/**
 * Is this user message a document rather than a sentence? A heading, a list
 * item or a fenced block at the start of a line — the shapes a composed brief
 * has and a typed message does not.
 */
export function readsAsMarkdown(text) {
    const s = typeof text === 'string' ? text : '';
    return /^#{1,6}\s\S/m.test(s) || /^\s*(?:[-*+]\s\S|\d+\.\s\S)/m.test(s) || /^```/m.test(s);
}

/**
 * @param {object} props
 * @param {object} props.msg
 * @param {React.ReactNode} [props.activity] — what to render under the bubble
 *   instead of the routine builder's BuilderActivity (the App Studio builder
 *   passes its own typed activity rows; the default child reads routine step
 *   types and would render nothing for app tools).
 * @param {object|null} [props.liveRun] — the test run in flight under THIS
 *   message, as flow/runFocus.js reads it; BuilderActivity shows it as its
 *   live row, and only while the message is still streaming.
 */
export default function MessageBubble({ msg, activity, liveRun = null, onFocusStep = null }) {
    const { t } = useTranslation();
    const isUser = msg.role === 'user';
    const asDoc = isUser && readsAsMarkdown(msg.content);
    return (
        <div className={`flex flex-col w-full ${isUser ? 'items-end' : 'items-start'}`}>
            {!isUser && <BuilderThinkingBlock msg={msg} />}
            <div
                className={`relative rounded-2xl p-4 transition-all duration-200 overflow-hidden text-sm ${isUser
                    ? `max-w-[85%] bg-[var(--user-bubble-bg,#e8e8eb)] text-[var(--user-bubble-fg,#000)] rounded-br-none${asDoc ? '' : ' whitespace-pre-wrap'}`
                    : 'max-w-3xl text-[var(--text-primary)] rounded-bl-none'}`}
            >
                {isUser && !asDoc
                    ? msg.content
                    : <MarkdownRenderer content={msg.content || ''} className={isUser ? USER_MD : ''} />}
            </div>
            {/* Auto-tier badge — same shape as direct chat's MessageItem.
                Shown only when the server resolved 'auto' to a real tier
                so the user knows which model produced this turn. */}
            {!isUser && msg.autoSelectedTier && (
                <div className="mt-1 text-[11px] text-[var(--text-tertiary)] px-1">
                    Auto → {tierLabel(msg.autoSelectedTier)}
                </div>
            )}
            {!isUser && (activity !== undefined
                ? activity
                : <BuilderActivity toolCalls={msg.toolCalls} running={!!msg.isStreaming} liveRun={liveRun} t={t} onFocusStep={onFocusStep} />)}
        </div>
    );
}
