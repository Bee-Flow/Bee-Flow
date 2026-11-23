/**
 * "How independent may it be?": the three levels of an approved plan, inside the plan card (./CoworkPlanPanel.tsx).
 * Each says what it means for this plan (the steps it would ask about first); a level that is not open says why.
 * Choosing saves at once; the next run uses it, a run under way keeps the level it started with.
 */
import { ShieldCheck } from 'lucide-react';
import { useCoworkIndependence, type Independence, type IndependenceState, type LevelOption } from '../../api/coworkIndependence';
import { errorMessage } from '../../utils/caughtError';
import type { TranslateFn } from '../../hooks/useTranslation';

const LABEL = 'text-[10.5px] font-semibold uppercase tracking-wide text-[var(--text-tertiary)]';

function titleOf(level: Independence, t: TranslateFn): string {
    if (level === 'asks_everything') return t('cowork_plan.level.asks_everything', 'Ask me about everything');
    if (level === 'asks_before_sending') return t('cowork_plan.level.asks_before_sending', 'Ask before anything leaves Bee Flow');
    return t('cowork_plan.level.on_its_own', 'On its own');
}

/** What the level means for this plan, or why it is not open. */
function lineOf(option: LevelOption, state: IndependenceState, t: TranslateFn): string {
    if (!option.open && option.level === 'on_its_own') {
        return t('cowork_plan.level.opens_after', 'Opens after {needed} runs you let through without stopping one ({count} so far).', { needed: state.needed, count: state.letThrough });
    }
    if (!option.open) return t('cowork_plan.level.needs_approvals', 'Asking needs approvals, which your organisation\'s plan does not include.');
    if (option.level === 'on_its_own') return t('cowork_plan.level.on_its_own_line', 'It runs as approved and asks nothing more.');
    if (option.asksBefore.length === 0) return t('cowork_plan.level.nothing_to_ask', 'Nothing in this plan would wait: it changes and sends nothing.');
    return t('cowork_plan.level.asks_line', 'Waits for your decision before: {steps}', { steps: option.asksBefore.join(', ') });
}

function IndependenceChoice({ state, busy, error, t, onChoose }: {
    state: IndependenceState; busy: boolean; error: string | null; t: TranslateFn; onChoose: (level: Independence) => void;
}) {
    const current = state.chosen ?? state.level;
    return (
        <fieldset className="flex flex-col gap-2 pt-2 border-t border-[var(--border-subtle)]" data-testid="cowork-independence" disabled={busy}>
            <legend className={`${LABEL} inline-flex items-center gap-1.5 mb-1`}>
                <ShieldCheck aria-hidden="true" className="w-3.5 h-3.5" />
                {t('cowork_plan.level.heading', 'How independent may it be?')}
            </legend>
            {state.level === null && (
                <p role="alert" className="text-[12px] text-[var(--warning-ink)]">
                    {t('cowork_plan.level.cannot_run', 'It cannot run as chosen: asking needs approvals. Choose "On its own", or ask your administrator.')}
                </p>
            )}
            {state.options.map((option) => (
                <label key={option.level} htmlFor={`cowork-independence-${option.level}`} className={`grid grid-cols-[auto_1fr] gap-x-2.5 gap-y-0.5 items-start rounded-lg border px-3 py-2 ${option.open ? 'cursor-pointer' : 'opacity-60'} ${current === option.level ? 'border-[var(--accent)]' : 'border-[var(--border-subtle)]'}`}>
                    <input
                        id={`cowork-independence-${option.level}`}
                        type="radio"
                        name="cowork-independence"
                        className="mt-0.5 row-span-2"
                        checked={current === option.level}
                        disabled={!option.open}
                        onChange={() => onChoose(option.level)}
                    />
                    <span className="text-[12.5px] font-medium text-[var(--text-primary)]">{titleOf(option.level, t)}</span>
                    <span className="text-[12px] text-[var(--text-secondary)]">{lineOf(option, state, t)}</span>
                </label>
            ))}
            {error && <p role="alert" className="text-[12px] text-[var(--error-ink)]">{error}</p>}
        </fieldset>
    );
}

/** The choice of one item, read and saved here. Shown once the plan was approved. */
export default function CoworkIndependence({ coworkId, t }: { coworkId: string; t: TranslateFn }) {
    const { query, choose } = useCoworkIndependence(coworkId, true);
    if (!query.data) return null;
    const error = choose.error ? errorMessage(choose.error) || t('cowork_plan.failed', 'That did not work. Try again.') : null;
    return <IndependenceChoice state={query.data} busy={choose.isPending} error={error} t={t} onChoose={(level) => choose.mutate(level)} />;
}
