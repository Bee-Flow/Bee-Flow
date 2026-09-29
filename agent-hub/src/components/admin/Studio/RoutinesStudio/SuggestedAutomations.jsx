import { Check, Clock, Lightbulb, Plug, Search, ShieldCheck, XCircle } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import ScanLog from './ScanLog';
import ScanProgress, { DetailsToggle } from './ScanProgress';
import ScanResultsHeader from './ScanResultsHeader';
import SuggestionSkeleton from './SuggestionSkeleton';
import SuggestionsSection from './SuggestionsSection';
import useSuggestionScan from './useSuggestionScan';
import useAutomationApi from '../../../../hooks/useAutomationApi';
import { useTranslation } from '../../../../hooks/useTranslation';

/**
 * "Find repeating work" (Studio → Automations), in the handoff 5 language: a
 * header that says what Bee scans and that nothing is built without you, the
 * apps to look at, then ONE of three things: the "Scan my recent work"
 * button (no scan yet), a compact progress line (scanning; the per-source log
 * sits behind "Show details"), or the last scan's result with "Scanned <when>
 * · Scan again". Suggestions are compact rows; an empty result says why and
 * what to try.
 *
 * Thin orchestrator over useSuggestionScan: the hook owns the catalog load,
 * the READ-ONLY Privacy-Shield-guarded SSE scan, the live per-tool log, and
 * the persisted last-scan / dismiss / built state (the last result paints
 * straight away on mount, without a new scan).
 *
 * Public contract (unchanged): onBuildSuggestion / onAskSuggestion are called
 * with the chosen suggestion. We additionally record best-effort feedback and
 * track "built" locally so the row greys out.
 */
export default function SuggestedAutomations({ onBuildSuggestion, onAskSuggestion }) {
    const { t } = useTranslation();
    const api = useAutomationApi();
    const scan = useSuggestionScan();
    const [detailsOpen, setDetailsOpen] = useState(false);

    const feedback = (action, suggestion, reasonText) => {
        try {
            api.recordSuggestionFeedback?.({ action, suggestion, reason: reasonText });
        } catch { /* best-effort */ }
    };
    const actions = {
        build: (s) => { scan.markBuilt(s); feedback('built', s); onBuildSuggestion?.(s); },
        ask: (s) => { feedback('asked', s); onAskSuggestion?.(s); },
        dismiss: (s) => { scan.dismiss(s); feedback('dismissed', s); },
    };

    // 1s ticker while a rate-limit cooldown is active so the countdown updates
    // and the controls re-enable the instant it elapses.
    const { rateLimitedUntil } = scan;
    const [now, setNow] = useState(() => Date.now());
    useEffect(() => {
        if (!rateLimitedUntil) return undefined;
        setNow(Date.now());
        const id = setInterval(() => {
            const tick = Date.now();
            setNow(tick);
            if (tick >= rateLimitedUntil) clearInterval(id);
        }, 1000);
        return () => clearInterval(id);
    }, [rateLimitedUntil]);
    const cooldown = rateLimitedUntil ? Math.max(0, Math.ceil((rateLimitedUntil - now) / 1000)) : 0;

    return (
        // @container/repeating: the scope row and the suggestion list adapt by
        // this tab's own width (see SuggestionsSection), not the viewport's.
        <div className="@container/repeating flex flex-col gap-5" data-testid="find-repeating-work">
            <header className="flex flex-col gap-1">
                <h2 className="m-0 text-[15px] font-semibold text-[var(--text-primary)]">{t('routines.repeating.title', 'Find repeating work')}</h2>
                <p className="m-0 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
                    {t('routines.repeating.intro', 'Bee reads your recent activity in the apps you pick and suggests work worth automating. It only reads, and nothing is built without you.')}
                </p>
            </header>
            {/* Until the catalog resolves we don't know if there's anything to show. */}
            {scan.catalogLoaded && (scan.apps.length === 0
                ? (
                    <Notice
                        icon={<Plug size={16} aria-hidden="true" />}
                        title={t('routines.repeating.noAppsTitle', 'Nothing to scan yet')}
                        body={[t('routines.repeating.noAppsBody', 'Connect an app first. Bee can only look at apps you have connected.')]}
                        testId="repeating-no-apps"
                    />
                )
                : (
                    <>
                        <ScopeRow scan={scan} />
                        <ScanStatus scan={scan} cooldown={cooldown} detailsOpen={detailsOpen} setDetailsOpen={setDetailsOpen} />
                        {detailsOpen && <ScanLog steps={scan.scanSteps} labelFor={scan.labelFor} />}
                        <ScanResults scan={scan} cooldown={cooldown} actions={actions} />
                    </>
                ))}
        </div>
    );
}

