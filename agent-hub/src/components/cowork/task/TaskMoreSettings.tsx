/**
 * Three rows of More in an opened task (./CoworkTaskMore.tsx):
 *
 *   - Check each result first: for fixed steps, the level of independence that asks before anything is changed or
 *     sent (asks_everything); off, it asks only before sending again (asks_before_sending);
 *   - Memory: what the task keeps from one run to the next, cleared after an in-page confirm, with Undo;
 *   - Budget: what it may spend on AI a month, and what it spent this month.
 */
import { useState } from 'react';
import { BTN_DANGER, BTN_LINK, BTN_PRIMARY, BTN_QUIET, FIELD, Failure, FoldRow, LABEL, META, ROW_ACTIONS } from './taskUi';
import { useCoworkIndependence } from '@/api/coworkIndependence';
import { useCoworkItemActions, useCoworkMemory, useCoworkMonthCost } from '@/api/coworkTask';
import { formatCostCents } from '@/utils/formatCost';
import type { TranslateFn } from '@/hooks/useTranslation';

interface RowProps { coworkId: string; open: boolean; onToggle: (id: string | null) => void; t: TranslateFn }

/** "Check each result first", for a task with approved steps. */
export function CheckFirstRow({ coworkId, open, onToggle, hasApprovedSteps, t }: RowProps & { hasApprovedSteps: boolean }) {
    const { query, choose } = useCoworkIndependence(coworkId, hasApprovedSteps);
    const level = query.data ? query.data.chosen ?? query.data.level : null;
    const on = level === 'asks_everything';
    const id = `cowork-task-check-first-${coworkId}`;
    return (
        <FoldRow id="review" label={t('cowork_task.more.check_first', 'Check each result first')} value={on ? t('cowork_task.on', 'On') : t('cowork_task.off', 'Off')} open={open} onToggle={onToggle}>
            {hasApprovedSteps ? (
                <label htmlFor={id} className="flex items-start gap-3 min-h-[44px] cursor-pointer">
                    <input id={id} type="checkbox" role="switch" className="mt-1 w-5 h-5 accent-[var(--accent-primary)]" checked={on} disabled={!query.data || choose.isPending}
                        onChange={(e) => choose.mutate(e.target.checked ? 'asks_everything' : 'asks_before_sending')} />
                    <span className="flex flex-col gap-0.5">
                        <span className={LABEL}>{t('cowork_task.more.check_first', 'Check each result first')}</span>
                        <span className={META}>{t('cowork_task.check_first.sub', 'Nothing it changes or sends goes ahead until you approve it, under Needs you.')}</span>
                    </span>
                </label>
            ) : <p className={META}>{t('cowork_task.check_first.steps_only', 'This is for a task with fixed steps. The AI already tells you after every run what it did.')}</p>}
            <Failure error={choose.error} t={t} />
        </FoldRow>
    );
}

function MemoryBody({ coworkId, t }: { coworkId: string; t: TranslateFn }) {
    const { query, clear, restore } = useCoworkMemory(coworkId, true);
    const [confirming, setConfirming] = useState(false);
    const [cleared, setCleared] = useState<string[]>([]);
    const list = query.data ?? [];
    const undo = () => restore.mutate(cleared, { onSuccess: () => setCleared([]) });
    return (
        <>
            {cleared.length > 0 && (
                <p role="status" className={`${ROW_ACTIONS} text-[14px]`}>
                    {t('cowork_task.memory.cleared', 'Memory cleared.')}
                    <button type="button" className={BTN_LINK} disabled={restore.isPending} onClick={undo}>{t('cowork_task.undo', 'Undo')}</button>
                </p>
            )}
            {list.length === 0 && cleared.length === 0 && query.isSuccess && <p className={META}>{t('cowork_task.memory.empty', 'It remembers nothing yet. After a run you see here what it keeps for next time.')}</p>}
            {list.length > 0 && (
                <>
                    <p className={META}>{t('cowork_task.memory.intro', 'What this task remembers from one run to the next:')}</p>
                    <ul className="list-none m-0 p-0 flex flex-col">{list.map((m) => <li key={m.id} className="py-2 border-t first:border-t-0 border-[var(--border-subtle)] text-[14px] break-words">{m.text}</li>)}</ul>
                    {confirming ? (
                        <div className="flex flex-col gap-2" role="group" aria-label={t('cowork_task.memory.clear', 'Clear memory')}>
                            <p className="text-[15px]">{t('cowork_task.memory.confirm', 'Clear what it remembers? The next run starts fresh.')}</p>
                            <div className={ROW_ACTIONS}>
                                <button type="button" className={BTN_DANGER} disabled={clear.isPending} onClick={() => clear.mutate(undefined, { onSuccess: (r) => { setCleared(r.cleared); setConfirming(false); } })}>{t('cowork_task.memory.clear', 'Clear memory')}</button>
                                <button type="button" className={BTN_QUIET} onClick={() => setConfirming(false)}>{t('cowork_task.keep_it', 'Keep it')}</button>
                            </div>
                        </div>
                    ) : <div><button type="button" className={BTN_QUIET} onClick={() => setConfirming(true)}>{t('cowork_task.memory.clear', 'Clear memory')}</button></div>}
                </>
            )}
            <Failure error={query.error || clear.error || restore.error} t={t} />
        </>
    );
}

