import React from 'react';
import type { ChatMessage, MessageT } from './messageTypes';
import { describePrivacyLine, messageTextOf } from './privacyLine';
import type { TokenisationInfo } from '../../../hooks/useChatEngine/types';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';
import { logger } from '../../../utils/logger';

/**
 * Color from index.css, never from this file (C7). The chip was a fixed
 * blue rgba with a fixed dark-blue ink: one pair for twelve themes, and on the
 * dark sets a color nobody has measured. The amber `rgb(180,83,9)` had the
 * same problem. Amber now follows the chip recipe that index.css documents (the
 * -ink token for the words); the count chip is deliberately NEUTRAL and not
 * green. A green check is a claim about protection, and this panel does not
 * know whether the detector was up.
 */
const WARN_INK = 'var(--warning-ink, var(--warning))';

interface ScannedAttachment {
    filename?: string;
    reason?: string;
    timeout?: boolean;
    overflow?: boolean;
    truncated?: boolean;
    scannedPages?: number;
    totalPages?: number;
    byCategory?: Record<string, number>;
    pages?: Record<string, Record<string, number>>;
}

interface PrivacyPanelProps {
    msg: ChatMessage;
    idx: number;
    allMessages: ChatMessage[];
    t: MessageT;
}

/**
 * Privacy protection — shows PII/DLP tokenisation applied to this turn,
 * including the opt-in raw-payload transparency rows. Lifted verbatim out of
 * MessageItem/index.jsx; the caller still owns the `hasPrivacyInfo` gate.
 */
