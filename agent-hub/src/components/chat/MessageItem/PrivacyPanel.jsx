import React from 'react';
import { describePrivacyLine, messageTextOf } from './privacyLine';
import { nOf } from '../../admin/Studio/KnowledgeStudio/plural';

/**
 * Kleur uit index.css, nooit uit dit bestand (C7). De chip was een vaste
 * blauwe rgba met een vaste donkerblauwe inkt: één paar voor twaalf thema's,
 * en op de donkere sets een kleur die niemand heeft gemeten. Het amberen
 * `rgb(180,83,9)` had hetzelfde probleem. Amber volgt nu het chiprecept dat
 * index.css documenteert (het -ink-token voor de woorden); de telchip is
 * bewust NEUTRAAL en niet groen — een groen vinkje is een claim over
 * bescherming, en dit paneel weet niet of de detector overeind stond.
 */
const WARN_INK = 'var(--warning-ink, var(--warning))';

/**
 * Privacy protection — shows PII/DLP tokenisation applied to this turn,
 * including the opt-in raw-payload transparency rows. Lifted verbatim out of
 * MessageItem/index.jsx; the caller still owns the `hasPrivacyInfo` gate.
 */
const PrivacyPanel = ({ msg, idx, allMessages, t }) => {
    const info = msg.tokenisationInfo;
    const counts = new Map();
    for (const c of (info.categories || [])) counts.set(c, (counts.get(c) || 0) + 1);
    const categoryList = [...counts.entries()].map(([label, n]) => `${label}${n > 1 ? ` ×${n}` : ''}`).join(', ');
    // A scan that found nothing is still worth confirming — silence
    // reads as "the shield did nothing" (BFSF-291).
    const nothingFound = !(info.count > 0);
    // Did any attachment fail to be checked end to end? Drives the
    // explainer below: we may only promise full placeholder coverage
    // when there is full coverage.
    const anyIncompleteAttachment = Array.isArray(info.attachments)
        && info.attachments.some(a => a?.reason || a?.timeout || a?.overflow || a?.truncated);
    // C7 — welke plaatsvervangers dit paneel MAG noemen. Dezelfde meting als
    // de regel onder het bericht (privacyLine.js): een token telt pas mee als
    // de echte waarde woordelijk in het gebruikersbericht van deze beurt
    // staat. De slotzin noemde tot nu toe onvoorwaardelijk `[email_1]` — een
    // plaatsvervanger die in dít gesprek nooit bestaan hoeft te hebben. Dat is
    // dezelfde fout als de oude telpil: een geruststelling met een voorbeeld
    // eronder dat niemand heeft gemeten. Waar de tokenmap ontbreekt (de org
    // deelt hem niet met het scherm) noemt de zin dus géén voorbeeld.
    const userTurnText = (() => {
        for (let i = Number(idx) - 1; i >= 0; i--) {
            const m = Array.isArray(allMessages) ? allMessages[i] : null;
            if (m?.role === 'user') return messageTextOf(m);
        }
        return '';
    })();
    // `partial` telt hier net zo hard als `tokens`. Dit paneel is de DIEPERE
    // vorm van dezelfde claim, dus het mag niet minder voorzichtig zijn dan de
    // ondiepe: een opsomming van drie namen leest als de hele lijst, en zonder
    // die vlag zou "The AI only saw placeholders — [a], [b], [c]." dat ook zijn
    // bij vijf vervangingen. De regel onder het bericht zegt in dat geval
    // netjes hoeveel het er waren; het paneel deed dat niet.
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
            <summary className="flex items-center gap-2 cursor-pointer text-[11px] px-2 py-1.5 rounded-lg select-none list-none [&::-webkit-details-marker]:hidden transition-colors hover:bg-[var(--bg-tertiary)]" style={{ color: 'var(--text-secondary)' }}>
                <span className="text-xs">🔒</span>
                <span className="font-medium">{t('privacy.panel_title', 'Privacy protection')}</span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-full font-medium" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
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
            <div className="mt-1 px-3 py-2 rounded-lg text-[11px] leading-relaxed" style={{ background: 'var(--bg-tertiary)', color: 'var(--text-secondary)' }}>
                <p className="mb-1.5">
                    <strong style={{ color: 'var(--text-primary)' }}>{actionLabel}</strong>
                    {info.provider && <> &middot; {t('privacy.sent_to', 'Sent to')} <strong>{info.provider}</strong></>}
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
                            {info.attachments.map((att, i) => {
                                const fileLine = Object.entries(att.byCategory || {})
                                    .map(([cat, n]) => `${n} ${cat.toLowerCase()}${n > 1 ? 's' : ''}`).join(', ');
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
                                        <strong style={{ color: 'var(--text-primary)' }}>{att.filename}</strong>
                                        {fileLine && <> — {fileLine}</>}
                                        {incompleteReason && <span className="ml-1" style={{ color: WARN_INK }}>— ⚠️ {incompleteMsg}{pageNote}</span>}
                                        {pageEntries.length > 0 && (
                                            <ul className="ml-4 list-[circle]">
                                                {pageEntries.map(([page, byCat]) => {
                                                    const pageLine = Object.entries(byCat)
                                                        .map(([cat, n]) => `${n} ${cat.toLowerCase()}${n > 1 ? 's' : ''}`).join(', ');
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
                {(info.tokenizedPrompt || info.rawResponse || info.tokenMap) && (() => {
                    // Find the previous user message so we can show the "Original"
                    // (the user's own typed text that never left their browser).
                    let originalUserMsg = '';
                    for (let i = idx - 1; i >= 0; i--) {
                        const m = allMessages[i];
                        if (m?.role === 'user') {
                            originalUserMsg = typeof m.content === 'string'
                                ? m.content
                                : (Array.isArray(m.content) ? (m.content.find(p => p?.type === 'text')?.text || '') : '');
                            break;
                        }
                    }
                    const shownResponse = typeof msg.content === 'string' ? msg.content : '';
                    const copy = (text) => { try { navigator.clipboard.writeText(text || ''); } catch (_) { /* ignore */ } };
                    const Row = ({ label, text, hint, revealable }) => {
                        const [revealed, setRevealed] = React.useState(!revealable);
                        if (!text) return null;
                        return (
                            <div className="mt-2">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{label}</span>
                                    {hint && <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>· {hint}</span>}
                                    {revealable && !revealed && (
                                        <button onClick={() => setRevealed(true)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-primary)', color: 'var(--accent-primary)' }}>
                                            {t('privacy.click_to_reveal', 'Click to reveal')}
                                        </button>
                                    )}
                                    <button onClick={() => copy(text)} className="ml-auto text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--bg-primary)]" style={{ color: 'var(--text-tertiary)' }} title={t('chat.copy', 'Copy')}>
                                        {t('chat.copy', 'Copy')}
                                    </button>
                                </div>
                                <pre className="px-2.5 py-1.5 rounded text-[11px] leading-relaxed font-mono whitespace-pre-wrap break-words" style={{ background: 'var(--bg-primary)', color: revealed ? 'var(--text-primary)' : 'transparent', maxHeight: '180px', overflow: 'auto' }}>
                                    {revealed ? text : '•••'.repeat(Math.min(20, Math.ceil((text.length || 0) / 4)))}
                                </pre>
                            </div>
                        );
                    };
                    const TokenMapRow = ({ tokenMap }) => {
                        const [revealed, setRevealed] = React.useState(false);
                        const entries = tokenMap ? Object.entries(tokenMap) : [];
                        if (entries.length === 0) return null;
                        const allText = entries.map(([t, v]) => `${t}\t${v}`).join('\n');
                        return (
                            <div className="mt-2">
                                <div className="flex items-center gap-2 mb-1">
                                    <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>{t('privacy.token_mapping', 'Token mapping')}</span>
                                    <span className="text-[10px]" style={{ color: 'var(--text-tertiary)' }}>{nOf(t, 'privacy.n_items', entries.length, '· 1 item', '· {count} items')}</span>
                                    {!revealed && (
                                        <button onClick={() => setRevealed(true)} className="text-[10px] px-1.5 py-0.5 rounded" style={{ background: 'var(--bg-primary)', color: 'var(--accent-primary)' }}>
                                            {t('privacy.click_to_reveal', 'Click to reveal')}
                                        </button>
                                    )}
                                    <button onClick={() => copy(allText)} className="ml-auto text-[10px] px-1.5 py-0.5 rounded hover:bg-[var(--bg-primary)]" style={{ color: 'var(--text-tertiary)' }} title={t('chat.copy', 'Copy')}>
                                        {t('chat.copy', 'Copy')}
                                    </button>
                                </div>
                                <div className="px-2.5 py-1.5 rounded text-[11px] leading-relaxed font-mono" style={{ background: 'var(--bg-primary)', maxHeight: '180px', overflow: 'auto' }}>
                                    {entries.map(([token, value]) => (
                                        <div key={token} className="flex gap-2 items-baseline">
                                            <code className="shrink-0" style={{ color: 'var(--accent-primary)' }}>{token}</code>
                                            <span style={{ color: 'var(--text-tertiary)' }}>→</span>
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
                        const entries = Object.entries(info.tokenMap).sort((a, b) => (b[1]?.length || 0) - (a[1]?.length || 0));
                        let out = shownResponse;
                        for (const [token, value] of entries) {
                            if (!value) continue;
                            const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                            out = out.replace(new RegExp(escaped, 'g'), token);
                        }
                        return out;
                    })();
                    return (
                        <div className="mt-3 pt-2 border-t" style={{ borderColor: 'var(--border-subtle)' }}>
                            <Row
                                label={t('privacy.row_original', 'Original message')}
                                text={originalUserMsg}
                                hint={t('privacy.row_original_hint', 'stays on your device')}
                                revealable
                            />
                            <Row
                                label={t('privacy.row_sent', 'Sent to AI')}
                                text={info.tokenizedPrompt}
                                hint={info.provider ? t('privacy.row_sent_hint', 'via {provider}', { provider: info.provider }) : undefined}
                            />
                            <TokenMapRow tokenMap={info.tokenMap} />
                            <Row
                                label={t('privacy.row_returned', 'What the AI returned')}
                                text={aiReturnedText}
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
