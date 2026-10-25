import { Plus, Play, Pause, Sliders, Trash2, X } from 'lucide-react';
import { useRef, useEffect } from 'react';
import type { TranslateParams } from '../../../../hooks/useTranslation';
import type { SchedulesPickerProps } from './SchedulePickers.types';

export function formatScheduleNextRun(iso: string | number | Date, t: (key: string | undefined, fallbackOrParams?: string | TranslateParams, params?: TranslateParams) => string) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '—';
    const now = new Date();
    const diffMs = d.getTime() - now.getTime();
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
    const _t = typeof t === 'function' ? t : ((_key: string | undefined, fallback?: string | TranslateParams) => fallback);
    if (diffMs < 0) return `${_t('agent_schedules.overdue', 'Overdue')} (${d.toLocaleString()})`;
    if (sameDay) return `${_t('agent_schedules.today_at', 'Today at')} ${time}`;
    if (isTomorrow) return `${_t('agent_schedules.tomorrow_at', 'Tomorrow at')} ${time}`;
    return d.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function SchedulesPicker({ t, agent, schedules, onClose, onCreate, onEdit, onToggle, onRunNow, onDelete }: SchedulesPickerProps) {
    const popoverRef = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const onDoc = (e: MouseEvent) => {
            if (popoverRef.current?.contains(e.target as Node)) return;
            // Ignore clicks on this picker's own trigger pill — let the trigger's
            // onClick handle the toggle. Without this, the close handler races
            // with the trigger and the picker stays open on close-click.
            if ((e.target as Element).closest?.('[data-popover-trigger="schedules"]')) return;
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
                                            ? `${t('agent_schedules.scheduled_for', 'Scheduled for')}: ${formatScheduleNextRun(r.nextRunAt as string | number | Date, t)}`
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