/** "Look at" + one chip per connected app, and an optional focus. */
function ScopeRow({ scan }) {
    const { t } = useTranslation();
    const { apps, selected, toggle, focus, setFocus, scanning } = scan;
    return (
        <div className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 flex-wrap">
                <span className="text-[12px] font-medium text-[var(--text-secondary)] mr-1">{t('routines.repeating.lookAt', 'Look at')}</span>
                {apps.map((a) => {
                    const on = selected.has(a.id);
                    return (
                        <button
                            key={a.id}
                            type="button"
                            onClick={() => toggle(a.id)}
                            aria-pressed={on}
                            disabled={scanning}
                            className={`inline-flex items-center gap-1 text-[11px] px-2.5 py-1 rounded-full border transition disabled:opacity-50 ${
                                on
                                    ? 'border-[var(--text-tertiary)] bg-[var(--bg-tertiary)] text-[var(--text-primary)] font-medium'
                                    : 'border-[var(--border-default)] text-[var(--text-tertiary)] hover:bg-[var(--bg-secondary)]'
                            }`}
                        >
                            {on && <Check size={11} aria-hidden="true" />}
                            {a.label || a.id}
                        </button>
                    );
                })}
            </div>
            <input
                type="text"
                value={focus}
                onChange={(e) => setFocus(e.target.value)}
                disabled={scanning}
                aria-label={t('routines.repeating.focusLabel', 'Focus (optional)')}
                placeholder={t('routines.repeating.focusPlaceholder', 'Optional: a focus, like invoices or support tickets')}
                className="w-full @[56rem]/repeating:max-w-xl text-[12px] px-2.5 py-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] placeholder:text-[var(--text-tertiary)] outline-none focus:border-[var(--accent-primary)] disabled:opacity-50"
            />
        </div>
    );
}

/** The one thing to do now: scan, watch the scan, or look at the last one. */
function ScanStatus({ scan, cooldown, detailsOpen, setDetailsOpen }) {
    const { t } = useTranslation();
    const { scanning, scanned, selected, scanSteps } = scan;
    const toggleDetails = () => setDetailsOpen(o => !o);
    if (scanning) {
        return (
            <ScanProgress
                phase={scan.phase}
                steps={scanSteps}
                labelFor={scan.labelFor}
                detailsOpen={detailsOpen}
                onToggleDetails={toggleDetails}
                onStop={scan.cancel}
            />
        );
    }
    if (scanned) {
        return (
            <div className="flex flex-col gap-1">
                <ScanResultsHeader lastScannedAt={scan.lastScannedAt} onRescan={scan.scan} disabled={cooldown > 0 || selected.size === 0} />
                <PrivacySummary scan={scan} detailsOpen={detailsOpen} onToggleDetails={toggleDetails} />
            </div>
        );
    }
    return (
        <div className="flex items-center gap-3 flex-wrap">
            <button
                type="button"
                onClick={() => scan.scan(false)}
                disabled={selected.size === 0 || cooldown > 0}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg text-[12.5px] font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] transition-opacity hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed"
            >
                <Search size={13} aria-hidden="true" />
                {t('routines.repeating.scan', 'Scan my recent work')}
            </button>
            <span className="text-[11px] text-[var(--text-tertiary)]">
                {t('routines.repeating.scanHint', 'Takes about a minute. Privacy Shield checks everything Bee reads.')}
            </span>
        </div>
    );
}

/** "Looked at Gmail · 3 reads · no personal data found", as parts. */
function summaryParts(summary, labelFor, t) {
    const parts = [];
    const apps = Array.isArray(summary?.integrations) ? summary.integrations : [];
    if (apps.length) parts.push(t('routines.repeating.lookedAt', 'Looked at {apps}', { apps: apps.map(labelFor).join(', ') }));
    const calls = summary?.toolCalls;
    if (calls === 1) parts.push(t('routines.repeating.oneRead', '1 read'));
    else if (typeof calls === 'number') parts.push(t('routines.repeating.reads', '{count} reads', { count: calls }));
    if (apps.length) {
        const pii = summary.piiCategories || [];
        parts.push(pii.length
            ? t('routines.repeating.personalData', 'personal data found: {categories}', { categories: pii.join(', ') })
            : t('routines.repeating.noPersonalData', 'no personal data found'));
    }
    return parts;
}

