import { ChevronUp, ListTodo } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import BuilderPlanChecklist from './BuilderPlanChecklist';

/**
 * The AI's own checklist, ON the canvas — the automation builder's and the app
 * editor's alike (owner, 2026-09-16: it used to ride at the top of the chat
 * thread and scrolled away under the messages it was describing).
 *
 * It is open while the AI builds and folds to a pill the moment it stops,
 * finished or not: a panel left standing over a canvas is in the way of the
 * thing that was just built. The pill opens it again; the chevron closes it.
 */
/**
 * Where it sits. The automation canvas is a graph that lays out from the left, so
 * the panel rides at the top under the step chips; the app editor's canvas is
 * a PAGE that fills from the top-left, and there the panel sat straight over
 * the component being written (owner, 2026-09-16) — so there it hangs at the
 * bottom, out of the way of the build.
 */
const PLACEMENT = Object.freeze({
    'top-left': 'left-3 top-3',
    'bottom-left': 'left-3 bottom-3',
});

export default function CanvasPlanPanel({ todos, running = false, t, idPrefix = 'builder', placement = 'top-left', className = '', style = null }) {
    const [open, setOpen] = useState(running);
    const wasRunning = useRef(running);
    useEffect(() => {
        if (wasRunning.current === running) return;
        wasRunning.current = running;
        setOpen(running);   // a new turn opens it; the end of one folds it away
    }, [running]);

    const list = Array.isArray(todos) ? todos : [];
    if (!list.length) return null;
    const done = list.filter((x) => x && x.done).length;
    const label = t ? t('app_studio.shell.ai_plan', "The AI's plan") : "The AI's plan";

    if (!open) {
        return (
            <button
                type="button"
                onClick={() => setOpen(true)}
                className={`absolute ${PLACEMENT[placement] || PLACEMENT["top-left"]} z-20 inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] shadow-sm backdrop-blur-sm ${className}`}
                style={{ borderColor: 'var(--border-default)', background: 'color-mix(in srgb, var(--bg-card) 92%, transparent)', color: 'var(--text-secondary)', ...(style || {}) }}
                data-testid={`${idPrefix}-plan-pill`}
                aria-expanded={false}
            >
                <ListTodo className="h-3 w-3" aria-hidden="true" />
                {label}
                <span className="tabular-nums" style={{ color: 'var(--text-tertiary)' }}>{done}/{list.length}</span>
            </button>
        );
    }
    return (
        <div
            className={`pointer-events-auto absolute ${PLACEMENT[placement] || PLACEMENT["top-left"]} z-20 w-[240px] max-h-[calc(100%-24px)] overflow-y-auto rounded-xl border shadow-md backdrop-blur-sm ${className}`}
            style={{ borderColor: 'var(--border-default)', background: 'color-mix(in srgb, var(--bg-card) 95%, transparent)', ...(style || {}) }}
            data-testid={`${idPrefix}-plan-panel`}
            aria-label={label}
        >
            <button
                type="button"
                onClick={() => setOpen(false)}
                className="flex w-full items-center justify-end px-2 pt-1.5"
                style={{ color: 'var(--text-tertiary)' }}
                aria-label={t ? t('app_studio.shell.ai_plan_hide', 'Hide the plan') : 'Hide the plan'}
                data-testid={`${idPrefix}-plan-hide`}
            >
                <ChevronUp className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
            <div className="px-2 pb-2">
                <BuilderPlanChecklist todos={list} running={running} />
            </div>
        </div>
    );
}
