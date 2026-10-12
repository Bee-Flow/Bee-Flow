// Schedule-related popover + modal extracted from BuilderSplit. Two components
// share the constants and the formatter, so they live in one file together
// instead of being scattered.

import { Plus, Play, Pause, Sliders, Trash2, X } from 'lucide-react';
import React, { useState, useRef, useEffect } from 'react';
import { API_BASE, authFetch } from '../../../../utils/helpers';
import { computeScheduleNextRun } from '../../../../utils/scheduleNextRun';
import Modal from '../../../shared/Modal';

// Day-picker UI order — Monday-first (European convention). Token strings
// match the server's tokens exactly. Date math (`getDay()` lookups) lives in
// utils/scheduleNextRun.js with its own Sunday-first internal array.
export const AUTOMATION_DOW_TOKENS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
export const AUTOMATION_DOW_LABELS = { sun: 'Sun', mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat' };

// Validated IANA timezone list. `Intl.supportedValuesOf('timeZone')` returns
// the full ~400 zones the runtime supports (broadly available since 2022).
// User's current TZ is hoisted to the top of the dropdown.
export const AUTOMATION_TIMEZONES = (() => {
    const all = (typeof Intl?.supportedValuesOf === 'function')
        ? Intl.supportedValuesOf('timeZone')
        : [];
    const here = (() => {
        try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return 'UTC'; }
    })();
    if (!Array.isArray(all) || all.length === 0) return [here || 'UTC'];
    const sorted = [...all].sort();
    const ordered = [here, 'UTC', ...sorted.filter(tz => tz !== here && tz !== 'UTC')];
    const seen = new Set();
    return ordered.filter(tz => (tz && !seen.has(tz) && seen.add(tz)));
})();

