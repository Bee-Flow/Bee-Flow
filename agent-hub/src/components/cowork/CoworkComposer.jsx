/**
 * The Cowork input box — the one there is.
 *
 * Both places you can hand Bee Flow a brief render this: the chat composer
 * with the Chat ⇄ Cowork switch flipped, and the /app/cowork page. They used
 * to be two hand-rolled boxes, which is exactly how the page ended up without
 * an Apps picker and without a model-tier picker, and silently scheduling
 * everything on `auto`.
 *
 * One slot keeps the surfaces honest instead of forking the component:
 * `chatTools` — the chat's own buttons (attach, skills, KB, …). They are
 * rendered hidden rather than unmounted so their popovers keep state across a
 * switch back to Chat. The page passes nothing.
 *
 * Everything else — placeholder, aria labels, the chips row, the Apps picker,
 * the tier pickers, the Run/Schedule button — is fixed here so it cannot drift
 * apart again.
 *
 * Deliberately not shown: a footer restating the schedule ("Now · results land
 * in your notifications") and the page's quota counter. The chips above already
 * say when it runs, the button already says Run vs Schedule, and the quota only
 * matters once it is reached — where the page raises it as a real warning.
 */
import { ArrowUp } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import useTranslation from '../../hooks/useTranslation';
import TierSlider from '../licensing/TierSlider';
import AppsPicker from '../apps/AppsPicker';
import { seedTextForApp } from '../apps/appCatalog';
import CoworkOptionsBar from './CoworkOptionsBar';
import { appendAppSeed } from './coworkSeed';
import useCoworkApps from './useCoworkApps';

// Still exported: it is the English fallback both surfaces pass to t(), so
// the two cannot drift apart even in a locale that has no translation yet.
export const COWORK_PLACEHOLDER = 'Describe the work — Bee Flow runs it and reports back';

