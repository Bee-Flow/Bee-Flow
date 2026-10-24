/**
 * The card for a call that the agent did NOT execute.
 *
 * The server holds a call as soon as a human has to say yes
 * (`toolRoundExecutor` gate 2) and then sends `tool_confirm`. Until A4 there was
 * no client at all for that event. It WAS stored on the message
 * (`assistantMsg.pendingToolCalls`) but read by nobody, so the model
 * said in prose that it was waiting for something, and there was nothing to
 * click on. This is that card.
 *
 * ── THREE THINGS THIS CARD DOES NOT DO ─────────────────────────────
 *  1. It never says that anything happened. The heading is "wanted", not "did":
 *     the call was held back before dispatch, and that is the only thing that is certain.
 *  2. It shows no buttons that do nothing. Without `onDecide`, which is a normal
 *     chat where no approval path exists yet, this is a NOTICE.
 *     A grey "Approve" that quietly does nothing is exactly the kind of false green
 *     that a test chat should find, not produce.
 *  3. It does not invent arguments. `preview` is the server-bounded, flat
 *     display (previewToolArgs: 20 keys, 500 characters, nested
 *     values as a type label). What is not in there is not shown here either.
 *
 * ── THIS CARD ALSO LANDS IN A NORMAL CHAT ───────────────────────────
 * `pendingToolCalls` is persisted (finalizeTurn) and survives a reload, so this
 * card also appears in a conversation from last month for someone who may only
 * use the agent. That is good: "the agent wanted this and did not do it" is just
 * as true there. What must NOT appear is a way out that this reader does not
 * have. The text used to point to the agent's test chat, a screen for which he
 * has no edit right (`gateTestChatRequest` refuses with 403) and which in any
 * case runs in a different, ephemeral draft conversation. The notice now says
 * only what happened.
 *
 * ── WHAT A DECISION CONCERNS ─────────────────────────────────────
 * One action, not a tool. The key is `argsKey`: the server hashed
 * name-plus-arguments into it, so "yes" on this email is not a "yes" on the
 * next email with a different address. That is why the buttons return that key
 * and not the tool name.
 */

import React from 'react';
import { AlertTriangle, Check, HelpCircle, ShieldQuestion, X } from 'lucide-react';

import { confirmDecisionOf, type ConfirmBook, type ConfirmCall } from './toolConfirmStatus';

/** A tool call that waits for the person's decision. */
export interface ToolConfirmCall extends ConfirmCall {
    preview?: Record<string, unknown>;
    effect?: string;
    toolName?: string;
    [key: string]: unknown;
}

/** Called with the verdict on one pending call. */
export type ToolDecisionHandler = (argsKey: string | undefined, decision: 'approve' | 'decline', call: ToolConfirmCall) => void;

interface ToolConfirmCardProps {
    calls?: ToolConfirmCall[] | null;
    onDecide?: ToolDecisionHandler | null;
    decided?: ConfirmBook;
    t?: (key: string, fallback: string, params?: Record<string, unknown>) => string;
}

/** Eén regel uit de argumentpreview. Waarden zijn al begrensd door de server. */
function PreviewRow({ name, value }: { name: string; value: unknown }) {
    return (
        <div className="flex gap-2 text-xs leading-relaxed">
            <span className="text-[var(--text-tertiary)] flex-shrink-0 font-medium">{name}</span>
            <span className="text-[var(--text-primary)] break-all whitespace-pre-wrap">
                {typeof value === 'string' ? value : JSON.stringify(value)}
            </span>
        </div>
    );
}

/**
 * @param {object[]} calls      the `pendingToolCalls` of this message
 * @param {Function} [onDecide] (argsKey, 'approve'|'decline', call). Omit it
 *   where a decision has nowhere to go; then the card renders as a notice
 * @param {object} [decided]    { [argsKey]: 'approve'|'decline' }: what has
 *   already been clicked in this session, so the buttons do not jump back
 * @param {Function} t
 */