/** What the last scan read, what the Privacy Shield saw, and the log toggle. */
function PrivacySummary({ scan, detailsOpen, onToggleDetails }) {
    const { t } = useTranslation();
    const { summary, scanSteps, labelFor } = scan;
    const blocked = scanSteps.filter((s) => s.status === 'blocked');
    const parts = summaryParts(summary, labelFor, t);
    if (!parts.length && !blocked.length && !scanSteps.length) return null;
    return (
        <div className="flex flex-col gap-1 text-[11px] text-[var(--text-tertiary)]">
            {(parts.length > 0 || scanSteps.length > 0) && (
                <div className="flex items-center gap-1.5 flex-wrap">
                    {parts.length > 0 && <ShieldCheck size={12} aria-hidden="true" className="text-[var(--success)] flex-shrink-0" />}
                    {parts.length > 0 && <span>{parts.join(' · ')}</span>}
                    {scanSteps.length > 0 && <DetailsToggle open={detailsOpen} onToggle={onToggleDetails} />}
                </div>
            )}
            {blocked.length > 0 && (
                <div className="flex items-center gap-1.5 text-[var(--warning)]">
                    <ShieldCheck size={12} aria-hidden="true" className="flex-shrink-0" />
                    <span>{t('routines.repeating.skipped', 'Privacy Shield skipped {apps}. Bee did not read those.', { apps: blocked.map((s) => labelFor(s.integration)).join(', ') })}</span>
                </div>
            )}
        </div>
    );
}

/** The suggestions, or a calm sentence about why there are none. */
function ScanResults({ scan, cooldown, actions }) {
    const { t } = useTranslation();
    const { error, scanning, scanned, suggestions } = scan;
    return (
        <>
            {cooldown > 0 && (
                <div role="status" className="flex items-center gap-2 text-[12px] text-[var(--warning)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] px-3 py-2">
                    <Clock size={14} aria-hidden="true" className="flex-shrink-0" />
                    <span>{t('routines.repeating.cooldown', 'You have scanned a lot in a short time. You can scan again in {seconds}s.', { seconds: cooldown })}</span>
                </div>
            )}
            {error && (
                <Notice
                    icon={<XCircle size={16} aria-hidden="true" className="text-[var(--error)]" />}
                    title={t('routines.repeating.errorTitle', 'Bee could not finish the scan')}
                    body={[error]}
                    action={{ label: t('routines.repeating.tryAgain', 'Try again'), onClick: () => scan.scan(true) }}
                    testId="repeating-error"
                />
            )}
            {!error && scanning && suggestions.length === 0 && <SuggestionSkeleton count={3} />}
            {!error && !scanning && cooldown === 0 && scanned && suggestions.length === 0 && <EmptyResult scan={scan} />}
            {!error && suggestions.length > 0 && (
                <SuggestionsSection
                    suggestions={suggestions}
                    onBuildDirectly={actions.build}
                    onAskForChanges={actions.ask}
                    onDismiss={actions.dismiss}
                    dismissed={scan.dismissed}
                    builtIds={scan.builtIds}
                    labelFor={scan.labelFor}
                />
            )}
        </>
    );
}

/** A finished scan without suggestions: why, and what to try. */
function EmptyResult({ scan }) {
    const { t } = useTranslation();
    if (scan.reason === 'no_integrations') {
        return (
            <Notice
                icon={<Plug size={16} aria-hidden="true" />}
                title={t('routines.repeating.noAppsTitle', 'Nothing to scan yet')}
                body={[t('routines.repeating.noAppsBody', 'Connect an app first. Bee can only look at apps you have connected.')]}
                testId="repeating-empty"
            />
        );
    }
    const looked = (scan.summary?.integrations || []).map(scan.labelFor).join(', ');
    return (
        <Notice
            icon={<Lightbulb size={16} aria-hidden="true" />}
            title={t('routines.repeating.emptyTitle', 'No repeating work spotted')}
            body={[
                looked
                    ? t('routines.repeating.emptyWhy', 'Bee read {apps} but found nothing that repeats often enough to automate.', { apps: looked })
                    : t('routines.repeating.emptyWhyGeneric', 'Bee found nothing that repeats often enough to automate.'),
                t('routines.repeating.emptyTry', 'Try more apps, name a focus such as invoices or support tickets, or scan again in a week or two.'),
            ]}
            testId="repeating-empty"
        />
    );
}

/** A quiet bordered note: icon, title, a sentence or two, maybe one action. */
function Notice({ icon, title, body = [], action = null, testId }) {
    return (
        <div className="flex items-start gap-3 px-4 py-3.5 rounded-[10px] border border-dashed border-[var(--border-default)]" data-testid={testId}>
            <span className="mt-0.5 flex-shrink-0 text-[var(--text-tertiary)]">{icon}</span>
            <div className="min-w-0 flex-1">
                <div className="text-[13px] font-medium text-[var(--text-primary)]">{title}</div>
                {body.map((p) => (
                    <p key={p} className="m-0 mt-0.5 text-[12px] leading-snug text-[var(--text-tertiary)]">{p}</p>
                ))}
                {action && (
                    <button
                        type="button"
                        onClick={action.onClick}
                        className="mt-2 px-3 py-1.5 rounded-lg text-[12px] font-medium border border-[var(--border-default)] bg-[var(--bg-card)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] transition"
                    >
                        {action.label}
                    </button>
                )}
            </div>
        </div>
    );
}
