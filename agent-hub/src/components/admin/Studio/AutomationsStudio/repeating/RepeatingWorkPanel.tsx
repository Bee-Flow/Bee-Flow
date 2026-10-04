import { CalendarRange, CircleSlash } from 'lucide-react';
import { useState } from 'react';
import type { ReasonCode, RepeatingSuggestion } from '../../../../../api/queries/automation/repeating';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { CANVAS_CHIP, DOT_GRID } from '../../../../automation/Builder/flow/canvasClasses';
import PatternsSection from './PatternsSection';
import type { PatternActions } from './PatternsSection';
import PrivacyFootnote from './PrivacyFootnote';
import RepeatingEmpty from './RepeatingEmpty';
import ScanFlow, { ScanDetails } from './ScanFlow';
import SourceTiles from './SourceTiles';
import useRepeatingScan from './useRepeatingScan';
import type { RepeatingScan } from './useRepeatingScan';

type BuildFn = (s: RepeatingSuggestion, opts: { autoSend: boolean }) => void;

export interface RepeatingWorkPanelProps {
    /** Build this → `{ autoSend: true }` (the builder sends it at once); Adjust first → `{ autoSend: false }` (pre-filled). */
    onBuild?: BuildFn;
    /** The launcher's existing pair, used when `onBuild` is not given: Build this / Adjust first. */
    onBuildSuggestion?: (s: RepeatingSuggestion) => void;
    onAskSuggestion?: (s: RepeatingSuggestion) => void;
    /** How long Undo is offered after Not now / Not repetitive. */
    undoMs?: number;
}

/** Why the scan cannot run right now, or null when it can. */
function disabledReason(scan: RepeatingScan, t: TranslateFn): string | null {
    if (scan.cooldown > 0) {
        return t('automations.repeating.cooldown', 'You have scanned a lot in a short time. You can scan again in {seconds}s.', { seconds: scan.cooldown });
    }
    if (scan.selected.size === 0) return t('automations.repeating.disabledNoSources', 'Switch on at least one source to scan.');
    return null;
}

function Header({ windowDays }: { windowDays: number }) {
    const { t } = useTranslation();
    return (
        <header className="flex flex-col gap-1.5">
            <div className="flex items-center gap-2 flex-wrap">
                <h2 className="m-0 text-[15px] font-semibold text-[var(--text-primary)]">{t('automations.repeating.title', 'Find repeating work')}</h2>
                <span className={CANVAS_CHIP}>
                    <CalendarRange size={12} aria-hidden="true" />
                    {t('automations.repeating.windowChip', 'Last {days} days', { days: windowDays })}
                </span>
            </div>
            <p className="m-0 text-[12px] leading-relaxed text-[var(--text-tertiary)]">
                {t('automations.repeating.intro', 'Bee reads your recent activity in the apps you pick and suggests work worth automating. It only reads, and nothing is built without you.')}
            </p>
        </header>
    );
}

function SourcesError({ onRetry }: { onRetry: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-center gap-3 flex-wrap text-[12px] text-[var(--text-secondary)]" data-testid="repeating-sources-error">
            <span>{t('automations.repeating.sourcesError', 'Bee could not load your sources.')}</span>
            <button type="button" onClick={onRetry} className={CANVAS_CHIP}>{t('automations.repeating.tryAgain', 'Try again')}</button>
        </div>
    );
}

/** The four actions a card offers, wired to feedback and the builder. */
function useCardActions(scan: RepeatingScan, build: BuildFn): PatternActions {
    const { feedback } = scan;
    return {
        onBuild: (s, opts) => { feedback.opened(s, opts.autoSend); build(s, opts); },
        onSnooze: s => feedback.hide(s, 'snoozed'),
        onNotRepetitive: (s, reason: ReasonCode) => feedback.hide(s, 'dismissed', reason),
        onDismiss: s => feedback.hide(s, 'dismissed'),
    };
}