const PrivacyPanel = ({ msg, idx, allMessages, t }: PrivacyPanelProps) => {
    const info = msg.tokenisationInfo as TokenisationInfo;
    const counts = new Map();
    for (const c of (info.categories || [])) counts.set(c, (counts.get(c) || 0) + 1);
    const categoryList = [...counts.entries()].map(([label, n]) => `${label}${n > 1 ? ` ×${n}` : ''}`).join(', ');
    // A scan that found nothing is still worth confirming — silence
    // reads as "the shield did nothing" (BFSF-291).
    const nothingFound = !((info.count as number) > 0);
    // Did any attachment fail to be checked end to end? Drives the
    // explainer below: we may only promise full placeholder coverage
    // when there is full coverage.
    const anyIncompleteAttachment = Array.isArray(info.attachments)
        && (info.attachments as ScannedAttachment[]).some((a: ScannedAttachment) => a?.reason || a?.timeout || a?.overflow || a?.truncated);
    // C7 — which stand-ins this panel MAY name. The same measurement as
    // the line under the message (privacyLine.js): a token only counts if the
    // real value literally appears in the user message of this turn. The closing
    // sentence so far named `[email_1]` unconditionally — a stand-in that never
    // needed to exist in this conversation. That is the same error as the old
    // count pill: a reassurance with an example underneath that nobody measured.
    // Where the token map is missing (the org does not share it with the screen)
    // the sentence therefore names NO example.
    const userTurnText = (() => {
        for (let i = Number(idx) - 1; i >= 0; i--) {
            const m = Array.isArray(allMessages) ? allMessages[i] : null;
            if (m?.role === 'user') return messageTextOf(m);
        }
        return '';
    })();
    // `partial` counts just as hard as `tokens` here. This panel is the DEEPER
    // form of the same claim, so it may not be less careful than the shallow one:
    // a list of three names reads as the whole list, and without that flag
    // "The AI only saw placeholders — [a], [b], [c]." would also be said with
    // five replacements. The line under the message says neatly in that case how
    // many there were; the panel did not.
    const proven = describePrivacyLine({
        count: info.count,
        messageText: userTurnText,
        tokenMap: info.tokenMap,
    });
    const provenTokens = proven?.tokens || [];
    const provenPartial = !!proven?.partial;
    const actionLabel = nothingFound
        ? t('privacy.scanned_no_findings', 'Scanned for personal data — nothing found.')
        : info.action === 'block'
            ? t('privacy.action_blocked', 'Blocked')
            : info.action === 'restore'
                ? t('privacy.action_restored', 'Restored from vault')
                : info.action === 'protected'
                    ? t('privacy.action_protected', 'Privacy active')
                    : info.source === 'dlp'
                        ? t('privacy.action_tokenised_dlp', 'Tokenised (DLP)')
                        : t('privacy.action_tokenised', 'Tokenised');
    return (
        <details className="group/privacy">
            <summary className="flex items-center gap-2 cursor-pointer text-[11px] px-2 py-1.5 rounded-lg select-none list-none [&::-webkit-details-marker]:hidden transition-colors hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                <span className="text-xs">🔒</span>
                <span className="font-medium">{t('privacy.panel_title', 'Privacy protection')}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                    {nothingFound
                        ? t('privacy.badge_scanned', 'scanned')
                        : nOf(
                            t,
                            info.action === 'restore' ? 'privacy.badge_restored'
                                : info.action === 'protected' ? 'privacy.badge_protected'
                                    : 'privacy.badge_redacted',
                            info.count,
                            info.action === 'restore' ? '1 item restored'
                                : info.action === 'protected' ? '1 item protected'
                                    : '1 item redacted',
                            info.action === 'restore' ? '{count} items restored'
                                : info.action === 'protected' ? '{count} items protected'
                                    : '{count} items redacted',
                        )}
                </span>
                <svg className="w-2.5 h-2.5 transition-transform group-open/privacy:rotate-90 ml-auto opacity-40" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
            </summary>
            <div className="mt-1 px-3 py-2 rounded-lg text-[11px] leading-relaxed bg-[var(--bg-tertiary)] text-[var(--text-secondary)]">
                <p className="mb-1.5">
                    <strong className="text-[var(--text-primary)]">{actionLabel}</strong>
                    {(info.provider as string) && <> &middot; {t('privacy.sent_to', 'Sent to')} <strong>{info.provider as string}</strong></>}
                    {t(info.automatic ? 'privacy.by_automatic' : 'privacy.by_choice',
                        info.automatic ? ' (automatic)' : ' (you chose)')}
                </p>
                {categoryList && (
                    <p className="mb-1.5">
                        <span className="opacity-70">{t('privacy.detected', 'Detected:')}</span> {categoryList}
                    </p>
                )}
                {Array.isArray(info.attachments) && info.attachments.length > 0 && (
                    <div className="mb-1.5">
                        <span className="opacity-70">{t('privacy.from_attachments', 'From attachments:')}</span>
                        <ul className="mt-0.5 ml-3 list-disc">
                            {(info.attachments as ScannedAttachment[]).map((att: ScannedAttachment, i: number) => {
                                const fileLine = Object.entries(att.byCategory || {})
                                    .map(([cat, n]: [string, number]) => `${n} ${cat.toLowerCase()}${n > 1 ? 's' : ''}`).join(', ');
                                const pageEntries = Object.entries(att.pages || {});
                                const incompleteReason = att.reason || (att.timeout ? 'timeout' : (att.overflow ? 'overflow' : null));
                                const incompleteMsg = incompleteReason === 'overflow'
                                    ? t('dlp.attachment_overflow_truncated', 'too large to fully check; the rest was left out')
                                    : incompleteReason === 'timeout'
                                        ? t('dlp.attachment_timeout_truncated', 'check ran out of time; the rest was left out')
                                        : t('dlp.attachment_degraded_truncated', 'checking unavailable; the rest was left out');
                                const pageNote = (Number.isFinite(att.scannedPages) && Number.isFinite(att.totalPages))
                                    ? ' ' + t('dlp.attachment_scanned_partial', 'Scanned {scanned} of {total} pages', { scanned: att.scannedPages, total: att.totalPages })
                                    : '';
                                return (
                                    <li key={`${att.filename}-${i}`}>
                                        <strong className="text-[var(--text-primary)]">{att.filename}</strong>
                                        {fileLine && <> — {fileLine}</>}
                                        {incompleteReason && <span className="ml-1" style={{ color: WARN_INK }}>— ⚠️ {incompleteMsg}{pageNote}</span>}
                                        {pageEntries.length > 0 && (
                                            <ul className="ml-4 list-[circle]">
                                                {pageEntries.map(([page, byCat]: [string, Record<string, number>]) => {
                                                    const pageLine = Object.entries(byCat)
                                                        .map(([cat, n]: [string, number]) => `${n} ${cat.toLowerCase()}${n > 1 ? 's' : ''}`).join(', ');
                                                    return <li key={page}>p.{page} — {pageLine}</li>;
                                                })}
                                            </ul>
                                        )}
                                    </li>
                                );
                            })}
                        </ul>
                    </div>
                )}
                {/* The reassurance used to be unconditional, so a document that
                    timed out halfway still told the user "the AI only saw
                    placeholders" while the unchecked pages had gone out verbatim.
                    The tail is now cut rather than sent, but the sentence must
                    still only make the claim it can back: when coverage was
                    partial, say what actually happened instead. */}
                {!nothingFound && (anyIncompleteAttachment
                    ? (
                        <p style={{ color: WARN_INK }}>
                            {t('dlp.panel_partial_explainer', 'Part of this document could not be checked, so it was left out of what the AI received. Everything that was checked was replaced with placeholders.')}
                        </p>
                    )
                    : (
                        <p className="opacity-70" data-testid="privacy-panel-explainer">
                            {provenTokens.length > 0
                                ? t(
                                    provenPartial
                                        ? 'dlp.panel_full_explainer_named_partial'
                                        : 'dlp.panel_full_explainer_named',
                                    provenPartial
                                        ? 'The AI only saw placeholders. {count} values were replaced in all; {tokens} stand for values in this message. Real values were restored in the reply before you saw it.'
                                        : 'The AI only saw placeholders — {tokens}. Real values were restored in the reply before you saw it.',
                                    { tokens: provenTokens.join(', '), count: proven?.count },
                                )
                                : t(
                                    'dlp.panel_full_explainer_unnamed',
                                    'The AI only saw placeholders instead of the real values. Real values were restored in the reply before you saw it.',
                                )}
                        </p>
                    )
                )}

                {/* Raw-payload transparency — only renders when the org opted in
                    via Privacy Shield → Show raw payload. Lets the user verify the
                    actual strings sent to and received from the LLM. */}
                {(info.tokenizedPrompt || info.rawResponse || info.tokenMap) as boolean && (() => {
                    // Find the previous user message so we can show the "Original"
                    // (the user's own typed text that never left their browser).
                    let originalUserMsg = '';
                    for (let i = idx - 1; i >= 0; i--) {
                        const m = allMessages[i];
                        if (m?.role === 'user') {
                            originalUserMsg = typeof m.content === 'string'
                                ? m.content
                                : (Array.isArray(m.content) ? ((m.content as Array<{ type?: string; text?: string }>).find((p: { type?: string; text?: string }) => p?.type === 'text')?.text || '') : '');
                            break;
                        }
                    }
                    const shownResponse = typeof msg.content === 'string' ? msg.content : '';
                    const copy = (text: string) => { try { navigator.clipboard.writeText(text || ''); } catch (err) { logger.debug('ignore', err); } };
                    const Row = ({ label, text, hint, revealable }: { label: string; text: string; hint?: string; revealable?: boolean }) => {
                        const [revealed, setRevealed] = React.useState(!revealable);
                        if (!text) return null;
                        return (
                            <div className="mt-2">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{label}</span>
                                    {hint && <span className="text-[10px] text-[var(--text-tertiary)]">· {hint}</span>}
                                    {revealable && !revealed && (
                                        <button onClick={() => setRevealed(true)} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-primary)] text-[var(--accent-primary)]">
                                            {t('privacy.click_to_reveal', 'Click to reveal')}
                                        </button>
                                    )}
                                    <button onClick={() => copy(text)} className="ml-auto text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--bg-primary)] text-[var(--text-tertiary)]" title={t('chat.copy', 'Copy')}>
                                        {t('chat.copy', 'Copy')}
                                    </button>
                                </div>
                                <pre className="px-2.5 py-1.5 rounded text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words" style={{ background: 'var(--bg-primary)', color: revealed ? 'var(--text-primary)' : 'transparent', maxHeight: '180px', overflow: 'auto' }}>
                                    {revealed ? text : '•••'.repeat(Math.min(20, Math.ceil((text.length || 0) / 4)))}
                                </pre>
                            </div>
                        );
                    };
                    const TokenMapRow = ({ tokenMap }: { tokenMap?: Record<string, string> }) => {
                        const [revealed, setRevealed] = React.useState(false);
                        const entries = tokenMap ? Object.entries(tokenMap) : [];
                        if (entries.length === 0) return null;
                        const allText = entries.map(([t, v]: [string, string]) => `${t}\t${v}`).join('\n');
                        return (
                            <div className="mt-2">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-tertiary)]">{t('privacy.token_mapping', 'Token mapping')}</span>
                                    <span className="text-[10px] text-[var(--text-tertiary)]">{nOf(t, 'privacy.n_items', entries.length, '· 1 item', '· {count} items')}</span>
                                    {!revealed && (
                                        <button onClick={() => setRevealed(true)} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--bg-primary)] text-[var(--accent-primary)]">
                                            {t('privacy.click_to_reveal', 'Click to reveal')}
                                        </button>
                                    )}
                                    <button onClick={() => copy(allText)} className="ml-auto text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--bg-primary)] text-[var(--text-tertiary)]" title={t('chat.copy', 'Copy')}>
                                        {t('chat.copy', 'Copy')}
                                    </button>
                                </div>
                                <div className="px-2.5 py-1.5 rounded text-[11px] leading-relaxed font-mono [background:var(--bg-primary)] max-h-[180px] [overflow:auto]">
                                    {entries.map(([token, value]: [string, string]) => (
                                        <div key={token} className="flex gap-2 items-baseline">
                                            <code className="shrink-0 text-[var(--accent-primary)]">{token}</code>
                                            <span className="text-[var(--text-tertiary)]">→</span>
                                            <span className="break-all" style={{ color: revealed ? 'var(--text-primary)' : 'transparent', textShadow: revealed ? 'none' : '0 0 8px var(--text-tertiary)' }}>
                                                {revealed ? value : '•'.repeat(Math.min(24, (value || '').length))}
                                            </span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        );
                    };
                    // Show what the AI actually returned (tokens intact), not the
                    // post-restored display text. Prefer info.rawResponse when the
                    // org captured it; otherwise reconstruct by reverse-applying the
                    // token map to the displayed content (longest values first so
                    // substrings don't shadow longer matches).
                    const aiReturnedText = info.rawResponse || (() => {
                        if (!info.tokenMap || !shownResponse) return shownResponse || '';
                        const entries = Object.entries(info.tokenMap as Record<string, string>).sort((a: [string, string], b: [string, string]) => (b[1]?.length || 0) - (a[1]?.length || 0));
                        let out = shownResponse;
                        for (const [token, value] of entries) {
                            if (!value) continue;
                            const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            out = out.replace(new RegExp(escaped, 'g'), token);
                        }
                        return out;
                    })();
                    return (
                        <div className="mt-3 pt-2 border-t border-[var(--border-subtle)]">
                            <Row
                                label={t('privacy.row_original', 'Original message')}
                                text={originalUserMsg}
                                hint={t('privacy.row_original_hint', 'stays on your device')}
                                revealable
                            />
                            <Row
                                label={t('privacy.row_sent', 'Sent to AI')}
                                text={info.tokenizedPrompt as string}
                                hint={info.provider ? t('privacy.row_sent_hint', 'via {provider}', { provider: info.provider }) : undefined}
                            />
                            <TokenMapRow tokenMap={info.tokenMap as Record<string, string>} />
                            <Row
                                label={t('privacy.row_returned', 'What the AI returned')}
                                text={aiReturnedText as string}
                                hint={t(
                                    info.rawTruncated ? 'privacy.row_returned_hint_trunc' : 'privacy.row_returned_hint',
                                    info.rawTruncated ? 'truncated · tokens intact' : 'tokens intact',
                                )}
                            />
                        </div>
                    );
                })()}
            </div>
        </details>
    );
};

export default PrivacyPanel;
