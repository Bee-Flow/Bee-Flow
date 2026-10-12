// An admin's decision about ONE open finding, in the check table: acknowledge,
// accept the risk (with a reason and an optional review date), snooze for 7 or
// 30 days (one "Snooze" menu button), or re-open. The decision only takes the finding off "Needs
// attention" while it stays exactly the same (the server holds its
// fingerprint); the check keeps running and the row keeps its status.
//
// `FindingStateChip` is the small label the row shows while a decision exists.

import { BellOff, CheckCheck, ChevronDown, RotateCcw, ShieldQuestion } from 'lucide-react';
import React, { useId, useRef, useState } from 'react';
import type { ComponentType } from 'react';
import useTranslation from '../../../../../hooks/useTranslation';
import AnchoredMenuJs from '../../../../shared/AnchoredMenu';

// A .jsx module whose `= null` defaults would type the props as null-only.
const AnchoredMenu = AnchoredMenuJs as unknown as ComponentType<Record<string, unknown>>;

export type FindingStateName = 'acknowledged' | 'accepted_risk' | 'snoozed';

export interface FindingStateView {
    state: FindingStateName;
    reason?: string | null;
    until?: string | null;
    active?: boolean;
}

export interface DecidableCheck {
    check_id: string;
    scope_id?: string | null;
    status?: string;
    finding_state?: FindingStateView | null;
}

export type FindingDecisionBody =
    | { state: 'acknowledged' | 'open' }
    | { state: 'snoozed'; days: 7 | 30 }
    | { state: 'accepted_risk'; reason: string; until?: string };

export type DecideFinding = (checkId: string, scopeId: string | null, body: FindingDecisionBody) => Promise<unknown>;

const DAY_MS = 86_400_000;
/** The server's ceiling for a review date (routes/compliance/findingStates.js). */
const MAX_REVIEW_DAYS = 365;

