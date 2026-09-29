import React, { useState, useMemo } from 'react';
import { AlertCircle, AlertTriangle, X, ChevronDown, ChevronUp } from 'lucide-react';
import { buildStepLabelMap, resolveOwningStepId, humanizeIssueText } from './flow/displayHelpers';
import FindingRow from '../../shared/FindingRow';

/**
 * The validation chip in the canvas's north-west zone (design 1a: "● 1
 * binding missing · step 12"), next to the flow summary. It used to float
 * bottom-right — on top of the minimap.
 *
 * Collapsed: a small chip with a count + severity dot.
 * Expanded:  the full record list, dropping down from the chip.
 *
 * Same data shape as the old BuilderErrorBanner so the structured
 * `{code, path, message, hint}` records stay readable. Renders nothing when
 * there is nothing to surface, so a healthy automation has zero visual noise.
 *
 * Records never show raw step ids — `def` (passed so we can resolve labels)
 * lets each record show the step's NAME instead, and clicking a record
 * (`onFocusStep`) jumps to that node on the canvas.
 */
export default function FloatingValidationPill({ fatalError, validation, aborted, onDismissFatal, def = null, onFocusStep = null }) {
    const [open, setOpen] = useState(false);
    // Hooks must run unconditionally — keep them above the empty-state return.
    const labelById = useMemo(() => buildStepLabelMap(def), [def]);
    const errors = validation?.errors || [];
    const warnings = validation?.warnings || [];
    const total = errors.length + warnings.length + (fatalError ? 1 : 0) + (aborted ? 1 : 0);
    if (total === 0) return null;

    const hasErrors = !!fatalError || errors.length > 0;
    const tone = hasErrors ? 'var(--error)' : 'var(--warning)';
    const Icon = hasErrors ? AlertCircle : AlertTriangle;
    // Only call it "Validation" when there are actual validation records; a
    // fatal connection/build error or an abort isn't a validation failure.
    const hasValidationRecords = errors.length > 0 || warnings.length > 0;
    const headerLabel = hasValidationRecords ? 'Validation' : (fatalError ? 'Build interrupted' : 'Builder');
    const fatalErrorText = humanizeIssueText(fatalError, labelById);
    // The one record's own words on the chip when there is exactly one —
    // "1 binding missing · step 12" reads; "1 issue" only counts.
    const only = total === 1 && hasValidationRecords ? (errors[0] || warnings[0]) : null;
    const onlyStep = only ? resolveOwningStepId(only, def) : null;
    const onlyLabel = only
        ? `${humanizeIssueText(only.message, labelById)}${onlyStep && labelById.get(onlyStep) ? ` · ${labelById.get(onlyStep)}` : ''}`
        : null;

    return (
        <div className="relative flex flex-col items-start gap-2" data-testid="validation-pill">
            <button
                onClick={() => setOpen(o => !o)}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--bg-card)] border px-2.5 py-[5px] text-[12px] font-semibold shadow-sm hover:bg-[var(--bg-tertiary)] transition max-w-[360px]"
                style={{ borderColor: tone, color: tone }}
                title={open ? 'Collapse' : `${total} validation issue${total === 1 ? '' : 's'}`}
            >
                <span className="h-2 w-2 rounded-full shrink-0" style={{ background: tone }} aria-hidden="true" />
                <span className="truncate">
                    {/* Expanded, the chip is the collapse control and says the
                        count; the record itself is in the list right below. */}
                    {(!open && onlyLabel) || `${total} ${hasErrors ? 'issue' : 'warning'}${total === 1 ? '' : 's'}`}
                </span>
                {open ? <ChevronUp size={12} className="opacity-80 shrink-0" /> : <ChevronDown size={12} className="opacity-80 shrink-0" />}
            </button>
            {open && (
                <div
                    className="absolute left-0 top-full mt-1 z-30 rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] w-[420px] max-h-[50vh] overflow-y-auto"
                    style={{ boxShadow: 'var(--shadow-popover)' }}
                >
                    <div className="flex items-center justify-between px-3 py-2 border-b border-[var(--border-default)]">
                        <div className="text-xs uppercase tracking-wide font-semibold text-[var(--text-tertiary)]">
                            {headerLabel} ({total})
                        </div>
                        <button
                            onClick={() => setOpen(false)}
                            className="p-1 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-secondary)]"
                            title="Collapse"
                        >
                            <X size={14} />
                        </button>
                    </div>
                    <div className="p-2 space-y-1.5 text-xs">
                        {fatalError && (
                            <div className="rounded px-2.5 py-2 flex items-start gap-2" style={{ background: 'color-mix(in srgb, var(--error) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--error) 30%, transparent)', color: 'var(--error)' }}>
                                <AlertCircle size={13} className="flex-shrink-0 mt-px" />
                                <div className="flex-1 min-w-0">
                                    <div>{fatalErrorText}</div>
                                </div>
                                {onDismissFatal && (
                                    <button onClick={onDismissFatal} className="text-[10px] underline hover:no-underline opacity-80 flex-shrink-0">
                                        dismiss
                                    </button>
                                )}
                            </div>
                        )}
                        {aborted && (
                            <div className="rounded px-2.5 py-2 flex items-start gap-2" style={{ background: 'color-mix(in srgb, var(--warning) 10%, transparent)', border: '1px solid color-mix(in srgb, var(--warning) 30%, transparent)', color: 'var(--warning)' }}>
                                <AlertTriangle size={13} className="flex-shrink-0 mt-px" />
                                <div className="flex-1">
                                    {/* The server ends a turn early when one step was
                                        refused three times running, or when four rounds
                                        in a row built nothing; the sentence that says
                                        WHICH step is in the chat, so the chip points there
                                        instead of at "iterations" the user never chose. */}
                                    {(aborted.reason === 'repeated_rejection' || aborted.reason === 'no_progress')
                                        ? 'Builder stopped: one step was rejected repeatedly — see the message in the chat.'
                                        : `Builder stopped after ${aborted.iterations} iterations without finalising — review the issues below and ask the builder to fix them.`}
                                </div>
                            </div>
                        )}
                        {errors.map((e, i) => <Record key={`e-${i}`} record={e} def={def} labelById={labelById} onFocusStep={onFocusStep} />)}
                        {warnings.map((w, i) => <Record key={`w-${i}`} record={w} def={def} labelById={labelById} onFocusStep={onFocusStep} />)}
                    </div>
                </div>
            )}
        </div>
    );
}

/**
 * One validation record, mapped onto the SHARED finding row
 * (shared/FindingRow.jsx — this used to be that row's markup, and moved there
 * so Studio's "Needs attention" list draws an item exactly like the canvas
 * does). Everything canvas-specific stays here: resolving which step owns the
 * record, turning its raw ids into step names, and where a click goes.
 */
function Record({ record, def, labelById, onFocusStep }) {
    const owningId = resolveOwningStepId(record, def);
    const stepLabel = owningId ? (labelById.get(owningId) || null) : null;
    const clickable = !!(onFocusStep && owningId);
    return (
        <FindingRow
            code={record.code}
            severity={record.severity === 'error' ? 'error' : 'warning'}
            label={stepLabel}
            message={humanizeIssueText(record.message, labelById)}
            hint={record.hint ? humanizeIssueText(record.hint, labelById) : null}
            onOpen={clickable ? () => onFocusStep(owningId) : null}
        />
    );
}