export function MemoryRow({ coworkId, open, onToggle, t }: RowProps) {
    return (
        <FoldRow id="memory" label={t('cowork_task.more.memory', 'Memory')} open={open} onToggle={onToggle}>
            <MemoryBody coworkId={coworkId} t={t} />
        </FoldRow>
    );
}

const money = (amount: number, locale: string) => formatCostCents({ EUR: amount }, locale);

/** The share of the budget spent, as a bar. */
function BudgetMeter({ used, limit, locale, t }: { used: number; limit: number; locale: string; t: TranslateFn }) {
    const tone = used >= limit ? '[&::-webkit-progress-value]:bg-[var(--error)] [&::-moz-progress-bar]:bg-[var(--error)]'
        : used / limit >= 0.8 ? '[&::-webkit-progress-value]:bg-[var(--warning)] [&::-moz-progress-bar]:bg-[var(--warning)]'
            : '[&::-webkit-progress-value]:bg-[var(--accent-primary)] [&::-moz-progress-bar]:bg-[var(--accent-primary)]';
    const line = t('cowork_task.budget.used', '{used} of {limit} used this month', { used: money(used, locale), limit: money(limit, locale) });
    return (
        <div className="flex flex-col gap-1.5">
            <progress value={Math.min(used, limit)} max={limit} aria-label={line} className={`w-full h-2 rounded-full overflow-hidden appearance-none bg-[var(--surface-2)] [&::-webkit-progress-bar]:bg-[var(--surface-2)] ${tone}`} />
            <span className={META}>{line}</span>
        </div>
    );
}

export function BudgetRow({ coworkId, limit, open, onToggle, locale, t }: RowProps & { limit: number | null; locale: string }) {
    const used = useCoworkMonthCost(coworkId, true).data ?? null;
    const { change } = useCoworkItemActions(coworkId);
    const [text, setText] = useState(limit === null ? '' : String(limit));
    const typed = text.trim() === '' ? null : Number(text.replace(',', '.'));
    const valid = typed === null || (Number.isFinite(typed) && typed > 0 && typed <= 100_000);
    const id = `cowork-task-budget-${coworkId}`;
    const value = limit === null ? t('cowork_task.budget.none', 'No limit') : used === null ? money(limit, locale) : t('cowork_task.budget.value', '{used} of {limit}', { used: money(used, locale), limit: money(limit, locale) });
    return (
        <FoldRow id="budget" label={t('cowork_task.more.budget', 'Budget')} value={value} open={open} onToggle={onToggle}>
            <div className="flex flex-col gap-1.5">
                <label htmlFor={id} className={LABEL}>{t('cowork_task.budget.label', 'Monthly limit in euros')}</label>
                <input id={id} type="number" min="1" step="0.5" inputMode="decimal" className={`${FIELD} max-w-[200px]`} value={text} onChange={(e) => setText(e.target.value)} />
                <span className={META}>{t('cowork_task.budget.hint', 'Leave empty for no limit. When the limit is reached, the task pauses and tells you.')}</span>
            </div>
            {limit !== null && used !== null && <BudgetMeter used={used} limit={limit} locale={locale} t={t} />}
            <div>
                <button type="button" className={BTN_PRIMARY} disabled={!valid || typed === limit || change.isPending} onClick={() => change.mutate({ monthlyBudget: typed })}>
                    {t('cowork_task.budget.save', 'Save limit')}
                </button>
            </div>
            <Failure error={change.error} t={t} />
        </FoldRow>
    );
}