/** A local calendar day as the date input writes it (YYYY-MM-DD). */
function localDay(d: Date): string {
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * The days a review date may be: from tomorrow to a year from today, in the
 * reader's own calendar. The server refuses a date that is not in the future
 * or more than a year away; today is always refused, since its noon may
 * already be past.
 */
export function reviewDateBounds(now: Date = new Date()): { min: string; max: string } {
    const at = (days: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, 12);
    return { min: localDay(at(1)), max: localDay(at(MAX_REVIEW_DAYS)) };
}

/**
 * The instant sent for a review day: that day's noon where the reader is. A
 * day between the bounds is then always in the future and within a year
 * wherever the reader is — midnight UTC was already past for half the world
 * on the day before, and in the past for the day itself.
 */
export function reviewDateToIso(day: string): string {
    return new Date(`${day}T12:00:00`).toISOString();
}

/** What a refused decision says, from the server's status and code. */
export function decisionErrorText(err: unknown, t: (key: string, fallback: string) => string): string {
    const e = (err && typeof err === 'object' ? err : {}) as { status?: number; code?: string | null };
    if (e.code === 'finding_not_open') return t('compliance.finding_state.error_not_open', 'This finding is no longer open, so there is nothing to decide. The list shows its current state.');
    if (e.code === 'framework_disabled') return t('compliance.finding_state.error_framework_off', 'This check belongs to a framework that is not active for your organisation.');
    if (e.code === 'unknown_check' || e.status === 404) return t('compliance.finding_state.error_unknown_check', 'This check no longer exists.');
    if (e.status === 400) return t('compliance.finding_state.error_invalid', 'The decision was refused. Check the reason, and pick a review date between tomorrow and a year from today.');
    if (e.status === 403) return t('compliance.finding_state.error_forbidden', 'Only a compliance administrator can decide about findings.');
    return t('compliance.finding_state.failed', 'The decision could not be saved.');
}

const BTN = 'inline-flex items-center gap-1 h-7 px-2 rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-card)] text-[11px] font-medium text-[var(--text-primary)] whitespace-nowrap hover:bg-[var(--bg-secondary)] disabled:opacity-60 disabled:cursor-not-allowed';
const PRIMARY = 'inline-flex items-center gap-1 h-7 px-2.5 rounded-[8px] text-[11px] font-semibold bg-[var(--accent-primary)] text-[var(--accent-primary-fg)] disabled:opacity-60';

function formatDay(value: string | null | undefined, locale: string): string {
    if (!value) return '';
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    try { return new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', year: 'numeric' }).format(d); }
    catch { return d.toISOString().slice(0, 10); }
}

/** The label of a decision, in the reader's language. */
export function useFindingStateLabel() {
    const { t, locale } = useTranslation();
    return (s: FindingStateView): string => {
        if (s.state === 'snoozed') return t('compliance.finding_state.snoozed', 'Snoozed until {date}', { date: formatDay(s.until, locale) });
        if (s.state === 'accepted_risk') return t('compliance.finding_state.accepted_risk', 'Risk accepted');
        return t('compliance.finding_state.acknowledged', 'Acknowledged');
    };
}

export function FindingStateChip({ state, testId }: { state: FindingStateView | null | undefined; testId?: string }) {
    const label = useFindingStateLabel();
    if (!state || state.active === false) return null;
    return (
        <span
            className="inline-flex items-center gap-1 h-[18px] px-1.5 rounded-full border border-[var(--border-default)] text-[10px] font-medium text-[var(--text-secondary)] whitespace-nowrap"
            data-testid={testId}
            data-state={state.state}
        >
            <CheckCheck size={10} aria-hidden="true" />
            {label(state)}
        </span>
    );
}

function CurrentDecision({ current, testId }: { current: FindingStateView | null; testId: string }) {
    const { t } = useTranslation();
    const label = useFindingStateLabel();
    if (!current) {
        return (
            <p className="m-0 text-[11px] text-[var(--text-tertiary)]">
                {t('compliance.finding_state.explain', 'Takes this finding off Needs attention while it stays exactly the same. It comes back when it changes.')}
            </p>
        );
    }
    return (
        <div className="flex flex-col gap-0.5 text-[11px]" data-testid={`${testId}-current`}>
            <span className="text-[var(--text-primary)] font-medium">{label(current)}</span>
            {current.reason ? (
                <span className="text-[var(--text-secondary)]">{t('compliance.finding_state.reason', 'Reason: {reason}', { reason: current.reason })}</span>
            ) : null}
            {current.active === false ? (
                <span className="text-[var(--text-tertiary)]" data-testid={`${testId}-lapsed`}>
                    {t('compliance.finding_state.lapsed', 'Your decision no longer applies — the finding changed')}
                </span>
            ) : null}
        </div>
    );
}

function ReviewDateField({ id, value, onChange, invalid, testId }: {
    id: string; value: string; onChange: (v: string) => void; invalid: boolean; testId: string;
}) {
    const { t } = useTranslation();
    const { min, max } = reviewDateBounds();
    const hintId = `${id}-hint`;
    return (
        <>
            <label htmlFor={id} className="text-[11px] font-medium text-[var(--text-primary)]">
                {t('compliance.finding_state.review_by', 'Review by (optional)')}
            </label>
            <input
                id={id}
                type="date"
                value={value}
                min={min}
                max={max}
                onChange={(e) => onChange(e.target.value)}
                aria-invalid={invalid || undefined}
                aria-describedby={invalid ? hintId : undefined}
                className="h-7 w-44 rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-card)] px-2 text-[12px] text-[var(--text-primary)]"
                data-testid={`${testId}-until`}
            />
            {invalid ? (
                <span id={hintId} className="text-[11px] text-[var(--text-secondary)]" role="alert" data-testid={`${testId}-until-invalid`}>
                    {t('compliance.finding_state.review_by_range', 'Pick a day between tomorrow and a year from today.')}
                </span>
            ) : null}
        </>
    );
}

function AcceptRiskForm({ busy, onSave, onCancel, testId }: {
    busy: boolean;
    onSave: (body: FindingDecisionBody) => void;
    onCancel: () => void;
    testId: string;
}) {
    const { t } = useTranslation();
    const reasonId = useId();
    const untilId = useId();
    const [reason, setReason] = useState('');
    const [until, setUntil] = useState('');
    const [reasonShort, setReasonShort] = useState(false);
    const [untilInvalid, setUntilInvalid] = useState(false);

    const save = () => {
        const r = reason.trim();
        const { min, max } = reviewDateBounds();
        // A typed date is not held to min/max by every browser.
        const badDay = !!until && (until < min || until > max);
        setReasonShort(r.length < 3);
        setUntilInvalid(badDay);
        if (r.length < 3 || badDay) return;
        onSave(until
            ? { state: 'accepted_risk', reason: r, until: reviewDateToIso(until) }
            : { state: 'accepted_risk', reason: r });
    };

    return (
        <div className="flex flex-col gap-1.5" data-testid={`${testId}-accept-form`}>
            <label htmlFor={reasonId} className="text-[11px] font-medium text-[var(--text-primary)]">
                {t('compliance.finding_state.reason_label', 'Why is this risk accepted?')}
            </label>
            <textarea
                id={reasonId}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                maxLength={500}
                rows={2}
                placeholder={t('compliance.finding_state.reason_placeholder', 'For example: legal hold until the case closes')}
                aria-invalid={reasonShort || undefined}
                className="w-full rounded-[8px] border border-[var(--border-default)] bg-[var(--bg-card)] px-2 py-1 text-[12px] text-[var(--text-primary)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)]"
                data-testid={`${testId}-reason`}
            />
            {reasonShort ? (
                <span className="text-[11px] text-[var(--text-secondary)]" role="alert">
                    {t('compliance.finding_state.reason_short', 'Write a reason of at least 3 characters.')}
                </span>
            ) : null}
            <ReviewDateField id={untilId} value={until} onChange={(v) => { setUntil(v); setUntilInvalid(false); }} invalid={untilInvalid} testId={testId} />
            <div className="flex items-center gap-2">
                <button type="button" className={PRIMARY} disabled={busy} onClick={save} data-testid={`${testId}-accept-save`}>
                    {busy ? t('compliance.finding_state.saving', 'Saving…') : t('compliance.finding_state.save', 'Accept risk')}
                </button>
                <button type="button" className={BTN} disabled={busy} onClick={onCancel}>
                    {t('compliance.finding_state.cancel', 'Cancel')}
                </button>
            </div>
        </div>
    );
}

const MENU_ITEM = 'w-full flex items-center px-2.5 h-8 rounded-[6px] text-left text-[12px] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] focus:outline-none focus-visible:bg-[var(--bg-secondary)]';

/** One "Snooze" button with a small menu: 7 days or 30 days. */
function SnoozeMenu({ busy, onSnooze, testId }: {
    busy: boolean;
    onSnooze: (days: 7 | 30) => void;
    testId: string;
}) {
    const { t } = useTranslation();
    const anchorRef = useRef<HTMLButtonElement | null>(null);
    const [open, setOpen] = useState(false);
    const pick = (days: 7 | 30) => { setOpen(false); onSnooze(days); };
    return (
        <>
            <button
                ref={anchorRef}
                type="button"
                className={BTN}
                disabled={busy}
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={() => setOpen((v) => !v)}
                onKeyDown={(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } }}
                data-testid={`${testId}-snooze`}
            >
                <BellOff size={11} aria-hidden="true" /> {t('compliance.finding_state.snooze', 'Snooze')}
                <ChevronDown size={11} aria-hidden="true" />
            </button>
            <AnchoredMenu
                open={open}
                onClose={() => setOpen(false)}
                anchorRef={anchorRef}
                align="left"
                minWidth={140}
                role="menu"
                aria-label={t('compliance.finding_state.snooze', 'Snooze')}
                className="p-1"
                data-testid={`${testId}-snooze-menu`}
            >
                <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => pick(7)} data-testid={`${testId}-snooze-7`}>
                    {t('compliance.finding_state.snooze_7_short', '7 days')}
                </button>
                <button type="button" role="menuitem" className={MENU_ITEM} onClick={() => pick(30)} data-testid={`${testId}-snooze-30`}>
                    {t('compliance.finding_state.snooze_30_short', '30 days')}
                </button>
            </AnchoredMenu>
        </>
    );
}

