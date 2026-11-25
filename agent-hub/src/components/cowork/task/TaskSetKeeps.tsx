/**
 * Two parts of "Uses" in a task's Settings (./TaskSetUses.tsx), each saved by itself:
 *
 *   - What it remembers: what the task keeps from one run to the next, cleared after an in-page confirm, with Undo;
 *   - Spending limit: what it may spend on AI a month, and what it spent this month.
 */
import { useState } from 'react';
import { PART, PART_H } from './taskRows';
import { BTN_DANGER, BTN_LINK, BTN_QUIET, FIELD, Failure, LABEL, META, ROW_ACTIONS } from './taskUi';
import { useCoworkItemActions, useCoworkMemory, useCoworkMonthCost } from '@/api/coworkTask';
import { formatCostCents } from '@/utils/formatCost';
import type { TranslateFn } from '@/hooks/useTranslation';

function ClearMemory({ busy, onClear, t }: { busy: boolean; onClear: (done: () => void) => void; t: TranslateFn }) {
    const [confirming, setConfirming] = useState(false);
    if (!confirming) return <div><button type="button" className={BTN_QUIET} onClick={() => setConfirming(true)}>{t('cowork_task.remembers.clear', 'Clear what it remembers')}</button></div>;
    return (
        <div className="flex flex-col gap-2" role="group" aria-label={t('cowork_task.remembers.clear', 'Clear what it remembers')}>
            <p>{t('cowork_task.memory.confirm', 'Clear what it remembers? The next run starts fresh.')}</p>
            <div className={ROW_ACTIONS}>
                <button type="button" className={BTN_DANGER} disabled={busy} onClick={() => onClear(() => setConfirming(false))}>{t('cowork_task.remembers.clear_go', 'Clear it')}</button>
                <button type="button" className={BTN_QUIET} onClick={() => setConfirming(false)}>{t('cowork_task.keep_it', 'Keep it')}</button>
            </div>
        </div>
    );
}

export function MemoryPart({ coworkId, t }: { coworkId: string; t: TranslateFn }) {
    const { query, clear, restore } = useCoworkMemory(coworkId, true);
    const [cleared, setCleared] = useState<string[]>([]);
    const list = query.data ?? [];
    const undo = () => restore.mutate(cleared, { onSuccess: () => setCleared([]) });
    const onClear = (done: () => void) => clear.mutate(undefined, { onSuccess: (r) => { setCleared(r.cleared); done(); } });
    return (
        <div className={PART} data-testid="cowork-task-remembers">
            <span className={PART_H}>{t('cowork_task.remembers.heading', 'What it remembers')}</span>
            {cleared.length > 0 && (
                <p role="status" className={ROW_ACTIONS}>
                    {t('cowork_task.remembers.cleared', 'Cleared. The next run starts fresh.')}
                    <button type="button" className={BTN_LINK} disabled={restore.isPending} onClick={undo}>{t('cowork_task.undo', 'Undo')}</button>
                </p>
            )}
            {list.length === 0 && cleared.length === 0 && query.isSuccess && <p className={META}>{t('cowork_task.memory.empty', 'It remembers nothing yet. After a run you see here what it keeps for next time.')}</p>}
            {list.length > 0 && (
                <>
                    <p className={META}>{t('cowork_task.memory.intro', 'What this task remembers from one run to the next:')}</p>
                    <ul className="list-none m-0 p-0 flex flex-col">{list.map((m) => <li key={m.id} className="py-2 border-t first:border-t-0 border-[var(--border-subtle)] break-words">{m.text}</li>)}</ul>
                    <ClearMemory busy={clear.isPending} onClear={onClear} t={t} />
                </>
            )}
            <Failure error={query.error || clear.error || restore.error} t={t} />
        </div>
    );
}

const money = (amount: number, locale: string) => formatCostCents({ EUR: amount }, locale);

/** The spending limit in plain words: "No limit", "€20.00 a month", or what was used of it this month. */
export function limitWords(limit: number | null, used: number | null, locale: string, t: TranslateFn): string {
    if (limit === null) return t('cowork_task.budget.none', 'No limit');
    if (used === null) return t('cowork_task.limit.a_month', '{limit} a month', { limit: money(limit, locale) });
    return t('cowork_task.budget.used', '{used} of {limit} used this month', { used: money(used, locale), limit: money(limit, locale) });
}

const BAR = 'w-full h-2 rounded-[var(--radius-md)] overflow-hidden appearance-none bg-[var(--bg-tertiary)] [&::-webkit-progress-bar]:bg-[var(--bg-tertiary)]';

/** The share of the limit spent, as a bar. */
function LimitMeter({ used, limit, locale, t }: { used: number; limit: number; locale: string; t: TranslateFn }) {
    const tone = used >= limit ? '[&::-webkit-progress-value]:bg-[var(--error)] [&::-moz-progress-bar]:bg-[var(--error)]'
        : used / limit >= 0.8 ? '[&::-webkit-progress-value]:bg-[var(--warning)] [&::-moz-progress-bar]:bg-[var(--warning)]'
            : '[&::-webkit-progress-value]:bg-[var(--accent-primary)] [&::-moz-progress-bar]:bg-[var(--accent-primary)]';
    const line = limitWords(limit, used, locale, t);
    return (
        <div className="flex flex-col gap-1.5">
            <progress value={Math.min(used, limit)} max={limit} aria-label={line} className={`${BAR} ${tone}`} />
            <span className={META}>{line}</span>
        </div>
    );
}

/** A limit as typed: a number above nothing, a comma or a point for its decimals; null for an empty field. */
function typedLimit(text: string): { value: number | null; valid: boolean } {
    if (text.trim() === '') return { value: null, valid: true };
    const value = Number(text.trim().replaceAll(',', '.'));
    return { value, valid: Number.isFinite(value) && value > 0 && value <= 100_000 };
}

export function SpendingPart({ coworkId, limit, locale, t }: { coworkId: string; limit: number | null; locale: string; t: TranslateFn }) {
    const used = useCoworkMonthCost(coworkId, true).data ?? null;
    const { change } = useCoworkItemActions(coworkId);
    const [text, setText] = useState(limit === null ? '' : String(limit));
    const typed = typedLimit(text);
    const id = `cowork-task-limit-${coworkId}`;
    return (
        <div className={PART} data-testid="cowork-task-limit">
            <span className={PART_H}>{t('cowork_task.limit.heading', 'Spending limit')}</span>
            <div className="flex flex-col gap-1">
                <label htmlFor={id} className={LABEL}>{t('cowork_task.budget.label', 'Monthly limit in euros')}</label>
                <input id={id} type="number" min="1" step="0.5" inputMode="decimal" className={`${FIELD} max-w-[200px]`} value={text} onChange={(e) => setText(e.target.value)} />
                <span className={META}>{t('cowork_task.budget.hint', 'Leave empty for no limit. When the limit is reached, the task pauses and tells you.')}</span>
            </div>
            {limit !== null && used !== null && <LimitMeter used={used} limit={limit} locale={locale} t={t} />}
            <div>
                <button type="button" className={BTN_QUIET} disabled={!typed.valid || typed.value === limit || change.isPending} onClick={() => change.mutate({ monthlyBudget: typed.value })}>
                    {t('cowork_task.budget.save', 'Save limit')}
                </button>
            </div>
            <Failure error={change.error} t={t} />
        </div>
    );
}
