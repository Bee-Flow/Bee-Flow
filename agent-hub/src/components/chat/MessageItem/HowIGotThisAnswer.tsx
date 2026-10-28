import { tierLabel } from '../../licensing/tierMeta';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';
import type { KbSource, TokenisationInfo } from '@/hooks/useChatEngine/types';
import useTranslation, { type TranslateFn } from '@/hooks/useTranslation';
import { documentCountOf } from './citationGroups';
import type { ToolEntry } from './chatToolCallDisplay';
import KbSourcesPanel from './KbSourcesPanel';
import type { ChatMessage } from './messageTypes';
import PrivacyPanel from './PrivacyPanel';

/**
 * "How I got this answer" — the comprehensive collapsed disclosure under an
 * assistant message. Lifted verbatim out of MessageItem/index.jsx; the caller
 * still owns the `!simpleMode && !isUser && … && msg.content` gate and the
 * "is there anything to show" check.
 *
 * ── `showSources` DEFAULTS TO OFF, UNLIKE ITS CALLER ────────────────
 * MessageItem defaults it to true, because inside the product the sources are
 * the answer's evidence. Here it defaults to FALSE, because this is the
 * component that actually paints internal document titles, headings, page
 * numbers and whole retrieved passages — and a future caller that forgets to
 * thread the prop should print nothing rather than everything. The expensive
 * mistake is only ever in one direction.
 *
 * It hides the count pill as well as the panel: "3 sources" already tells a
 * stranger how much of a private library sits behind the answer.
 *
 * The tool timeline is no longer in here. It used to be the third telling of
 * one story (a line, then a chip, then this list); <ChatActivity/> above the
 * answer is now the one telling, and this panel keeps only the "n tools · s"
 * pill in its header.
 */
interface HowIGotThisAnswerProps {
    msg: ChatMessage;
    idx: number;
    allMessages: ChatMessage[];
    hasPrivacyInfo?: boolean;
    t?: TranslateFn;
    showSources?: boolean;
}

