/**
 * What a card, a list row and a sidebar row SAY about an automation's state,
 * decided once and React-free so it can be tested as data.
 *
 * Two questions, kept apart because they have different answers:
 *   - lifecycle: is it on? (live / paused / draft — shared/statusOf)
 *   - outcome:   what did the last run do? (running / failed / ok / other)
 *
 * Noise is dropped here rather than greyed out in the view: a draft that
 * never ran says nothing about runs (it cannot have run), while a live or
 * paused automation that never ran says "Never ran", because there that is
 * news.
 */
import { automation as lifecycleOf } from '../../../shared/statusOf';
import { isFailing, triggerKindOf, triggerLabelOf, triggerTextOf, type AutomationRecord } from './overviewModel';
import { automationStatusParts, type StatusPart } from './automationStatus';
import { toneLabelOf, triggerToneOf } from './triggerTone';
import { describeCron } from '../../../automation/Builder/flow/scheduleBuilderUtils';
import type { TranslateFn } from '../../../../hooks/useTranslation';

type Lifecycle = 'live' | 'paused' | 'draft';
type Outcome = 'running' | 'failed' | 'ok' | 'other' | 'never';

export interface CardStatus {
    lifecycle: Lifecycle;
    /** null: nothing worth saying about runs (a draft that never ran). */
    outcome: Outcome | null;
}

export function cardStatusOf(a: AutomationRecord | null | undefined, liveRunning = false): CardStatus {
    const lifecycle = lifecycleOf(a) as Lifecycle;
    let outcome: Outcome | null;
    if (liveRunning || a?.lastStatus === 'running') outcome = 'running';
    else if (isFailing(a)) outcome = 'failed';
    else if (!a?.lastStatus) outcome = lifecycle === 'draft' ? null : 'never';
    else if (a.lastStatus === 'success') outcome = 'ok';
    else outcome = 'other';
    return { lifecycle, outcome };
}

// Shallow cron syntax check — catches obvious typos (wrong field count, bad
// characters) without pulling in cron-parser. Full semantic validation lives
// server-side via /api/automation/_schedule/preview.
export function isCronShapeValid(s: string | null | undefined): boolean {
    if (!s || typeof s !== 'string') return false;
    const parts = s.trim().split(/\s+/);
    if (parts.length !== 5 && parts.length !== 6) return false;
    return parts.every(p => /^[\d*/,\-?LW]+$/i.test(p));
}

/**
 * The trigger in a few words, for a narrow row: "Every day at 09:00" (no
 * timezone), "New file (Nextcloud)", "Webhook", "By hand".
 */
export function triggerShortOf(a: AutomationRecord | null | undefined, t: TranslateFn | null): string {
    const kind = triggerKindOf(a);
    if (kind === 'schedule' && a?.scheduleCron) {
        return isCronShapeValid(a.scheduleCron)
            ? describeCron(a.scheduleCron)
            : (t ? t('studio_misc.overview.invalid_schedule', 'Invalid schedule') : 'Invalid schedule');
    }
    if (kind === 'app_event') return triggerTextOf(a, t);
    if (kind === 'webhook') return triggerLabelOf('webhook', t);
    return toneLabelOf(triggerToneOf(a), t);
}

type RowMetaTone = StatusPart['tone'] | 'failed' | 'trigger';
export interface RowMetaPart { tone: RowMetaTone; text: string }

/**
 * The sidebar row's one quiet line: the state in one word, pending changes
 * when there are any, then either "Last run failed" (the one thing worth
 * shouting) or the trigger in a few words.
 *
 *   "Live · v3 · Every day at 09:00"   "Draft · Form"   "Paused · Last run failed"
 *
 * The builder header's "Draft · never live" is shortened to "Draft" here: in
 * a 260px column the second half only pushed the trigger out of sight.
 */
export function rowMetaParts(a: AutomationRecord, t: TranslateFn): RowMetaPart[] {
    const parts: RowMetaPart[] = automationStatusParts(a, t).map(p => (
        p.tone === 'draft' ? { tone: p.tone, text: t('studio_misc.overview.status_draft', 'Draft') } : p
    ));
    if (isFailing(a)) parts.push({ tone: 'failed', text: t('studio_misc.overview.last_run_failed', 'Last run failed') });
    else parts.push({ tone: 'trigger', text: triggerShortOf(a, t) });
    return parts;
}