export default function ToolConfirmCard({ calls, onDecide, decided = {}, t = (k: string, d: string) => d }: ToolConfirmCardProps) {
    const list = Array.isArray(calls) ? calls.filter(Boolean) : [];
    if (list.length === 0) return null;

    return (
        <div className="my-3 space-y-2">
            {list.map((call: ToolConfirmCall, i: number) => {
                const key = call.argsKey || call.callId || String(i);
                // Status AND provenance, from the one reading that the trail also
                // uses (`toolConfirmStatus.js`). The provenance matters here: the server
                // says that an approved call HAS RUN, while a click in this session says
                // that it will run with the next message. Both used to say "it ran" here.
                const { status, by } = confirmDecisionOf(call, decided);
                const entries = call.preview && typeof call.preview === 'object'
                    ? Object.entries(call.preview)
                    : [];
                const sends = call.effect === 'sends';

                return (
                    <div
                        key={key}
                        data-testid="tool-confirm-card"
                        data-status={status}
                        className={`rounded-xl border overflow-hidden ${status === 'approved'
                            ? 'border-green-500/40 bg-green-500/5'
                            : status === 'declined'
                                ? 'border-[var(--border-subtle)] bg-[var(--bg-tertiary)] opacity-60'
                                : status === 'unknown'
                                    ? 'border-[var(--border-subtle)] bg-[var(--bg-tertiary)]'
                                    : 'border-amber-500/40 bg-amber-500/5'}`}
                    >
                        <div className="flex items-center gap-2 px-4 py-2.5 text-xs font-semibold uppercase tracking-wider">
                            {status === 'approved' ? <Check className="w-3.5 h-3.5 text-green-500" />
                                : status === 'declined' ? <X className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                                    : status === 'unknown' ? <HelpCircle className="w-3.5 h-3.5 text-[var(--text-tertiary)]" />
                                        : sends ? <AlertTriangle className="w-3.5 h-3.5 text-amber-500" />
                                            : <ShieldQuestion className="w-3.5 h-3.5 text-amber-500" />}
                            <span className={status === 'approved' ? 'text-green-500'
                                : (status === 'declined' || status === 'unknown') ? 'text-[var(--text-tertiary)]'
                                    : 'text-amber-500'}>
                                {status === 'approved'
                                    ? (by === 'session'
                                        // Clicked, not yet sent: the call
                                        // runs only when the model proposes it again with the
                                        // next message.
                                        ? t('agent_studio.test.tool_confirm_approved_next', 'You approved this — it runs on your next message')
                                        : t('agent_studio.test.tool_confirm_approved', 'You approved this — it ran'))
                                    : status === 'declined'
                                        ? t('agent_studio.test.tool_confirm_declined', 'You declined this — it did not run')
                                        : status === 'unknown'
                                            ? t('agent_studio.test.tool_confirm_unknown', 'Could not tell whether this ran')
                                            : t('agent_studio.test.tool_confirm_title', 'Wanted to do this — it has not run')}
                            </span>
                        </div>

                        <div className="px-4 pb-3 space-y-1.5">
                            <div className="flex items-center gap-2">
                                <code className="text-sm font-semibold text-[var(--text-primary)]">{call.toolName}</code>
                                {sends && (
                                    <span className="text-[10px] uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-600 dark:text-amber-400">
                                        {t('agent_studio.test.tool_effect_sends', 'leaves this workspace')}
                                    </span>
                                )}
                            </div>
                            {entries.length > 0 && (
                                <div className="space-y-1 pt-1">
                                    {entries.map(([name, value]: [string, unknown]) => (
                                        <PreviewRow key={name} name={name} value={value} />
                                    ))}
                                </div>
                            )}
                        </div>

                        {status === 'pending' && (
                            onDecide ? (
                                <div className="flex items-center gap-2 px-4 py-3 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                                    <button
                                        type="button"
                                        onClick={() => onDecide(call.argsKey, 'approve', call)}
                                        className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-[var(--accent)] text-white hover:opacity-90"
                                    >
                                        {t('agent_studio.test.tool_confirm_approve', 'Approve and run')}
                                    </button>
                                    <button
                                        type="button"
                                        onClick={() => onDecide(call.argsKey, 'decline', call)}
                                        className="px-3 py-1.5 text-xs font-semibold rounded-lg border border-[var(--border-subtle)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]"
                                    >
                                        {t('agent_studio.test.tool_confirm_decline', 'Do not run it')}
                                    </button>
                                    <span className="text-[11px] text-[var(--text-tertiary)] ml-auto">
                                        {t('agent_studio.test.tool_confirm_next_turn', 'Applies on your next message')}
                                    </span>
                                </div>
                            ) : (
                                // No way to say yes, so no button that suggests it. This is the honest half
                                // of point 2 in the heading above.
                                <div className="px-4 py-2.5 border-t border-[var(--border-subtle)] bg-[var(--bg-secondary)] text-[11px] text-[var(--text-tertiary)]">
                                    {t('agent_studio.test.tool_confirm_no_decision',
                                        'Nothing was done — this agent asks a person before actions like this.')}
                                </div>
                            )
                        )}
                    </div>
                );
            })}
        </div>
    );
}