const HowIGotThisAnswer = ({ msg, idx, allMessages, hasPrivacyInfo, t: tProp, showSources = false }: HowIGotThisAnswerProps) => {
    // The caller passes `t` on. A caller that does not do so gets the hook, so that a panel never shows raw keys
    // or untranslatable English because one prop was forgotten.
    const { t: tHook } = useTranslation();
    const t = tProp || tHook;
    const visibleTools = (msg.toolHistory as ToolEntry[] | undefined)?.filter((t: ToolEntry) => t.name !== 'sequentialthinking') || [];
    const totalMs = visibleTools.reduce((acc: number, t: ToolEntry) => acc + (t.endTime && t.startTime ? t.endTime - t.startTime : 0), 0);
    const totalSec = totalMs > 0 ? (totalMs / 1000).toFixed(1) : null;
    return (
    <div className="mt-3 pt-3 p-3 rounded-lg [background-color:rgba(0,0,0,0.018)] [border:1px_solid_rgba(0,0,0,0.05)]">
        <details className="group/reasoning">
            <summary className="flex items-center gap-2 cursor-pointer text-xs transition-colors select-none list-none [&::-webkit-details-marker]:hidden [color:var(--text-primary,#000)]!">
                <span className="text-sm opacity-70">🧠</span>
                <span className="font-medium">{t('chat.msg.how_i_got_this', 'How I got this answer')}</span>
                {/* Aggregate stats bar */}
                <span className="flex items-center gap-1.5 ml-1 text-[10px] text-[var(--text-tertiary)]">
                    {visibleTools.length > 0 && (
                        <span className="px-1.5 py-0.5 rounded-full font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                            {nOf(t, 'chat.msg.n_tools', visibleTools.length, '1 tool', '{count} tools')}{totalSec ? t('chat.msg.tools_seconds', ' · {seconds}s', { seconds: totalSec }) : ''}
                        </span>
                    )}
                    {/* Counts DOCUMENTS, like the chip row and the sources
                        panel (citationGroups.ts). It used to count passages,
                        so "10 sources" sat above a handful of notes (BFSF-352). */}
                    {showSources && (msg.kbSources?.length as number) > 0 && (
                        <span className="px-1.5 py-0.5 rounded-full font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                            {nOf(t, 'chat.msg.kb_doc_count', documentCountOf(msg.kbSources as KbSource[]), '1 document', '{count} documents')}
                        </span>
                    )}
                    {msg.autoSelectedTier ? (
                        <span className="px-1.5 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]" title={msg.modelId || ''}>
                            {t('chat.msg.auto_picked', 'Auto → {tier}', { tier: tierLabel(msg.autoSelectedTier) })}
                        </span>
                    ) : msg.modelTier ? (
                        <span className="px-1.5 py-0.5 rounded-full bg-[var(--bg-tertiary)] text-[var(--text-secondary)]" title={msg.modelId || ''}>
                            {tierLabel(msg.modelTier)}
                        </span>
                    ) : null}
                    {(msg.tokenisationInfo?.count as number) > 0 && (() => {
                        const _act = (msg.tokenisationInfo as TokenisationInfo).action;
                        const _noun = t(
                            _act === 'restore' ? 'chat.msg.tok_noun_restored'
                                : _act === 'protected' ? 'chat.msg.tok_noun_protected'
                                    : 'chat.msg.tok_noun_redacted',
                            _act === 'restore' ? 'restored' : _act === 'protected' ? 'protected' : 'redacted',
                        );
                        const _title = t(
                            _act === 'restore' ? 'chat.msg.tok_hint_restored'
                                : _act === 'protected' ? 'chat.msg.tok_hint_protected'
                                    : 'chat.msg.tok_hint_redacted',
                            _act === 'restore'
                                ? 'Tokens from earlier turns appeared in this reply and were restored to real values before display'
                                : _act === 'protected'
                                    ? 'Privacy is active for this conversation — tokens from earlier turns are protected in the vault'
                                    : 'Sensitive data was tokenised on the outbound prompt and restored on the response',
                        );
                        return (
                            <span
                                className="px-1.5 py-0.5 rounded-full font-medium inline-flex items-center gap-1 [background:rgba(59,130,246,0.10)] [color:rgb(29,78,216)]"
                                title={_title}
                            >
                                🔒 {(msg.tokenisationInfo as TokenisationInfo).count} {_noun}
                            </span>
                        );
                    })()}
                </span>
                <svg className="w-3 h-3 transition-transform group-open/reasoning:rotate-90 ml-auto opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            </summary>
            <div className="mt-3 space-y-2">

                {/* Privacy protection — shows PII/DLP tokenisation applied to this turn. */}
                {hasPrivacyInfo && (
                    <PrivacyPanel msg={msg} idx={idx} allMessages={allMessages} t={t} />
                )}

                {/* Reasoning is now rendered by <ThinkingPanel /> above the
                    message content — auto-collapses to "Thought for Ns" after
                    streaming completes, so it's no longer duplicated here. */}

                {/* Sequential Thinking reference */}
                {(msg.thinkingSteps?.length as number) > 0 && (
                    <div className="flex items-center gap-2 px-3 py-1.5 rounded-lg text-[11px] bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                        <span>🔄</span>
                        <span>{t('chat.msg.sequential_thinking', 'Sequential Thinking:')} <strong className="text-[var(--text-primary)]">{nOf(t, 'chat.msg.n_steps', (msg.thinkingSteps as unknown[]).length, '1 step', '{count} steps')}</strong></span>
                        <span className="opacity-40 text-[10px]">{t('chat.msg.shown_above', '↑ shown above')}</span>
                    </div>
                )}

                {/* The tools themselves are <ChatActivity/> above the answer —
                    the same numbered timeline the builders show, visible
                    without a click. Only the count and the total stay here. */}

                {/* KB Sources — inside How I got this answer */}
                {showSources && (msg.kbSources?.length as number) > 0 && (
                    <KbSourcesPanel msg={msg} t={t} />
                )}

            </div>
        </details>
    </div>
    );
};

export default HowIGotThisAnswer;
