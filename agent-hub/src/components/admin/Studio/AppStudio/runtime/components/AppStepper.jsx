import { Check } from 'lucide-react';
import useTranslation from '../../../../../../hooks/useTranslation';
import AppIcon from '../../../../../icons/AppIcon';
import { hoverable } from '../hoverable';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import { ROLE_COLORS } from '../styleResolver';
import { Skeleton, useStickyBinding } from '../uiBits';

/**
 * App Studio runtime — 'stepper'. Spec: server/appStudio/componentSpecs.js.
 *
 * The stages of a process with the current one marked, so a record's position
 * is visible instead of inferred from a dropdown's selected value.
 *
 * A value that matches no step leaves every step "upcoming" rather than
 * guessing — that state is real (a record can hold a status somebody removed
 * from the vocabulary), and pretending it is step 1 would be a lie about where
 * the work stands.
 *
 * Clickable only in run mode with onRowClick wired: the payload is the STEP
 * ({value, label, index}), not a row, so an action can read form.value the same
 * way it reads a select's.
 */

function toneColor(tone) {
    return ROLE_COLORS[tone] || ROLE_COLORS.primary;
}

export default function AppStepper({ node }) {
    const { t } = useTranslation();
    const { mode, runAction, actionState, dataState, scope } = useRuntime();
    const {
        steps = [],
        orientation = 'horizontal',
        tone = 'primary',
        showLabels = true,
    } = node.props || {};
    // Sticky for the same reason AppProgress is: a stepper bound to the
    // selected record re-keys on every selection, and a 32px grey block where
    // the stages were is a bigger flash than the bar below it.
    const { value, isLoading } = useStickyBinding(
        resolveBinding(node.props?.value, { actionState, dataState, scope }),
    );

    if (isLoading) return <Skeleton className="h-8 w-full" />;
    if (!Array.isArray(steps) || steps.length === 0) return null;

    const current = value === null || value === undefined ? '' : String(value);
    const currentIndex = steps.findIndex((s) => String(s?.value) === current);
    const color = toneColor(tone);
    const clickable = mode === 'run' && !!node.onRowClick;
    const vertical = orientation === 'vertical';

    return (
        <div
            className={`app-stepper w-full min-w-0 flex ${vertical ? 'flex-col gap-1' : 'items-start gap-1'}`}
            data-app-stepper="true"
            data-orientation={orientation}
            role="list"
            aria-label={t('studio_apps_runtime.progress.label', 'Progress')}
        >
            {steps.map((step, i) => {
                // Everything before the current step is done; with no match at
                // all nothing is done, which is the honest rendering.
                const isDone = currentIndex >= 0 && i < currentIndex;
                const isCurrent = currentIndex === i;
                const label = step?.label || step?.value || '';
                const state = isCurrent ? 'current' : isDone ? 'done' : 'upcoming';
                // What this step is waiting on. Live, because the sentence worth
                // reading is "2 lines are missing a material", not a caption
                // written once — which is what lets the bar carry a status note
                // that would otherwise need its own permanent strip below it.
                const { value: rawHint } = resolveBinding(step?.hint, { actionState, dataState, scope });
                const hint = typeof rawHint === 'string' && rawHint.trim() ? rawHint.trim() : null;

                const marker = (
                    <span
                        className="app-stepper-marker inline-flex items-center justify-center shrink-0 rounded-full"
                        data-state={state}
                        style={isDone || isCurrent
                            ? { background: color, color: '#fff', borderColor: color }
                            : { borderColor: 'var(--border-default)', color: 'var(--text-muted)' }}
                        aria-hidden="true"
                    >
                        {isDone
                            ? <Check className="w-3 h-3" />
                            : step?.icon
                                ? <AppIcon name={step.icon} className="w-3 h-3" />
                                : <span className="text-[10px] font-semibold">{i + 1}</span>}
                    </span>
                );

                const text = showLabels ? (
                    <span
                        className="app-stepper-label text-xs font-medium truncate"
                        {...hoverable(step.label)}
                        style={{ color: isCurrent ? color : isDone ? 'var(--text-secondary)' : 'var(--text-muted)' }}
                    >
                        {label}
                    </span>
                ) : null;

                const body = vertical ? (
                    <span className="flex items-center gap-2 min-w-0">{marker}{text}</span>
                ) : (
                    <span className="flex flex-col items-center gap-1 min-w-0">{marker}{text}</span>
                );

                const content = clickable ? (
                    <button
                        type="button"
                        onClick={() => runAction(node.onRowClick, {
                            formValues: { value: step?.value ?? null, label, index: i },
                            item: step,
                            index: i,
                            value: step?.value ?? null,
                        })}
                        className="app-stepper-step min-w-0 rounded-md px-1 py-0.5"
                        aria-current={isCurrent ? 'step' : undefined}
                    >
                        {body}
                    </button>
                ) : (
                    <span className="app-stepper-step min-w-0 px-1 py-0.5" aria-current={isCurrent ? 'step' : undefined}>
                        {body}
                    </span>
                );

                return (
                    <div
                        key={step?.value ?? i}
                        role="listitem"
                        data-state={state}
                        data-has-hint={hint ? 'true' : undefined}
                        tabIndex={hint && !clickable ? 0 : undefined}
                        aria-describedby={hint ? `${node.id}-hint-${i}` : undefined}
                        // The LAST step carries no connector, so an equal share
                        // of the row leaves its own width as dead space and the
                        // bar stops short of the right edge. Sizing it to its
                        // content hands that space to the connectors instead,
                        // which is what makes the bar span the full width with
                        // the final marker flush against the end.
                        className={`app-stepper-item${vertical
                            ? ' flex flex-col'
                            : `${i < steps.length - 1 ? ' flex-1' : ' shrink-0'} min-w-0 flex items-center gap-1`}`}
                    >
                        {content}
                        {hint ? (
                            <span className="app-stepper-hint" role="tooltip" id={`${node.id}-hint-${i}`}>
                                {hint}
                            </span>
                        ) : null}
                        {/* The connector between steps: filled up to the current
                            one so the "how far along" reads without counting. */}
                        {i < steps.length - 1 ? (
                            <span
                                className={`app-stepper-line ${vertical ? 'app-stepper-line--v' : 'flex-1'}`}
                                style={{ background: isDone ? color : 'var(--border-default)' }}
                                aria-hidden="true"
                            />
                        ) : null}
                    </div>
                );
            })}
        </div>
    );
}
