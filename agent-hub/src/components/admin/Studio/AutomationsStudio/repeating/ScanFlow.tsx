import { ChevronDown, ChevronRight, Loader2, ShieldAlert, ShieldCheck, Square } from 'lucide-react';
import type { TranslateFn } from '../../../../../hooks/useTranslation';
import { useTranslation } from '../../../../../hooks/useTranslation';
import { CANVAS_CHIP } from '../../../../automation/Builder/flow/canvasClasses';
import type { MiniStatus } from '../../../../automation/Builder/flow/canvasClasses';
import CanvasPill from '../../../../automation/Builder/flow/CanvasPill';
import MiniFlow from '../../../../automation/Builder/flow/MiniFlow';
import type { MiniNodeProps } from '../../../../automation/Builder/flow/MiniNode';
import { eventsText } from './patternView';
import type { RunState, SourceStep } from './useRepeatingScan';

type LabelFor = (id: string) => string;

/** Where each patterns-mode phase sits in the four-step flow. */
const PHASE_STEP: Readonly<Record<string, number>> = Object.freeze({ collecting: 0, templating: 1, mining: 2, naming: 3 });

/** "Show details" / "Hide details": the per-source log sits behind it. */
export function DetailsToggle({ open, onToggle }: { open: boolean; onToggle: () => void }) {
    const { t } = useTranslation();
    return (
        <button
            type="button"
            aria-expanded={open}
            onClick={onToggle}
            className="inline-flex items-center gap-1 text-[11px] text-[var(--text-tertiary)] hover:text-[var(--text-primary)] transition"
        >
            {open ? <ChevronDown size={11} aria-hidden="true" /> : <ChevronRight size={11} aria-hidden="true" />}
            {open ? t('automations.repeating.hideDetails', 'Hide details') : t('automations.repeating.showDetails', 'Show details')}
        </button>
    );
}

const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** What the scan is doing right now, in one sentence. */
export function progressText(run: RunState, labelFor: LabelFor, t: TranslateFn): string {
    switch (run.phase) {
        case 'templating': return t('automations.repeating.progressTemplating', 'Finding templates…');
        case 'mining': return t('automations.repeating.progressMining', 'Spotting what repeats…');
        case 'naming': return t('automations.repeating.progressNaming', 'Naming the patterns…');
        case 'synthesising': return t('automations.repeating.reviewing', 'Looking for patterns in what Bee read…');
        default: {
            const current = [...run.steps].reverse().find(s => s.status === 'start');
            if (current) return t('automations.repeating.reading', 'Reading {app}…', { app: labelFor(current.app) });
            return t('automations.repeating.starting', 'Starting the scan…');
        }
    }
}

/**
 * A skip reason in words. The patterns scan sends a code (sources/index.js:
 * auth, error, timeout, budget, aborted, not_connected, shield); an ideas read
 * the Shield blocked sends none. A code this page does not know yet is never
 * shown raw; a sentence from the server is.
 */
export function skipReason(reason: string | null, t: TranslateFn): string {
    switch (reason) {
        case null:
        case 'shield':
        case 'blocked': return t('automations.repeating.logBlocked', 'blocked by Privacy Shield');
        case 'timeout': return t('automations.repeating.skipTimeout', 'took too long');
        case 'budget': return t('automations.repeating.skipBudget', 'the scan ran out of time');
        case 'auth': return t('automations.repeating.skipAuth', 'needs to be connected again');
        case 'not_connected': return t('automations.repeating.skipNotConnected', 'not connected');
        case 'error': return t('automations.repeating.skipError', 'could not be read');
        default: return /^[a-z_]+$/.test(reason) ? t('automations.repeating.skipError', 'could not be read') : reason;
    }
}

function stepLine(s: SourceStep, labelFor: LabelFor, t: TranslateFn): string {
    const app = labelFor(s.app);
    if (s.status === 'skipped') return `${t('automations.repeating.logSkippedApp', 'Skipped {app}', { app })} · ${skipReason(s.reason, t)}`;
    if (s.status === 'start') return t('automations.repeating.logReadingApp', 'Reading {app}', { app });
    const read = t('automations.repeating.logReadApp', 'Read {app}', { app });
    return s.events != null ? `${read} · ${eventsText(s.events, t)}` : read;
}

/** The per-source log: what was (or is being) read, by app name, with the Shield's verdict. */
export function ScanDetails({ steps, labelFor }: { steps: SourceStep[]; labelFor: LabelFor }) {
    const { t } = useTranslation();
    if (!steps.length) return null;
    return (
        <ul className="m-0 p-0 list-none rounded-[var(--radius-md)] border border-[var(--border-default)] bg-[var(--bg-card)] divide-y divide-[var(--border-default)]" data-testid="scan-log">
            {steps.map(s => (
                <li key={s.key} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                    {s.status === 'start' && <Loader2 size={12} className="animate-spin text-[var(--text-tertiary)] shrink-0" aria-hidden="true" />}
                    {s.status === 'done' && <ShieldCheck size={12} className="text-[var(--success)] shrink-0" aria-hidden="true" />}
                    {s.status === 'skipped' && <ShieldAlert size={12} className="text-[var(--warning)] shrink-0" aria-hidden="true" />}
                    <span className={`flex-1 min-w-0 truncate ${s.status === 'skipped' ? 'text-[var(--warning)]' : 'text-[var(--text-secondary)]'}`}>
                        {stepLine(s, labelFor, t)}
                    </span>
                    {s.piiCategories.length > 0 && <CanvasPill tone="warning">{s.piiCategories.join(', ')}</CanvasPill>}
                </li>
            ))}
        </ul>
    );
}