export function formatScheduleNextRun(iso, t) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const now = new Date();
    const diffMs = d - now;
    const sameDay = d.toDateString() === now.toDateString();
    const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
    const isTomorrow = d.toDateString() === tomorrow.toDateString();
    const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
    // The fallback goes THROUGH t(), never after it with `||`: t() answers a
    // missing key with the raw key, which is truthy, so the `|| 'Overdue'`
    // this used to carry could never fire. Here that was dead code rather than
    // a visible bug — all three keys sit in both dictionaries, so t() handed
    // back the English regardless — but the shape is one rename away from
    // printing "agent_schedules.overdue" on screen, which is why i18nGuard bans it
    // outright. Without a t (pure callers) the shim hands the fallback back
    // itself.
    const _t = typeof t === 'function' ? t : ((_key, fallback) => fallback);
    if (diffMs < 0) return `${_t('agent_schedules.overdue', 'Overdue')} (${d.toLocaleString()})`;
    if (sameDay) return `${_t('agent_schedules.today_at', 'Today at')} ${time}`;
    if (isTomorrow) return `${_t('agent_schedules.tomorrow_at', 'Tomorrow at')} ${time}`;
    return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function SchedulesPicker({ t, agent, schedules, onClose, onCreate, onEdit, onToggle, onRunNow, onDelete }) {
    const popoverRef = useRef(null);
    useEffect(() => {
        const onDoc = (e) => {
            if (popoverRef.current?.contains(e.target)) return;
            // Ignore clicks on this picker's own trigger pill — let the trigger's
            // onClick handle the toggle. Without this, the close handler races
            // with the trigger and the picker stays open on close-click.
            if (e.target.closest?.('[data-popover-trigger="schedules"]')) return;
            onClose();
        };
        document.addEventListener('mousedown', onDoc);
        return () => document.removeEventListener('mousedown', onDoc);
    }, [onClose]);
    return (
        <div
            ref={popoverRef}
            className="absolute z-30 top-full left-0 mt-2 w-[460px] max-h-[70vh] overflow-y-auto rounded-xl border border-[var(--border-default)] bg-[var(--bg-card,#fff)] shadow-xl"
        >
            <div className="px-4 py-3 border-b border-[var(--border-default)] flex items-center justify-between">
                <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-[var(--text-primary)]">{t('agent_schedules.title', 'Schedules')}</span>
                    <span className="text-[10px] uppercase tracking-wide font-medium px-1.5 py-0.5 rounded-full bg-[var(--accent)]/15 text-[var(--accent)]">
                        {t('agent_schedules.beta_badge', 'Beta')}
                    </span>
                </div>
                <button onClick={onClose} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"><X size={14} /></button>
            </div>
            <div className="p-3">
                <button
                    type="button"
                    onClick={onCreate}
                    className="w-full mb-2 flex items-center justify-center gap-1.5 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card,#fff)] text-[var(--text-primary)] hover:bg-[var(--bg-secondary)] text-sm font-medium transition"
                >
                    <Plus size={14} /> {t('agent_schedules.new', 'New schedule')}
                </button>
                {schedules.length === 0 ? (
                    <div className="text-xs text-[var(--text-tertiary)] py-6 text-center">
                        {t('agent_schedules.none_for_agent', 'No schedules yet for this agent.')}
                    </div>
                ) : (
                    <div className="divide-y divide-[var(--border-default)]">
                        {schedules.map((r) => (
                            <div key={r.id} className="py-2 flex items-start gap-2">
                                <div className="flex-1 min-w-0">
                                    <div className="text-sm text-[var(--text-primary)] truncate">{r.title}</div>
                                    <div className="text-[11px] text-[var(--text-tertiary)] truncate">
                                        {r.isActive
                                            ? `${t('agent_schedules.scheduled_for', 'Scheduled for')}: ${formatScheduleNextRun(r.nextRunAt, t)}`
                                            : (t('agent_schedules.paused', 'Paused'))}
                                    </div>
                                </div>
                                <div className="flex items-center gap-0.5 flex-shrink-0">
                                    <button onClick={() => onRunNow(r)} title={t('agent_schedules.run_now', 'Run now')} className="p-1.5 rounded hover:bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition">
                                        <Play size={13} />
                                    </button>
                                    <button onClick={() => onToggle(r)} title={r.isActive ? (t('agent_schedules.pause', 'Pause')) : (t('agent_schedules.resume', 'Resume'))} className="p-1.5 rounded hover:bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition">
                                        {r.isActive ? <Pause size={13} /> : <Play size={13} />}
                                    </button>
                                    <button onClick={() => onEdit(r)} title={t('agent_schedules.edit', 'Edit')} className="p-1.5 rounded hover:bg-[var(--bg-secondary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition">
                                        <Sliders size={13} />
                                    </button>
                                    <button onClick={() => onDelete(r)} title={t('agent_schedules.delete', 'Delete')} className="p-1.5 rounded hover:bg-red-500/10 text-[var(--text-tertiary)] hover:text-red-500 transition">
                                        <Trash2 size={13} />
                                    </button>
                                </div>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

export function ScheduleModal({ t, agent, initialSchedule, onClose, onSaved }) {
    const isEdit = !!initialSchedule;
    // `mode` maps directly to the server's repeatInterval value, plus 'hourly'
    // which the UI special-cases (hours-N input instead of day picker).
    const [mode, setMode] = useState(() => initialSchedule?.repeatInterval || 'daily');
    const [title, setTitle] = useState(initialSchedule?.title || '');
    const [prompt, setPrompt] = useState(initialSchedule?.prompt || '');
    const [hours, setHours] = useState(1);
    const [daysOfWeek, setDaysOfWeek] = useState(() => {
        if (Array.isArray(initialSchedule?.daysOfWeek) && initialSchedule.daysOfWeek.length > 0) return initialSchedule.daysOfWeek;
        return ['mon', 'tue', 'wed', 'thu', 'fri'];
    });
    // Day of month for Monthly mode (1-28 to dodge Feb edge cases).
    const [dayOfMonth, setDayOfMonth] = useState(() => {
        if (initialSchedule?.repeatInterval === 'monthly' && initialSchedule?.nextRunAt) {
            return new Date(initialSchedule.nextRunAt).getDate();
        }
        return 1;
    });
    const [time, setTime] = useState(initialSchedule?.timeOfDay || '08:00');
    const [timezone, setTimezone] = useState(initialSchedule?.timezone || (Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(null);

    useEffect(() => {
        const onKey = (e) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [onClose]);

    // 'daily' / 'weekdays' / 'weekly' / 'biweekly' all use the day-of-week picker.
    const usesDayPicker = mode === 'daily' || mode === 'weekdays' || mode === 'weekly' || mode === 'biweekly';
    const usesDayOfMonth = mode === 'monthly';

    const toggleDay = (d) => {
        setDaysOfWeek(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d]);
    };

    // Compute the next run. For day-based cadences we use the shared TZ-aware
    // helper so the wall-clock anchor matches the user's selected timezone.
    // For Hourly we honour the modal's "Run every N hours" picker for the
    // FIRST run (the runner's advanceNextRun then rolls each subsequent fire
    // by 1 hour — matching the existing aiTaskStore semantics).
    const computeNextRun = () => {
        if (mode === 'hourly') {
            const next = new Date();
            next.setHours(next.getHours() + Number(hours || 1));
            next.setMinutes(0); next.setSeconds(0); next.setMilliseconds(0);
            return next.toISOString();
        }
        return computeScheduleNextRun({
            repeatInterval: mode,
            daysOfWeek: (mode === 'daily' || mode === 'weekly' || mode === 'biweekly') ? daysOfWeek : null,
            timeOfDay: time,
            dayOfMonth: usesDayOfMonth ? dayOfMonth : null,
        }, timezone);
    };

    const submit = async () => {
        setError(null);
        if (!title.trim()) { setError(t('agent_schedules.error_title_required', 'Title is required')); return; }
        if (!prompt.trim()) { setError(t('agent_schedules.error_prompt_required', 'Prompt is required')); return; }
        setBusy(true);
        try {
            const body = {
                title: title.trim(),
                prompt: prompt.trim(),
                repeatInterval: mode,
                daysOfWeek: (mode === 'daily' || mode === 'weekly' || mode === 'biweekly') ? daysOfWeek : null,
                timeOfDay: mode === 'hourly' ? null : time,
                timezone,
                nextRunAt: computeNextRun(),
            };
            if (!isEdit) body.agentId = agent.id;
            const url = isEdit
                ? `${API_BASE}/api/cowork/${initialSchedule.id}`
                : `${API_BASE}/api/cowork`;
            const res = await authFetch(url, {
                method: isEdit ? 'PUT' : 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            });
            if (!res.ok) throw new Error(await res.text());
            onSaved();
        } catch (err) {
            setError(err.message || 'Save failed');
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal
            open
            onClose={onClose}
            size="md"
            title={isEdit ? (t('agent_schedules.edit', 'Edit schedule')) : (t('agent_schedules.new', 'New schedule'))}
            headerActions={
                <button onClick={onClose} className="text-[var(--text-tertiary)] hover:text-[var(--text-primary)]" aria-label={t('common.close', 'Close')}><X size={18} /></button>
            }
        >
            <div>
                <div className="space-y-4">
                    {/* Repeat cadence picker — drives which body fields show. */}
                    <div>
                        <div className="text-[13px] font-medium text-[var(--text-secondary)] mb-1.5">
                            {t('agent_schedules.repeat', 'Repeat')}
                        </div>
                        <select
                            value={mode}
                            onChange={(e) => setMode(e.target.value)}
                            className="w-full bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-primary)] cursor-pointer"
                        >
                            <option value="hourly">{t('agent_schedules.cadence_hourly', 'Hourly')}</option>
                            <option value="daily">{t('agent_schedules.cadence_daily', 'Daily')}</option>
                            <option value="weekdays">{t('agent_schedules.cadence_weekdays', 'Weekdays (Mon–Fri)')}</option>
                            <option value="weekly">{t('agent_schedules.cadence_weekly', 'Weekly')}</option>
                            <option value="biweekly">{t('agent_schedules.cadence_biweekly', 'Every 2 weeks')}</option>
                            <option value="monthly">{t('agent_schedules.cadence_monthly', 'Monthly')}</option>
                        </select>
                    </div>

                    {/* Hourly mode */}
                    {mode === 'hourly' && (
                        <div>
                            <div className="text-[13px] font-medium text-[var(--text-secondary)] mb-1.5">
                                {t('agent_schedules.run_every', 'Run every')}
                            </div>
                            <select
                                value={hours}
                                onChange={(e) => setHours(parseInt(e.target.value, 10))}
                                className="w-full bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-primary)] cursor-pointer"
                            >
                                {[1, 2, 3, 4, 6, 8, 12, 24].map(n => (
                                    <option key={n} value={n}>{n === 1 ? (t('agent_schedules.hour_one', '1 hour')) : `${n} hours`}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    {/* Day-of-week picker — only for cadences that select specific weekdays.
                        Weekdays mode is implicit (Mon–Fri) and skips the picker. */}
                    {usesDayPicker && mode !== 'weekdays' && (
                        <div>
                            <div className="text-[13px] font-medium text-[var(--text-secondary)] mb-1.5">
                                {mode === 'daily' ? (t('agent_schedules.run_every', 'Run every')) : (t('agent_schedules.day_of_week', 'Day of week'))}
                            </div>
                            <div className="flex gap-1">
                                {AUTOMATION_DOW_TOKENS.map(d => {
                                    const active = daysOfWeek.includes(d);
                                    return (
                                        <button
                                            key={d}
                                            type="button"
                                            onClick={() => toggleDay(d)}
                                            className={`flex-1 py-1.5 rounded-full text-xs font-medium transition border ${active
                                                ? 'bg-[var(--text-primary)] text-[var(--bg-primary)] border-transparent'
                                                : 'bg-[var(--bg-primary)] text-[var(--text-secondary)] border-[var(--border-default)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]'}`}
                                        >
                                            {AUTOMATION_DOW_LABELS[d]}
                                        </button>
                                    );
                                })}
                            </div>
                        </div>
                    )}

                    {/* Day-of-month — only for Monthly mode. Capped at 28 so every month fires. */}
                    {usesDayOfMonth && (
                        <div>
                            <div className="text-[13px] font-medium text-[var(--text-secondary)] mb-1.5">
                                {t('agent_schedules.day_of_month', 'Day of month')}
                            </div>
                            <select
                                value={dayOfMonth}
                                onChange={(e) => setDayOfMonth(parseInt(e.target.value, 10))}
                                className="w-full bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-primary)] cursor-pointer"
                            >
                                {Array.from({ length: 28 }, (_, i) => i + 1).map(n => (
                                    <option key={n} value={n}>{(t('agent_schedules.day_n', 'Day {n}')).replace('{n}', n)}</option>
                                ))}
                            </select>
                        </div>
                    )}

                    {/* Time + timezone — shown for every non-hourly cadence. */}
                    {mode !== 'hourly' && (
                        <div className="grid grid-cols-2 gap-3">
                            <div>
                                <div className="text-[13px] font-medium text-[var(--text-secondary)] mb-1.5">
                                    {t('agent_schedules.time', 'Time')}
                                </div>
                                <input
                                    type="time"
                                    value={time}
                                    onChange={(e) => setTime(e.target.value)}
                                    className="w-full bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-primary)]"
                                />
                            </div>
                            <div>
                                <div className="text-[13px] font-medium text-[var(--text-secondary)] mb-1.5">
                                    {t('agent_schedules.timezone', 'Timezone')}
                                </div>
                                <select
                                    value={timezone}
                                    onChange={(e) => setTimezone(e.target.value)}
                                    className="w-full bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--text-primary)] cursor-pointer"
                                >
                                    {AUTOMATION_TIMEZONES.map(tz => (
                                        <option key={tz} value={tz}>{tz}</option>
                                    ))}
                                </select>
                            </div>
                        </div>
                    )}

                    <div>
                        <div className="text-[13px] font-medium text-[var(--text-secondary)] mb-1.5">
                            {t('agent_schedules.task_name', 'Schedule name')}
                        </div>
                        <input
                            value={title}
                            onChange={(e) => setTitle(e.target.value)}
                            placeholder={t('agent_schedules.title_placeholder', 'e.g. Daily standup brief')}
                            className="w-full bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                        />
                    </div>
                    <div>
                        <div className="text-[13px] font-medium text-[var(--text-secondary)] mb-1.5">
                            {t('agent_schedules.additional_instructions_optional', 'Additional instructions (optional)')}
                        </div>
                        <textarea
                            value={prompt}
                            onChange={(e) => setPrompt(e.target.value)}
                            rows={4}
                            placeholder={(t('agent_schedules.placeholder_what_should_agent_do', 'What should {agent} do?')).replace('{agent}', agent?.name || 'this agent')}
                            className="w-full bg-[var(--bg-secondary)] border border-[var(--border-default)] rounded-lg px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] resize-y"
                        />
                    </div>

                    {error && <div className="text-xs text-red-500">{error}</div>}
                </div>
                <div className="pt-4 mt-4 border-t border-[var(--border-default)] flex justify-end gap-2">
                    <button
                        type="button"
                        onClick={onClose}
                        className="px-4 py-2 rounded-full text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] transition"
                    >
                        {t('agent_schedules.cancel', 'Cancel')}
                    </button>
                    <button
                        type="button"
                        onClick={submit}
                        disabled={busy}
                        className="px-5 py-2 rounded-full bg-[var(--text-primary)] text-[var(--bg-primary)] text-sm font-medium hover:opacity-90 transition disabled:opacity-50"
                    >
                        {busy ? '…' : (isEdit ? (t('agent_schedules.save_changes', 'Save changes')) : (t('agent_schedules.add', 'Add schedule')))}
                    </button>
                </div>
            </div>
        </Modal>
    );
}