function DecisionButtons({ open, hasDecision, busy, onSend, onAccept, testId }: {
    open: boolean;
    hasDecision: boolean;
    busy: boolean;
    onSend: (body: FindingDecisionBody) => void;
    onAccept: () => void;
    testId: string;
}) {
    const { t } = useTranslation();
    return (
        <div className="flex flex-wrap items-center gap-1.5">
            {open ? (
                <>
                    <button type="button" className={BTN} disabled={busy} onClick={() => onSend({ state: 'acknowledged' })} data-testid={`${testId}-ack`}>
                        <CheckCheck size={11} aria-hidden="true" /> {t('compliance.finding_state.acknowledge', 'Acknowledge')}
                    </button>
                    <button type="button" className={BTN} disabled={busy} onClick={onAccept} data-testid={`${testId}-accept`}>
                        <ShieldQuestion size={11} aria-hidden="true" /> {t('compliance.finding_state.accept_risk', 'Accept risk…')}
                    </button>
                    <SnoozeMenu busy={busy} onSnooze={(days) => onSend({ state: 'snoozed', days })} testId={testId} />
                </>
            ) : null}
            {hasDecision ? (
                <button type="button" className={BTN} disabled={busy} onClick={() => onSend({ state: 'open' })} data-testid={`${testId}-reopen`}>
                    <RotateCcw size={11} aria-hidden="true" /> {t('compliance.finding_state.reopen', 'Re-open')}
                </button>
            ) : null}
        </div>
    );
}