/** Sources and scan action, then the live flow or the last scan's footnote. */
function ScanArea({ scan, detailsOpen, setDetailsOpen }: { scan: RepeatingScan; detailsOpen: boolean; setDetailsOpen: (fn: (o: boolean) => boolean) => void }) {
    const { t } = useTranslation();
    const { run, result } = scan;
    const toggleDetails = () => setDetailsOpen(o => !o);
    return (
        <>
            <SourceTiles
                groups={scan.groups} selected={scan.selected} onToggle={scan.toggleSource} busy={run.scanning}
                focus={scan.focus} setFocus={scan.setFocus} focusOpen={scan.focusOpen} setFocusOpen={scan.setFocusOpen}
                action={run.scanning ? null : {
                    scanned: !!result, lastScannedAt: result?.scannedAt ?? null, onScan: force => { void scan.scan(force); },
                    disabledReason: disabledReason(scan, t),
                }}
            />
            {run.scanning && <ScanFlow run={run} labelFor={scan.labelFor} detailsOpen={detailsOpen} onToggleDetails={toggleDetails} onStop={scan.cancel} />}
            {!run.scanning && run.stopped && (
                <p role="status" className="m-0 flex items-center gap-1.5 text-[12px] text-[var(--text-secondary)]">
                    <CircleSlash size={13} aria-hidden="true" className="text-[var(--text-tertiary)]" />
                    {t('automations.repeating.stopped', 'Scan stopped. Nothing new was saved.')}
                </p>
            )}
            {!run.scanning && result && (
                <PrivacyFootnote mode={result.mode} summary={result.summary} steps={run.mode === result.mode ? run.steps : []}
                    labelFor={scan.labelFor} detailsOpen={detailsOpen} onToggleDetails={toggleDetails} />
            )}
            {detailsOpen && <ScanDetails steps={run.steps} labelFor={scan.labelFor} />}
        </>
    );
}

/**
 * "Find repeating work" (Studio → Automations), on a dot-grid surface like
 * the automation canvas: the sources as trigger nodes, the scan as a live
 * mini flow, and each repeating pattern as a canvas card with its evidence.
 *
 * The data layer is useRepeatingScan: the server's source groups, the last
 * scan (painted on mount without scanning again), the SSE scan, the ideas
 * fallback, and Not now / Not repetitive recorded on the server by the
 * pattern's signature with Undo.
 */
export default function RepeatingWorkPanel({ onBuild, onBuildSuggestion, onAskSuggestion, undoMs }: RepeatingWorkPanelProps) {
    const scan = useRepeatingScan({ undoMs });
    const [detailsOpen, setDetailsOpen] = useState(false);
    const build: BuildFn = (s, opts) => {
        if (onBuild) onBuild(s, opts);
        else if (opts.autoSend) onBuildSuggestion?.(s);
        else onAskSuggestion?.(s);
    };
    const actions = useCardActions(scan, build);
    const { run, result } = scan;
    const looked = (result?.summary?.sources ?? result?.summary?.integrations ?? []).map(scan.labelFor).join(', ');
    let body = null;
    if (scan.sourcesError) body = <SourcesError onRetry={() => { void scan.reloadSources(); }} />;
    else if (scan.sourcesLoaded && !scan.groups.some(g => g.connected)) body = <RepeatingEmpty kind="no_connected" />;
    else if (scan.sourcesLoaded) {
        body = (
            <>
                <ScanArea scan={scan} detailsOpen={detailsOpen} setDetailsOpen={setDetailsOpen} />
                <PatternsSection
                    suggestions={scan.suggestions} busy={run.scanning} scanningPatterns={run.scanning && run.mode === 'patterns'}
                    scanned={!!result} reason={result?.reason ?? null} looked={looked}
                    // Try again re-runs what failed: an ideas run must not come back as a patterns scan.
                    error={run.error} onRetry={() => { void (run.mode === 'ideas' ? scan.suggestIdeas() : scan.scan(true)); }} stale={scan.stale}
                    ideas={scan.ideas} onSuggestIdeas={() => { void scan.suggestIdeas(); }}
                    pending={scan.feedback.pending} onUndo={scan.feedback.undo} onCloseUndo={scan.feedback.commit}
                    labelFor={scan.labelFor} actions={actions}
                />
            </>
        );
    }
    return (
        // @container/repeating: tiles, flow and cards adapt to this panel's own width, not the viewport's.
        <div className={`@container/repeating flex flex-col gap-5 rounded-[var(--radius-lg)] border border-[var(--border-default)] px-5 py-5 ${DOT_GRID}`} data-testid="find-repeating-work">
            <Header windowDays={scan.windowDays} />
            {body}
        </div>
    );
}