function statusOf(i: number, current: number): MiniStatus {
    if (i < current) return 'done';
    return i === current ? 'running' : 'idle';
}

/** The record pills: events, templates, repeats and named patterns, in the singular where it is one. */
function flowPills(run: RunState, t: TranslateFn): Array<string | undefined> {
    const events = run.stats?.events ?? run.steps.reduce((n, s) => n + (s.events ?? 0), 0);
    const named = run.streamed.length;
    const s = run.stats;
    return [
        events > 0 ? eventsText(events, t) : undefined,
        s ? plural(s.templates, t('automations.repeating.flowTemplateOne', '1 template'), t('automations.repeating.flowTemplateCount', '{count} templates', { count: s.templates })) : undefined,
        s ? plural(s.candidates, t('automations.repeating.flowRepeatOne', '1 repeat'), t('automations.repeating.flowRepeatCount', '{count} repeats', { count: s.candidates })) : undefined,
        named > 0 ? plural(named, t('automations.repeating.flowPatternOne', '1 pattern'), t('automations.repeating.flowPatternCount', '{count} patterns', { count: named })) : undefined,
    ];
}

/** The four steps of a patterns scan as canvas nodes, with their record pills. */
export function flowNodes(run: RunState, labelFor: LabelFor, t: TranslateFn): MiniNodeProps[] {
    const current = run.phase != null && run.phase in PHASE_STEP ? PHASE_STEP[run.phase] : 0;
    const read = run.steps.filter(s => s.status === 'done').length;
    const reading = [...run.steps].reverse().find(s => s.status === 'start');
    const pills = flowPills(run, t);
    const step = (n: number) => t('automations.repeating.flowStep', 'Step {n}', { n });
    let readSub = '';
    if (reading) readSub = labelFor(reading.app);
    else if (read > 0) readSub = plural(read, t('automations.repeating.readOne', '1 source read'), t('automations.repeating.readCount', '{count} sources read', { count: read }));
    return [
        { family: 'data', eyebrow: step(1), title: t('automations.repeating.flowRead', 'Read your work'), sub: readSub, status: statusOf(0, current), pill: pills[0] },
        { family: 'data', eyebrow: step(2), title: t('automations.repeating.flowTemplates', 'Find templates'), sub: t('automations.repeating.flowTemplatesSub', 'Names and numbers masked'), status: statusOf(1, current), pill: pills[1] },
        { family: 'branch', eyebrow: step(3), title: t('automations.repeating.flowRepeats', 'Spot repeats'), sub: t('automations.repeating.flowRepeatsSub', 'How often, how steady'), status: statusOf(2, current), pill: pills[2] },
        { family: 'ai', eyebrow: step(4), title: t('automations.repeating.flowName', 'Name patterns'), sub: t('automations.repeating.flowNameSub', 'The AI sees patterns only'), status: statusOf(3, current), pill: pills[3] },
    ];
}

/**
 * A running scan, drawn the way the canvas draws a run: Read your work →
 * Find templates → Spot repeats → Name patterns, each node with its status
 * ring and a record pill on its outgoing line. One status sentence above it
 * says what is happening now; the per-source log is behind "Show details",
 * and Stop is a canvas chip. The ideas fallback has no such steps, so it
 * gets the sentence alone.
 */
export default function ScanFlow({ run, labelFor, detailsOpen, onToggleDetails, onStop }: {
    run: RunState;
    labelFor: LabelFor;
    detailsOpen: boolean;
    onToggleDetails: () => void;
    onStop: () => void;
}) {
    const { t } = useTranslation();
    return (
        <section className="flex flex-col gap-4" data-testid="scan-progress" aria-label={t('automations.repeating.scanRunning', 'Scan in progress')}>
            <div className="flex items-center gap-2 flex-wrap text-[12px] text-[var(--text-secondary)]">
                <Loader2 size={13} className="animate-spin text-[var(--type-ai)] shrink-0" aria-hidden="true" />
                <span role="status" aria-live="polite">{progressText(run, labelFor, t)}</span>
                <span className="ml-auto flex items-center gap-3">
                    {run.steps.length > 0 && <DetailsToggle open={detailsOpen} onToggle={onToggleDetails} />}
                    <button type="button" onClick={onStop} className={`${CANVAS_CHIP} hover:text-[var(--text-primary)] transition`}>
                        <Square size={11} aria-hidden="true" />
                        {t('automations.repeating.stop', 'Stop')}
                    </button>
                </span>
            </div>
            {run.mode === 'patterns' && <MiniFlow nodes={flowNodes(run, labelFor, t)} testId="scan-flow" />}
        </section>
    );
}