export default function CoworkComposer({
    value,
    onChange,
    onSubmit,
    cowork,
    // Model tier. Omit `modelTiers` and the pickers simply don't render —
    // which is what a surface without a tier concern wants.
    modelTiers = null,
    selectedTier = 'auto',
    onTierChange,
    // Apps picker gating. `simpleMode` and `disableExternalTools` are the two
    // reasons to hide it; `agentIntegrations` narrows it inside agent chat.
    simpleMode = false,
    disableExternalTools = false,
    agentIntegrations = null,
    isMobile = false,
    minRows = 1,
    error = null,
    chatTools = null,
    textareaRef: externalRef = null,
}) {
    const { t } = useTranslation();
    const innerRef = useRef(null);
    const textareaRef = externalRef || innerRef;
    // Set by the Apps picker so the next render can drop the caret behind the
    // seed it just appended. React restores the selection it had before on a
    // controlled textarea, which would otherwise leave you typing mid-brief.
    const seedJustAdded = useRef(false);
    const { availableApps, isAppEnabled, toggleApp, appsUnavailable } = useCoworkApps({
        agentIntegrations,
        value: cowork.enabledApps,
        onChange: cowork.setEnabledApps,
    });

    // Auto-resize. We toggle overflow-y inline so the scrollbar (or its native
    // +/- arrows on some GTK themes) only appears once the content actually
    // exceeds the 180px cap — otherwise it stays hidden.
    //
    // `minRows` has to be re-applied as a floor here, not left to the `rows`
    // attribute: this effect runs on mount and writes an explicit height, which
    // overrules `rows` immediately. That is why the page asked for three rows
    // and got the same single line as the chat.
    useEffect(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.style.height = 'auto';
        const cs = window.getComputedStyle(el);
        const lineHeight = parseFloat(cs.lineHeight) || 24;
        const padding = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
        const floor = minRows * lineHeight + padding;
        const needsScroll = el.scrollHeight > 180;
        el.style.height = Math.max(floor, Math.min(el.scrollHeight, 180)) + 'px';
        el.style.overflowY = needsScroll ? 'auto' : 'hidden';
    }, [value, minRows, textareaRef]);

    useEffect(() => {
        if (!seedJustAdded.current) return;
        seedJustAdded.current = false;
        const el = textareaRef.current;
        if (!el || typeof el.setSelectionRange !== 'function') return;
        el.focus();
        const end = el.value.length;
        el.setSelectionRange(end, end);
    }, [value, textareaRef]);

    const canSend = !!String(value || '').trim() && !cowork.submitting && cowork.scheduleReady;

    const submit = () => { if (canSend && onSubmit) onSubmit(); };

    // Enter sends, Shift+Enter breaks the line, Cmd/Ctrl+Enter also sends.
    // The page used to be Cmd+Enter-only while the chat sent on Enter — the
    // same box behaving differently depending on where you opened it.
    const onKeyDown = (e) => {
        if (e.key !== 'Enter') return;
        if (e.shiftKey) return;
        e.preventDefault();
        submit();
    };

    const showTiers = !simpleMode && !!modelTiers;

    return (
        <div
            role="form"
            aria-label={t('cowork.composer.form_aria', 'Cowork brief input')}
            data-testid="cowork-composer"
            data-tour="cowork-composer"
            data-cowork-mode="cowork"
            className="chat-composer relative flex flex-col rounded-2xl border transition-all focus-within:ring-2 focus-within:ring-[var(--accent-primary)]/35 ring-1 ring-[var(--accent-primary)]/40"
            style={{ background: 'var(--bg-card)', borderColor: 'var(--border-subtle)' }}
        >
            <div className={`${isMobile ? 'px-2' : 'px-4'} pt-3 pb-1`}>
                <textarea
                    ref={textareaRef}
                    value={value}
                    onChange={e => { seedJustAdded.current = false; onChange(e.target.value); }}
                    onKeyDown={onKeyDown}
                    rows={minRows}
                    placeholder={t('cowork.composer.placeholder', COWORK_PLACEHOLDER)}
                    aria-label={t('cowork.composer.brief_aria', 'Cowork brief')}
                    data-testid="cowork-brief-input"
                    className="w-full max-h-[180px] bg-transparent border-none focus:ring-0 text-[var(--text-primary)] placeholder-[var(--text-muted)] resize-none py-2 text-[15px] leading-relaxed outline-none"
                />
            </div>

            {/* Toolbar row. It is justify-between, so a third child would be
                pushed to the middle — which is exactly where the apps picker
                used to float. Everything on the left lives in one group; only
                the send cluster sits opposite. */}
            <div className="flex items-center justify-between px-3 pb-3 gap-2">
                <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                    <CoworkOptionsBar
                        when={cowork.when}
                        onWhenChange={cowork.setWhen}
                        repeatInterval={cowork.repeatInterval}
                        onRepeatChange={cowork.setRepeatInterval}
                        agentId={cowork.agentId}
                        onAgentChange={cowork.setAgentId}
                        agents={cowork.agents}
                        isMobile={isMobile}
                    />
                    {chatTools}
                    {/* An unreadable workspace list is not "you switched
                        everything off". The picker's own "0/2 active" cannot
                        tell those apart, and the item this box creates sends
                        no per-item list at all — which the server reads as
                        "follow the workspace list", i.e. the widest answer
                        there is. The screen would be claiming the narrowest
                        while the unattended run got the widest, so it says
                        plainly that it does not know. */}
                    {!simpleMode && !disableExternalTools && appsUnavailable && (
                        <span
                            role="status"
                            data-testid="cowork-apps-unavailable"
                            className="text-[11.5px] px-1.5"
                            style={{ color: 'var(--text-tertiary)' }}
                        >
                            {t('cowork.composer.apps_unavailable', 'App list unavailable — this run follows your workspace list')}
                        </span>
                    )}
                    {!simpleMode && !disableExternalTools && !appsUnavailable && (
                        <AppsPicker
                            apps={availableApps}
                            isAppEnabled={isAppEnabled}
                            toggleApp={toggleApp}
                            onPick={(app) => {
                                const seed = seedTextForApp(app);
                                if (seed) {
                                    seedJustAdded.current = true;
                                    onChange(appendAppSeed(value, seed));
                                }
                                textareaRef.current?.focus();
                            }}
                        />
                    )}
                </div>

                <div className="flex items-center gap-2">
                    {/* One control: the tier carries its own reasoningEffort, so
                        the slider position IS the thinking depth. */}
                    {showTiers && (
                        <div className="mr-1">
                            <TierSlider
                                tiers={modelTiers}
                                value={selectedTier}
                                onChange={onTierChange}
                                variant="input"
                            />
                        </div>
                    )}
                    <button
                        type="button"
                        onClick={submit}
                        disabled={!canSend}
                        data-testid="cowork-send"
                        title={cowork.summary}
                        className="inline-flex items-center gap-1.5 pl-3.5 pr-3 py-2 rounded-full text-[12.5px] font-semibold text-white transition-all shadow-sm active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ background: 'var(--accent-primary)' }}
                    >
                        {cowork.submitting
                            ? t('cowork.composer.starting', 'Starting…')
                            : t(
                                cowork.when.presetId === 'now' ? 'cowork.composer.run' : 'cowork.composer.schedule',
                                cowork.when.presetId === 'now' ? 'Run' : 'Schedule',
                            )}
                        <ArrowUp className="w-4 h-4" />
                    </button>
                </div>
            </div>

            {(error || cowork.error) && (
                <div className="px-4 pb-3 -mt-1 text-[12px] text-red-600 dark:text-red-400" role="alert">
                    {error || cowork.error}
                </div>
            )}
        </div>
    );
}