export default function FindingDecision({ check, onDecide, testId = 'finding-decision' }: {
    check: DecidableCheck;
    onDecide?: DecideFinding;
    testId?: string;
}) {
    const { t } = useTranslation();
    const [busy, setBusy] = useState(false);
    const [failed, setFailed] = useState<string | null>(null);
    const [accepting, setAccepting] = useState(false);

    const open = check.status === 'warn' || check.status === 'fail';
    const current = check.finding_state || null;
    if (typeof onDecide !== 'function' || (!open && !current)) return null;

    const send = async (body: FindingDecisionBody) => {
        setBusy(true);
        setFailed(null);
        try {
            await onDecide(check.check_id, check.scope_id ?? null, body);
            setAccepting(false);
        } catch (err) {
            setFailed(decisionErrorText(err, t));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-col gap-1.5 pt-2 mt-1 border-t border-[var(--border-default)]" data-testid={testId} role="group"
            aria-label={t('compliance.finding_state.group_aria', 'Decide about this finding')}>
            <div className="text-[10px] uppercase tracking-[.08em] font-semibold text-[var(--text-tertiary)]">
                {t('compliance.finding_state.heading', 'Your decision')}
            </div>
            <CurrentDecision current={current} testId={testId} />
            {accepting ? (
                <AcceptRiskForm busy={busy} onSave={(b) => { void send(b); }} onCancel={() => setAccepting(false)} testId={testId} />
            ) : (
                <DecisionButtons open={open} hasDecision={!!current} busy={busy} onSend={(b) => { void send(b); }} onAccept={() => setAccepting(true)} testId={testId} />
            )}
            {failed ? (
                <span className="text-[11px] text-[var(--text-secondary)]" role="alert" data-testid={`${testId}-failed`}>
                    {failed}
                </span>
            ) : null}
        </div>
    );
}
