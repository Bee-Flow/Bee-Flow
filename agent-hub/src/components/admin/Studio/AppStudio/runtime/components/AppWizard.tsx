import { Check } from 'lucide-react';
import React, { useEffect, useRef } from 'react';
import useTranslation from '@/hooks/useTranslation';
import { useFormContext } from '../formContext';
import { initialTabIndex } from '../initialUi';
import { useRuntime } from '../RuntimeContext';
import { gridClasses, gridColumnStyle, spaceSteps } from '../styleResolver';
import type { NodeStyle } from '../../inspector/appDefinition';
import type { NodeProps } from './appNode.types';
import { useActiveTab } from './tabsUiState';
import { stepFieldNames, stepHolding, type StepDef } from './wizardSteps';

/**
 * App Studio runtime - 'wizard' (schema 3). Spec: server/appStudio/componentSpecs/types/wizard.js.
 *
 * Child i is the body of step i, shown one at a time; the others are not mounted, so a form
 * around the wizard registers (and on submit checks) the fields on screen. Next first asks
 * that form to check the fields of the current step (formContext validateFields) and stays
 * put when one fails, with the form's own error under it. After a move the focus goes to the
 * step's panel, which is labelled by the step's title; the strip above says which step is
 * current (aria-current="step"). The active step is published as ui.tabs.<id>.active, the
 * same branch a tabs group uses. On the canvas the step holding the selected node is shown,
 * and the strip switches steps.
 */

interface WizardStep {
    title?: string;
    description?: string;
}

interface WizardProps {
    steps?: WizardStep[];
    backLabel?: string | null;
    nextLabel?: string | null;
    validateSteps?: boolean;
}

/** The step on screen: the one holding the canvas selection, else the active one, kept in range. */
function shownStep(defs: readonly StepDef[], count: number, active: number, edit: boolean, selectedNodeId: string | null | undefined): number {
    const selected = edit ? stepHolding(defs, selectedNodeId) : -1;
    return Math.min(Math.max(selected === -1 ? active : selected, 0), Math.max(count - 1, 0));
}

function markerClass(state: 'done' | 'current' | 'todo'): string {
    if (state === 'current') return '[background:var(--app-primary)] [color:var(--app-primary-contrast)]';
    if (state === 'done') return '[background:var(--app-primary-soft,var(--bg-tertiary))] [color:var(--app-primary)]';
    return '[background:var(--bg-tertiary)] [color:var(--text-muted)]';
}

export default function AppWizard({ node, children }: NodeProps<WizardProps>) {
    const { t } = useTranslation();
    const { mode, selectedNodeId, initialUi } = useRuntime();
    const form = useFormContext();
    const defs = (Array.isArray(node.children) ? node.children : []) as StepDef[];
    const panels = React.Children.toArray(children);
    const steps = Array.isArray(node.props?.steps) ? node.props.steps : [];
    const [active, setActive] = useActiveTab(node.id, defs, mode === 'run', initialTabIndex(initialUi, node.id, defs));
    // A step is a title in `steps`, a body among the children, or both (the validator warns when they differ).
    const count = Math.max(steps.length, defs.length);
    const current = shownStep(defs, count, active, mode === 'edit', selectedNodeId);
    const panelRef = useRef<HTMLDivElement>(null);
    const moved = useRef(false);
    useEffect(() => {
        if (moved.current) panelRef.current?.focus();
        moved.current = false;
    }, [current]);

    const go = (to: number) => {
        moved.current = true;
        setActive(to);
    };
    const next = () => {
        const check = mode === 'run' && node.props?.validateSteps !== false && form?.validateFields;
        if (check && !check(stepFieldNames(defs[current]))) return;
        go(current + 1);
    };
    const titleOf = (i: number) => steps[i]?.title || t('studio_apps_lk20.wizard.step', 'Step {n}', { n: i + 1 });
    const gap = spaceSteps(Number.isFinite(node.style?.gap) ? (node.style as NodeStyle).gap : 3);
    const rootStyle = { gap };
    const panelStyle = { ...gridColumnStyle(node.style), gap };
    const description = steps[current]?.description;

    return (
        <div className="flex flex-col bfa-wizard__root" style={rootStyle} data-app-wizard={current}>
            <ol className="flex flex-wrap items-center gap-x-4 gap-y-2 bfa-wizard__steps" aria-label={t('studio_apps_lk20.wizard.steps', 'Steps')}>
                {Array.from({ length: count }, (_, i) => {
                    const state = i < current ? 'done' : i === current ? 'current' : 'todo';
                    const label = (
                        <>
                            <span className={`inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-semibold ${markerClass(state)} bfa-wizard__marker`} aria-hidden="true">
                                {state === 'done' ? <Check className="h-3.5 w-3.5" /> : i + 1}
                            </span>
                            <span className={`text-sm ${state === 'current' ? 'font-semibold text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'} bfa-wizard__title`}>{titleOf(i)}</span>
                        </>
                    );
                    return (
                        <li key={defs[i]?.id ?? i} className="inline-flex items-center gap-2 bfa-wizard__step" aria-current={state === 'current' ? 'step' : undefined} data-app-wizard-step={state}>
                            {mode === 'edit'
                                ? <button type="button" className="inline-flex items-center gap-2" onClick={() => setActive(i)}>{label}</button>
                                : label}
                        </li>
                    );
                })}
            </ol>
            {description ? <p className="text-sm text-[var(--text-secondary)]">{description}</p> : null}
            <div ref={panelRef} tabIndex={-1} role="group" aria-label={titleOf(current)} className={`app-grid${gridClasses(node)} outline-none bfa-wizard__panel`} style={panelStyle}>
                {panels[current] ?? null}
            </div>
            <div className="flex items-center justify-between gap-2 bfa-wizard__actions">
                <button
                    type="button"
                    onClick={() => go(current - 1)}
                    disabled={current === 0}
                    className="px-3 py-1.5 text-sm font-medium border disabled:opacity-50 [border-color:var(--border-default)] [border-radius:var(--app-radius)] [color:var(--text-secondary)]! bfa-wizard__back"
                >
                    {node.props?.backLabel || t('studio_apps_lk20.wizard.back', 'Back')}
                </button>
                {current < count - 1 ? (
                    <button
                        type="button"
                        onClick={next}
                        className="px-3.5 py-1.5 text-sm font-medium [background:var(--app-primary)] [color:var(--app-primary-contrast)]! [border-radius:var(--app-radius)] bfa-wizard__next"
                    >
                        {node.props?.nextLabel || t('studio_apps_lk20.wizard.next', 'Next')}
                    </button>
                ) : null}
            </div>
        </div>
    );
}
