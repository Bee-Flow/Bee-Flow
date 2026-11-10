import { compile } from '@shared/expr/engine.mjs';
import { Plus, X } from 'lucide-react';
import IconButton from '@/components/shared/IconButton';
import useTranslation from '@/hooks/useTranslation';
import { INPUT_CLS } from '../inspector/panels/kit';
import { useActionChoices } from '../inspector/ThenAlsoRun';
import { TRIGGER_LIMITS, definitionWatchers, nextTriggerId, setWatchers, type Watcher } from '../state/triggerOps';
import type { AppDefinition } from '../inspector/appDefinition';

/**
 * The app's watchers in the Logic tab (schema 3, definition.watchers): "when this value
 * changes, run that action". The formula reads the same scope as a visibleWhen (vars, forms,
 * screen, records …). A watcher runs in the app itself, never in the editor, and one that
 * runs more than ten times in a minute is paused for the rest of the visit.
 */

export interface WatchersPanelProps {
    definition: AppDefinition;
    onCommit: (definition: AppDefinition) => void;
    disabled?: boolean;
}

const ADD_BTN = 'inline-flex shrink-0 items-center gap-1.5 rounded-md border border-dashed px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-[var(--bg-tertiary)] disabled:cursor-not-allowed disabled:opacity-50 border-[var(--border-default)] text-[var(--text-secondary)]';

/** The parse error of a watcher's formula, or null when it compiles. Never evaluated here. */
export function formulaProblem(expr: string): string | null {
    if (!expr.trim()) return null;
    try {
        compile(expr);
        return null;
    } catch (e) {
        return e instanceof Error ? e.message : String(e);
    }
}

/** A formula a new watcher starts with: never empty (the server drops a watcher without one). */
function starterExpr(definition: AppDefinition): string {
    const name = definition?.variables?.find((v) => v && typeof v.name === 'string' && v.name)?.name;
    return name ? `vars.${name}` : 'screen.id';
}

function clampDebounce(raw: string): number {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(n, TRIGGER_LIMITS.MAX_WATCHER_DEBOUNCE_MS);
}

export default function WatchersPanel({ definition, onCommit, disabled = false }: WatchersPanelProps) {
    const { t } = useTranslation();
    const choices = useActionChoices(definition);
    const watchers = definitionWatchers(definition);
    const commit = (list: Watcher[]) => {
        const next = setWatchers(definition, list);
        if (next !== definition) onCommit(next);
    };
    const patch = (i: number, change: Partial<Watcher>) => commit(watchers.map((w, j) => (j === i ? { ...w, ...change } : w)));
    const first = choices[0]?.id;

    return (
        <section className="mt-6" data-testid="logic-watchers">
            <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <h3 className="text-sm font-semibold text-[var(--text-primary)]">{t('studio_apps_triggers.watchers.title', 'When a value changes')}</h3>
                    <p className="text-xs text-[var(--text-tertiary)]">
                        {t('studio_apps_triggers.watchers.desc', 'A watcher runs an action each time the value of its formula changes, in the app itself. One that runs more than ten times a minute is paused.')}
                    </p>
                </div>
                {watchers.length < TRIGGER_LIMITS.MAX_WATCHERS && first ? (
                    <button
                        type="button"
                        className={ADD_BTN}
                        disabled={disabled}
                        onClick={() => commit([...watchers, { id: nextTriggerId('watch', watchers), expr: starterExpr(definition), actionId: first }])}
                    >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        {t('studio_apps_triggers.watchers.add', 'Add a watcher')}
                    </button>
                ) : null}
            </div>
            {watchers.map((w, i) => {
                const problem = formulaProblem(w.expr || '');
                return (
                    <div key={w.id || i} className="mb-2 flex flex-col gap-1" data-app-watcher={w.id}>
                        <div className="flex flex-wrap items-center gap-2">
                            <input
                                type="text"
                                className={`${INPUT_CLS} min-w-[12rem] flex-1 font-mono`}
                                value={w.expr}
                                placeholder="vars.status"
                                spellCheck={false}
                                onChange={(e) => patch(i, { expr: e.target.value })}
                                disabled={disabled}
                                aria-label={t('studio_apps_triggers.watchers.expr', 'Formula to watch')}
                                aria-invalid={problem ? true : undefined}
                            />
                            <select
                                className={`${INPUT_CLS} min-w-[10rem] flex-1`}
                                value={w.actionId}
                                onChange={(e) => patch(i, { actionId: e.target.value })}
                                disabled={disabled}
                                aria-label={t('studio_apps_triggers.watchers.action', 'Action to run')}
                            >
                                {choices.some((c) => c.id === w.actionId) ? null : <option value={w.actionId}>{w.actionId}</option>}
                                {choices.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
                            </select>
                            <input
                                type="number"
                                className={`${INPUT_CLS} w-24`}
                                min={0}
                                max={TRIGGER_LIMITS.MAX_WATCHER_DEBOUNCE_MS}
                                step={100}
                                value={w.debounceMs || 0}
                                onChange={(e) => patch(i, { debounceMs: clampDebounce(e.target.value) })}
                                disabled={disabled}
                                aria-label={t('studio_apps_triggers.watchers.debounce', 'Wait this many milliseconds of quiet first')}
                            />
                            <IconButton ariaLabel={t('studio_apps_triggers.watchers.remove', 'Remove this watcher')} onClick={() => commit(watchers.filter((_, j) => j !== i))} disabled={disabled}>
                                <X />
                            </IconButton>
                        </div>
                        {problem ? <span className="text-xs text-[var(--error)]" role="alert">{problem}</span> : null}
                    </div>
                );
            })}
            {!first ? <p className="text-xs text-[var(--text-muted)]">{t('studio_apps_triggers.screen.no_actions', 'Add an action to the app first: a trigger runs one of its actions.')}</p> : null}
        </section>
    );
}
