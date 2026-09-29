/**
 * The send cluster — everything on the RIGHT of the composer's toolbar row.
 *
 * Four things, in the order they sit: what happens to personal data in this
 * message (C5), how deep the next answer runs (the tier gauge, direct chat
 * only), the microphone that types for you, and the one button that sends,
 * stops, or offers voice chat instead.
 *
 * That last button is a single slot with three faces on purpose. While a turn
 * streams it is Stop. With an empty box and voice chat available it is a mic —
 * an empty composer has nothing to send, so the button offers the other way to
 * say something rather than sitting there inert, and it keeps the quiet grey
 * an empty composer wears. Type a character and it is Send again.
 *
 * Dictation is handed in whole (`dictation`, from useDictation) rather than
 * started here: the hook has to outlive this cluster, because the transcript
 * comes back seconds after the button was pressed and the composer may have
 * changed shape in the meantime.
 */
import { ArrowUp, Loader2, Mic, ShieldAlert, ShieldCheck, Square, StopCircle } from 'lucide-react';
import React from 'react';

import useTranslation from '../../../hooks/useTranslation';
import TierSlider from '../../licensing/TierSlider';

const ComposerActions = ({
    shieldClaim,
    showTierSlider,
    modelTiers,
    selectedTier,
    onTierChange,
    memoryWriteEnabled,
    toggleMemoryWrite,
    dictation,
    simpleMode,
    compact,
    isLoading,
    onStopGenerating,
    nothingToSend,
    voiceReady,
    onStartVoiceMode,
    onSend,
}) => {
    const { t } = useTranslation();
    const ShieldIcon = shieldClaim?.tone === 'warn' ? ShieldAlert : ShieldCheck;

    return (
        <div className="flex items-center gap-2 min-w-0">
            {/* C5 — what happens to personal data in this
                message, before it is sent. Silent unless the
                status route actually substantiates a claim:
                unknown, unreachable or off says nothing at
                all, and a shield that is on while nothing
                can be scanned says so in a warning tone
                rather than wearing the green lock. */}
            {shieldClaim && (
                <span
                    data-testid="composer-shield-line"
                    data-shield-tone={shieldClaim.tone}
                    title={t(shieldClaim.key, shieldClaim.en)}
                    className="hidden sm:inline-flex items-center gap-1 min-w-0"
                    style={{
                        fontSize: '11px', lineHeight: 1.2,
                        color: shieldClaim.tone === 'warn' ? 'var(--warning)' : 'var(--text-tertiary)',
                    }}
                >
                    <ShieldIcon
                        aria-hidden="true"
                        className="w-3.5 h-3.5"
                        style={{
                            flexShrink: 0,
                            color: shieldClaim.tone === 'warn' ? 'var(--warning)' : 'var(--success)',
                        }}
                    />
                    <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t(shieldClaim.key, shieldClaim.en)}
                    </span>
                </span>
            )}

            {/* Response depth (Direct Mode). One control: each tier
                carries its own reasoningEffort server-side, so the
                slider position IS the thinking effort. The separate
                effort dropdown that used to sit beside this is gone,
                and the memory switch rides in its panel. */}
            {showTierSlider && (
                <div className="mr-1">
                    <TierSlider
                        tiers={modelTiers}
                        value={selectedTier}
                        onChange={onTierChange}
                        variant="input"
                        memory={{ enabled: memoryWriteEnabled, onToggle: toggleMemoryWrite }}
                    />
                </div>
            )}

            {/* Dictation — speak instead of type. Hidden when the
                browser has no microphone API at all (a page served
                over plain HTTP on a LAN IP has none), because the
                button could not be made to work there. */}
            {dictation.supported && !simpleMode && (
                <button
                    type="button"
                    onClick={dictation.toggle}
                    disabled={dictation.state === 'transcribing'}
                    className={`${compact ? 'p-1.5' : 'p-2'} rounded-full transition-colors active:scale-95 transform duration-100 ${
                        dictation.state === 'recording'
                            ? 'bg-red-500 text-white hover:bg-red-600'
                            : 'text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                    }`}
                    title={dictation.state === 'recording'
                        ? t('chat.composer.dictate_stop', 'Stop recording and insert the text')
                        : t('chat.composer.dictate_start', 'Dictate — speak your instruction')}
                    aria-label={dictation.state === 'recording'
                        ? t('chat.composer.dictate_stop', 'Stop recording and insert the text')
                        : t('chat.composer.dictate_start', 'Dictate — speak your instruction')}
                    data-testid="dictate-button"
                >
                    {dictation.state === 'transcribing'
                        ? <Loader2 className={`${compact ? 'w-4 h-4' : 'w-5 h-5'} animate-spin`} />
                        : dictation.state === 'recording'
                            ? <Square className={compact ? 'w-4 h-4' : 'w-5 h-5'} />
                            : <Mic className={compact ? 'w-4 h-4' : 'w-5 h-5'} />}
                </button>
            )}
            {dictation.state === 'recording' && (
                <span className="text-[11px] tabular-nums text-red-500 select-none" data-testid="dictate-timer">
                    {String(Math.floor(dictation.seconds / 60)).padStart(2, '0')}:{String(dictation.seconds % 60).padStart(2, '0')}
                </span>
            )}
            {dictation.error && dictation.state === 'idle' && (
                // Dismissed on the next attempt, and clickable to
                // dismiss now — a mic failure is usually a browser
                // permission the user has to go and fix anyway.
                <button
                    type="button"
                    onClick={dictation.clearError}
                    className="text-[11px] text-red-500 max-w-[220px] truncate text-left"
                    title={dictation.error}
                    data-testid="dictate-error"
                >
                    {dictation.error}
                </button>
            )}

            {/* Send / Stop Buttons */}
            {isLoading ? (
                <button
                    onClick={onStopGenerating}
                    className={`${compact ? 'p-1.5' : 'p-2'} bg-red-500 text-white rounded-full hover:bg-red-600 transition-colors shadow-sm active:scale-95 transform duration-100`}
                    title={t('chat.composer.stop_generating', 'Stop generating')}
                    aria-label={t('chat.composer.stop_generating', 'Stop generating')}
                    data-testid="stop-generating-button"
                >
                    <StopCircle className={compact ? 'w-4 h-4' : 'w-5 h-5'} />
                </button>
            ) : nothingToSend && voiceReady && !simpleMode ? (
                /* An empty box has nothing to send, so the
                   button offers the other way to say something
                   instead of sitting there inert. It stays in
                   the quiet grey an empty composer wears —
                   start typing and it turns back into Send. */
                <button
                    onClick={onStartVoiceMode}
                    className={`${compact ? 'p-1.5' : 'p-2'} composer-send-quiet text-[var(--bg-primary)] rounded-full transition-all shadow-sm active:scale-95 transform duration-100`}
                    title={t('chat.composer.voice_send_hint', 'Voice Chat (Beta) — talk with your assistant')}
                    aria-label={t('chat.composer.voice_send_label', 'Start voice chat')}
                    data-testid="voice-send-button"
                >
                    <Mic className={compact ? 'w-4 h-4' : 'w-6 h-6'} />
                </button>
            ) : (
                <button
                    onClick={onSend}
                    disabled={nothingToSend}
                    className={`${compact ? 'p-1.5' : 'p-2'} text-[var(--bg-primary)] rounded-full transition-all shadow-sm active:scale-95 transform duration-100 ${
                        nothingToSend
                            ? 'composer-send-quiet cursor-not-allowed'
                            : 'bg-[var(--text-primary)] hover:opacity-90'
                    }`}
                    title={t('chat.composer.send_hint', 'Send message (Enter)')}
                    aria-label={t('chat.composer.send_label', 'Send message')}
                    data-testid="send-message-button"
                >
                    <ArrowUp className={compact ? 'w-4 h-4' : 'w-6 h-6'} />
                </button>
            )}
        </div>
    );
};

export default ComposerActions;
