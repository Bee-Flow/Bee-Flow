// Shared sections (RetrySection, FieldsSection,
// SourceSummaryRow, CollectionArrayRefField, useElementSample) plus the small
// collection / datetime / wait step editors, extracted verbatim from
// SettingsForm.jsx.
import { RotateCw } from 'lucide-react';
import { useMemo, useState } from 'react';
import { walkPath } from '../../../../../utils/bindingHelpers';
import FieldKeyCombobox from '../../mapping/FieldKeyCombobox';
import PathField from '../../mapping/PathField';
import ToolInputForm from '../../mapping/ToolInputForm';
import { collectArrayPaths, resolveElementSample, elementFieldOptions } from '../../mapping/upstream';
import { useVariablePickerContext } from '../../mapping/VariablePickerContext';
import AccordionSection from '../AccordionSection';
import { datetimeTargetColumn, dateInputPatch } from '../datetimeTarget';
import { humanizeFieldKey } from '../displayHelpers';
import { WAIT_UNIT_FACTOR, clampWaitSeconds, waitUnitFor } from '../waitDuration';
import { controlSurfaceClass, FormRow, inputClass } from './formPrimitives';

/**
 * Whether this step's retry row counts as CONFIGURED — what the Advanced
 * section's collapsed "has content" dot is asking. `max: 0` is the runner's
 * own "do not retry" and reads as off here for the same reason it does in
 * the row itself, so a step carrying one is not advertised as having a
 * setting the author would open the section and fail to find.
 */
function retryIsSet(draft) {
    return !!(draft && draft.retry && Number(draft.retry.max) > 0);
}

/** The try-again counts offered, as extra attempts AFTER the first one. */
const RETRY_TRY_COUNTS = [1, 2, 3, 5];
/** The waits offered, in the runner's own unit. */
const RETRY_WAIT_MS = [0, 2000, 5000, 15000, 30000, 60_000];
/** Two extra tries, five seconds apart — a rate limit's usual shape. */
const RETRY_DEFAULT = { max: 2, backoffMs: 5000 };
/** Half the default run budget (RUN_HARD_TIMEOUT_MS, 5 min) spent waiting. */
const RETRY_LONG_WAIT_MS = 150_000;

function retryTriesLabel(n) {
    if (n === 1) return 'Once';
    if (n === 2) return 'Twice';
    return `${n} times`;
}

function retryWaitLabel(ms) {
    if (!ms) return 'Straight away';
    const s = Math.round(ms / 100) / 10;
    if (s >= 60 && s % 60 === 0) return `After ${s / 60} minute${s === 60 ? '' : 's'}`;
    return `After ${s} second${s === 1 ? '' : 's'}`;
}

/** The offered values, plus whatever is actually stored if it isn't one of them. */
function retryChoices(offered, stored) {
    return offered.includes(stored) ? offered : [...offered, stored].sort((a, b) => a - b);
}

/**
 * How many rows the waiting is paid on.
 *
 * NOT always one. When the same step also has "Run once per item" ticked the
 * retry is owned PER ROW: execution.js hands a step with a `forEach.overRef`
 * to execForEachStep and then stands back (§WS2.5, `err.foreachHandled`),
 * because retrying the whole fan-out would re-run the rows that already
 * succeeded — so execFlow.js sleeps `backoffMs` between the attempts of EACH
 * row instead. Two tries five seconds apart is ten seconds on a plain step
 * and up to a thousand over a default 100-row fan-out, and the fan-out is
 * exactly where a rate-limited integration earns a retry in the first place.
 * Summing this row on its own printed "10s" in calm grey for the run that was
 * certain to be killed by the 5-minute budget first — the single case the
 * line exists to warn about, and the two rows sit one above the other in the
 * same Advanced section, so the author reads them as one setting.
 *
 * The cap is the runner's own — `Math.min(maxIterations || 100, 1000)`
 * (execFlow.js) — and it counts only once `overRef` is set, because that is
 * the condition execution.js dispatches per item on. A half-filled picker
 * still reads as one step, which is what it still runs as.
 */
function retryRowCap(forEach, repeat = null) {
    // A repeat (the v2 per-item run, execRepeat.js) retries per item the same way.
    if (repeat && repeat.over) return Math.min(Number(repeat.max) || 100, 1000);
    if (!forEach || !forEach.overRef) return 1;
    return Math.min(Number(forEach.maxIterations) || 100, 1000);
}

/**
 * The waiting, added up in the author's own terms, or nothing at all when the
 * tries are immediate. Amber past half the default run budget, where the
 * waiting alone is the thing that ends the run.
 */
function RetryWaitTotal({ tries, waitMs, rowCap }) {
    const worstCaseMs = tries * waitMs * rowCap;
    if (worstCaseMs <= 0) return null;
    const long = worstCaseMs >= RETRY_LONG_WAIT_MS;
    const seconds = Math.round(worstCaseMs / 1000);
    return (
        <p className={`text-[11px] font-medium ${long
            ? 'text-amber-600 dark:text-amber-400'
            : 'text-[var(--text-secondary)]'}`}>
            {rowCap > 1
                ? `Each row is tried again on its own, so waiting can add up to ${seconds}s across all ${rowCap} rows`
                : `Waiting can add up to ${seconds}s to this run`}
            {long
                ? ' — long enough to run the routine out of time before the tries run out.'
                : '.'}
        </p>
    );
}

/**
 * "If this fails" — the step-level retry the runner has honoured all along
 * (`step.retry = { max, backoffMs }`, core/automationRunner/execution.js) and
 * that no screen could ever ask for. That code is complete: it sleeps
 * `backoffMs` between attempts, records EVERY attempt in the run history
 * rather than only the last (so a flaky tool is visible instead of looking
 * like one clean failure), and stands back when a forEach already retried per
 * item (`err.foreachHandled`) so a fan-out is never re-run whole. Meanwhile a
 * timeout, a rate limit or a 503 — the three commonest ways a real
 * integration routine dies — took the whole run down, because the only way
 * to set the field was to hand-edit the JSON.
 *
 * The words here are the consequence, never the mechanism: "Try again", not
 * "retry policy"; "Wait before trying again", not "backoff". And the row
 * spells out what happens when the tries run out, because that is the
 * question an author actually has, and the answer is reassuringly boring:
 * nothing new, the step fails exactly as it does today.
 *
 * TWO CLOSED LISTS, NOT TWO NUMBER FIELDS. `retry` has no validator at all
 * — grep automation/validate.js for it — so whatever this row writes is
 * what the runner sleeps on. A free-text field here is one fat finger away
 * from `backoffMs: 300000`, and a retry's sleep does NOT re-arm the run
 * deadline the way a Wait step's does (execution.js extends the timer only
 * for planned waits), so that typo does not retry anything: it parks the run
 * until the 5-minute budget kills it, reported as a timeout on a step that
 * had merely been asked to wait. A list of six values cannot be mistyped, and
 * it sidesteps BFSF-345 as well — the clear-and-retype trap that number
 * fields in this form keep falling into.
 *
 * A value that is NOT on the list (an AI-built step, or a hand-edited one) is
 * shown as its own option rather than snapped onto the nearest neighbour.
 * Same rule as PathField: opening a step is not consent to rewrite it, and a
 * mount-time normalisation shows up later as a diff the author never made.
 *
 * WHY THIS RENDERS ONLY WHEN `retry` IS ALREADY A KEY IN THE DRAFT:
 * formState's extractFormState and buildPatch are per-type allow-lists, so a
 * control whose value buildPatch drops looks saved, saves nothing, and is
 * gone on the next open — flushNow compares the patch the draft builds with
 * the patch the baseline builds, finds them equal, and never calls the server
 * at all. This product has shipped exactly that bug twice (datatable's
 * Iteration toggle, C12; integration_action's askOnce tick) and both
 * post-mortems are still in formState.js. RETRY_FORM_TYPES is the list that
 * decides, and it is the same list in both directions: a type on it gets
 * `retry` in its draft and applyRetryPatch on the way out, and a type off it
 * gets no row rather than a lying one. The gate is the key's PRESENCE, not
 * the list, so the row cannot outlive its own round-trip if the list is ever
 * narrowed.
 */
function RetrySection({ draft, set }) {
    if (!draft || !('retry' in draft)) return null;
    // `max: 0` is the runner's own "do not retry" (`retry.max > 0` gates the
    // whole loop), so it reads as off here rather than as a broken on.
    const stored = draft.retry && Number(draft.retry.max) > 0 ? draft.retry : null;
    const enabled = !!stored;
    const tries = Number(stored?.max) || 1;
    const waitMs = Number(stored?.backoffMs) || 0;
    const patch = (over) => set('retry', { max: tries, backoffMs: waitMs, ...over });
    return (
        <div className="rounded-lg border border-[var(--border-default)] p-3 space-y-2 mt-2">
            <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={enabled}
                    onChange={(e) => set('retry', e.target.checked ? { ...RETRY_DEFAULT } : null)} />
                <span className="inline-flex items-center gap-1.5 font-medium text-[var(--text-primary)]">
                    <RotateCw size={13} /> Try again if this step fails
                </span>
            </label>
            <p className="text-[11px] text-[var(--text-secondary)]">
                For the failures that pass on their own — a timeout, a service that is briefly busy,
                a “too many requests”. Not for a wrong password or a missing field: those fail the
                same way every time.
            </p>
            {enabled && (
                <div className="space-y-3 pt-1">
                    <FormRow label="Try again" htmlFor="retry-tries"
                        hint="How many more times to run this step after the first attempt fails.">
                        <select
                            id="retry-tries"
                            value={tries}
                            onChange={(e) => patch({ max: Number(e.target.value) })}
                            className={inputClass()}
                        >
                            {retryChoices(RETRY_TRY_COUNTS, tries).map(n => (
                                <option key={n} value={n}>{retryTriesLabel(n)}</option>
                            ))}
                        </select>
                    </FormRow>
                    <FormRow label="Wait before trying again" htmlFor="retry-wait"
                        hint="Trying again immediately usually hits the same problem — a few seconds is enough for most of them to clear.">
                        <select
                            id="retry-wait"
                            value={waitMs}
                            onChange={(e) => patch({ backoffMs: Number(e.target.value) })}
                            className={inputClass()}
                        >
                            {retryChoices(RETRY_WAIT_MS, waitMs).map(ms => (
                                <option key={ms} value={ms}>{retryWaitLabel(ms)}</option>
                            ))}
                        </select>
                    </FormRow>
                    {/* The question every author asks next, answered before they
                        have to run it to find out. */}
                    <p className="text-[11px] text-[var(--text-secondary)]">
                        If the last try fails too, the step fails and the routine stops there — exactly
                        as it does now. Every attempt is kept in the run history, so you can see how
                        often it took more than one.
                    </p>
                    <RetryWaitTotal tries={tries} waitMs={waitMs} rowCap={retryRowCap(draft.forEach, draft.repeat)} />
                </div>
            )}
        </div>
    );
}

/**
 * Shared "fields" section for the two `draft.fields`-backed editors (`set`
 * and `layer_output`): a keep-empty ToolInputForm inside an AccordionSection.
 * Only the stepType, title/label, and hint differ.
 */
function FieldsSection({
    draft, set, stepType, title, hint, onFocusField, previewSample,
    errorSections = new Set(), footer = null, inputProps = null,
}) {
    return (
        <AccordionSection stepType={stepType} sectionKey="fields" title={title} defaultOpen forceOpen={errorSections.has('fields')}>
            {/* The hint is a plain sentence, not a FormRow with a (?) icon: the
                accordion header already carries the title, so a FormRow here
                printed the same words twice and hid the explanation behind a
                tooltip nobody opens. */}
            {hint && <p className="text-[11px] text-[var(--text-tertiary)] mb-2">{hint}</p>}
            <ToolInputForm
                inputs={draft.fields || {}}
                onChange={(next) => set('fields', next)}
                inputSchema={null}
                keepEmptyFields
                onFocusField={onFocusField}
                previewSample={previewSample}
                {...(inputProps || {})}
            />
            {footer}
        </AccordionSection>
    );
}

/**
 * The one-line "Working through ‹gmail search› · Results — 10 items" row with
 * its `change` reveal. Shared by the Condition editor (RouteFields) and the Edit
 * data editor so the two list-mode steps read identically on screen.
 */
function SourceSummaryRow({ hint, warning = null, source, maxItems, onPatch, groups, onFocusField, previewSample }) {
    const pickerCtx = useVariablePickerContext();
    const [open, setOpen] = useState(false);
    const summary = useMemo(
        () => describeSourceList(source, pickerCtx.groups, previewSample),
        [source, pickerCtx.groups, previewSample],
    );
    return (
        <FormRow label="Working through" hint={hint}>
            <div className="flex items-center gap-2 text-xs text-[var(--text-secondary)]">
                {summary ? (
                    <span className="truncate">
                        <span className="text-[var(--text-primary)]">{summary.stepLabel}</span>
                        <span className="text-[var(--text-tertiary)]"> · </span>
                        <span className="text-[var(--text-primary)]">{summary.fieldLabel}</span>
                        {summary.count != null && (
                            <span className="text-[var(--text-tertiary)]"> — {summary.count} item{summary.count === 1 ? '' : 's'}</span>
                        )}
                    </span>
                ) : (
                    <span className="text-amber-600 dark:text-amber-400 truncate">
                        {source || 'No list picked yet'}
                    </span>
                )}
                <button
                    type="button"
                    onClick={() => setOpen(o => !o)}
                    aria-label={open ? 'Done changing the source list' : 'Change the source list'}
                    className="ml-auto shrink-0 text-[10px] text-[var(--accent)] hover:underline"
                >
                    {open ? 'done' : 'change'}
                </button>
            </div>
            {/* Said in the open, not behind the hint icon: this is the reason
                the step produced nothing, next to the control that fixes it. */}
            {warning && (
                <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">{warning}</div>
            )}
            {open && (
                <div className="mt-2">
                    <CollectionArrayRefField
                        draft={{ arrayRef: source || '', maxItems }}
                        set={(k, v) => onPatch(k === 'arrayRef' ? { source: v } : { maxItems: v })}
                        groups={groups}
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                    />
                </div>
            )}
        </FormRow>
    );
}

/**
 * The one-line "Working through ‹gmail search› · Results — 10 items" summary.
 * Returns null when the path resolves to nothing we can describe, so the form
 * can fall back to showing the raw path with a warning tone.
 */
function describeSourceList(source, groups, previewSample) {
    const path = String(source || '').trim();
    if (!path) return null;
    const match = collectArrayPaths(groups, previewSample).find(a => a.path === path);
    if (!match) return null;
    const owner = (groups || []).find(g => g.basePath && path.startsWith(g.basePath));
    // Count from the RESOLVED value: for a `[*]` path `match.sample` is the
    // first element (the collectionItemsFields convention), so its length was
    // the first ROW's size, not the list's.
    const resolved = previewSample ? walkPath(path, previewSample) : undefined;
    const arr = Array.isArray(resolved) ? resolved : (Array.isArray(match.sample) ? match.sample : null);
    return {
        stepLabel: owner?.label || 'Previous step',
        fieldLabel: humanizeFieldKey(match.key),
        count: arr ? arr.length : null,
    };
}

function CollectionArrayRefField({ draft, set, groups, onFocusField, previewSample }) {
    // Array-only picker over the SHARED PathField control: friendly quick-picks
    // (nested + real-run arrays via collectArrayPaths), {} variable picker,
    // drag-to-map, name chips, and a soft "isn't a list" warning.
    const quickPicks = useMemo(() => collectArrayPaths(groups, previewSample), [groups, previewSample]);
    return (
        <>
            <FormRow label="Source list" required hint="Pick a list from a previous step — or type a path manually.">
                <PathField
                    value={draft.arrayRef || ''}
                    onChange={(v) => set('arrayRef', v)}
                    expectArray
                    quickPicks={quickPicks}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                    placeholder="No list picked yet"
                />
            </FormRow>
            {/* Optional input cap (C19): read by the runner and validated by
                the server, but previously editable only via the raw JSON
                view — the router even pointed limit's maxItems errors at a
                control that didn't exist. Blank = platform default. */}
            <FormRow label="Max input items" hint="Optional cap on input size — the run FAILS if the source list is larger (platform cap 10 000). Leave blank for the default.">
                <input
                    type="number" min={1} max={10000}
                    value={draft.maxItems === '' || draft.maxItems == null ? '' : draft.maxItems}
                    onChange={(e) => set('maxItems', e.target.value === '' ? '' : Number(e.target.value))}
                    placeholder="10000"
                    className={inputClass()}
                />
            </FormRow>
        </>
    );
}

/**
 * Resolve the current element shape of a collection op's source array so its
 * sub-fields (keyField/field, filter's `item.*` conditions) get suggestions
 * with real samples. previewSample is the NDV's merged root (design-time
 * samples + real-run/pinned overlays), so a dry-run upgrades the options.
 */
function useElementSample(arrayRef, previewSample) {
    return useMemo(() => resolveElementSample(arrayRef, previewSample), [arrayRef, previewSample]);
}

function DateTimeFields({ draft, set, groups, onFocusField, previewSample, errorSections = new Set() }) {
    const op = draft.op || 'now';
    const needsInput = op !== 'now';
    const needsInput2 = op === 'diff';
    const needsAmount = op === 'addDays' || op === 'addHours' || op === 'addMinutes';
    // Same present-or-absent convention as the Condition and Edit data nodes.
    const listMode = typeof draft.arrayRef === 'string';
    const column = datetimeTargetColumn(draft);
    return (
        <AccordionSection stepType="datetime" sectionKey="config" title="Configuration" defaultOpen forceOpen={errorSections.has('config')}>
            <FormRow label="Operation">
                <select value={op} onChange={(e) => set('op', e.target.value)} className={inputClass()}>
                    <option value="now">Today’s date and time</option>
                    <option value="parse">Read a date out of text</option>
                    <option value="format">Reformat a date</option>
                    <option value="addDays">Add days</option>
                    <option value="addHours">Add hours</option>
                    <option value="addMinutes">Add minutes</option>
                    <option value="diff">Time between two dates</option>
                    <option value="extract">Take one part of a date</option>
                </select>
            </FormRow>
            {/* One date, or a whole column of them. Dropping a column into
                "Input date" switches this automatically — before, the array
                reached the date parser whole and the step just failed. */}
            {op !== 'now' && (
                <FormRow label="Works on" hint="Set automatically when you drop a whole column into the input below.">
                    <select
                        value={listMode ? 'items' : 'single'}
                        onChange={(e) => set('arrayRef', e.target.value === 'items' ? (draft.arrayRef ?? '') : null)}
                        className={inputClass()}
                    >
                        <option value="single">One date</option>
                        <option value="items">Each row of a list</option>
                    </select>
                </FormRow>
            )}
            {listMode && (
                <CollectionArrayRefField
                    draft={draft}
                    set={set}
                    groups={groups}
                    onFocusField={onFocusField}
                    previewSample={previewSample}
                />
            )}
            {needsInput && (
                <FormRow
                    label="Input date"
                    hint={listMode
                        ? 'Which column of that list holds the date. Write it as item.<column>.'
                        : 'Pick a date from a previous step, or type a fixed date like 2026-07-01.'}
                >
                    <PathField
                        value={draft.input || ''}
                        onChange={(v) => {
                            // A dropped COLUMN switches the step to list mode —
                            // see dateInputPatch for why.
                            for (const [k, val] of Object.entries(dateInputPatch(v, { listMode }))) set(k, val);
                        }}
                        allowLiteral="date"
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder={listMode ? 'item.updated' : 'trigger.output.timestamp'}
                    />
                </FormRow>
            )}
            {listMode && (
                <FormRow
                    label="New column"
                    hint={`Every row keeps its own columns and gains this one. Leave empty to call it “${column}”.`}
                >
                    <input
                        type="text"
                        value={draft.target || ''}
                        onChange={(e) => set('target', e.target.value)}
                        placeholder={column}
                        className={inputClass()}
                    />
                </FormRow>
            )}
            {needsInput2 && (
                <FormRow label="Second date" hint="Difference is calculated as second date − input date.">
                    <PathField
                        value={draft.input2 || ''}
                        onChange={(v) => set('input2', v)}
                        allowLiteral="date"
                        onFocusField={onFocusField}
                        previewSample={previewSample}
                        placeholder="trigger.output.endsAt"
                    />
                </FormRow>
            )}
            {needsAmount && (
                <FormRow label="Amount" hint="Positive to add, negative to subtract.">
                    <input type="number" value={draft.amount ?? 0} onChange={(e) => set('amount', Number(e.target.value))} className={inputClass()} />
                </FormRow>
            )}
            {op === 'format' && (
                <FormRow label="Format" hint="How the date should be written. Building blocks: yyyy (year), MM (month), dd (day), HH, mm, ss.">
                    <input type="text" value={draft.format || ''} onChange={(e) => set('format', e.target.value)} placeholder="yyyy-MM-dd HH:mm" className={inputClass() + ' font-mono'} />
                </FormRow>
            )}
            {op === 'extract' && (
                <FormRow label="Part">
                    <select value={draft.part || 'year'} onChange={(e) => set('part', e.target.value)} className={inputClass()}>
                        <option value="year">year</option>
                        <option value="month">month</option>
                        <option value="day">day</option>
                        <option value="hour">hour</option>
                        <option value="minute">minute</option>
                        <option value="second">second</option>
                        <option value="dayOfWeek">day of the week</option>
                    </select>
                </FormRow>
            )}
            {op === 'diff' && (
                <FormRow label="Unit">
                    <select value={draft.unit || 'days'} onChange={(e) => set('unit', e.target.value)} className={inputClass()}>
                        <option value="days">days</option>
                        <option value="hours">hours</option>
                        <option value="minutes">minutes</option>
                        <option value="seconds">seconds</option>
                    </select>
                </FormRow>
            )}
        </AccordionSection>
    );
}

// Moved to flow/waitDuration.js so the canvas card renders the SAME unit this
// editor opens on — the node used to print "7200s" for a Wait set to 2 hours.
function WaitFields({ draft, set, errorSections = new Set() }) {
    const seconds = clampWaitSeconds(Number(draft.seconds ?? 5) || 5);
    // Display unit is derived ONCE on mount and held locally — switching the
    // unit only re-interprets the display; the stored value stays `seconds`
    // and is never re-emitted on mount (no autosave churn on open).
    const [unit, setUnit] = useState(() => waitUnitFor(seconds));
    const factor = WAIT_UNIT_FACTOR[unit] || 1;
    // While the field is being edited the user's raw text wins. Clamping on
    // every keystroke made the field unusable: emptying it gives
    // `Number('') === 0` — not NaN, so the old guard never fired — and
    // `Math.max(1, 0)` snapped it straight back to 1, so you could never
    // clear-and-retype (BFSF-345).
    const [typed, setTyped] = useState(null);
    const display = typed ?? String(Math.round((seconds / factor) * 100) / 100);

    const commit = (raw) => {
        const n = Number(raw);
        if (raw == null || String(raw).trim() === '' || !Number.isFinite(n) || n <= 0) return false;
        set('seconds', clampWaitSeconds(n * factor));
        return true;
    };
    const onValue = (e) => {
        setTyped(e.target.value);
        commit(e.target.value);
    };
    // Dropping the raw text on blur is what restores the last stored value
    // when the field was left empty or nonsense.
    const onBlur = () => { setTyped(null); };
    // Switching the unit keeps the number the user is looking at and
    // re-interprets it (5 seconds → 5 minutes), instead of rescaling it into
    // a rounded-to-zero 0.08 that sits below the field's own minimum.
    const onUnit = (e) => {
        const next = e.target.value;
        const n = Number(display);
        setUnit(next);
        setTyped(null);
        if (Number.isFinite(n) && n > 0) set('seconds', clampWaitSeconds(n * (WAIT_UNIT_FACTOR[next] || 1)));
    };

    // `inputClass()` bakes in `w-full`; adding `w-auto` next to it leaves two
    // utilities racing for one property (won by stylesheet order, not class
    // order — see formStyles.js), which let the unit select eat the whole row
    // and collapsed the number field to its spinner. Both controls carry
    // their own width instead.
    const controlSize = 'px-2 py-1.5 text-sm';
    return (
        <AccordionSection stepType="wait" sectionKey="config" title="Configuration" defaultOpen forceOpen={errorSections.has('config')}>
            <FormRow label="Wait for" required hint="Up to 24 hours. Dry-run skips the wait.">
                <div className="flex items-stretch gap-1.5">
                    <input
                        type="number"
                        min={unit === 'seconds' ? 1 : 0.01}
                        step={unit === 'seconds' ? 1 : 'any'}
                        value={display}
                        onChange={onValue}
                        onBlur={onBlur}
                        aria-label="Wait duration"
                        className={controlSurfaceClass(`flex-1 min-w-[5rem] ${controlSize}`)}
                    />
                    <select
                        value={unit}
                        onChange={onUnit}
                        className={controlSurfaceClass(`w-auto shrink-0 ${controlSize}`)}
                        aria-label="Duration unit"
                    >
                        <option value="seconds">seconds</option>
                        <option value="minutes">minutes</option>
                        <option value="hours">hours</option>
                    </select>
                </div>
            </FormRow>
        </AccordionSection>
    );
}

function LimitFields({ draft, set, groups, onFocusField, previewSample, errorSections = new Set() }) {
    return (
        <AccordionSection stepType="limit" sectionKey="config" title="Configuration" defaultOpen forceOpen={errorSections.has('config')}>
            <CollectionArrayRefField draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} />
            <FormRow label="Which end">
                <select value={draft.mode || 'first'} onChange={(e) => set('mode', e.target.value)} className={inputClass()}>
                    <option value="first">Keep the first few</option>
                    <option value="last">Keep the last few</option>
                </select>
            </FormRow>
            <FormRow label="How many to keep" hint="0 keeps nothing.">
                <input type="number" min={0} value={draft.count ?? 10} onChange={(e) => set('count', Number(e.target.value))} className={inputClass()} />
            </FormRow>
        </AccordionSection>
    );
}

function DedupeFields({ draft, set, groups, onFocusField, previewSample, errorSections = new Set() }) {
    const elementSample = useElementSample(draft.arrayRef, previewSample);
    const options = useMemo(() => elementFieldOptions(elementSample), [elementSample]);
    return (
        <AccordionSection stepType="dedupe" sectionKey="config" title="Configuration" defaultOpen forceOpen={errorSections.has('config')}>
            <CollectionArrayRefField draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} />
            <FormRow label="Key field" hint="Optional. Two items with the same value here count as the same item. Leave it blank to drop only items that are identical all the way through.">
                <FieldKeyCombobox value={draft.keyField || ''} onChange={(v) => set('keyField', v)} options={options} placeholder="id" label="Key field" onFocusField={onFocusField} />
            </FormRow>
        </AccordionSection>
    );
}

function AggregateFields({ draft, set, groups, onFocusField, previewSample, errorSections = new Set() }) {
    const elementSample = useElementSample(draft.arrayRef, previewSample);
    const options = useMemo(() => elementFieldOptions(elementSample), [elementSample]);
    return (
        <AccordionSection stepType="aggregate" sectionKey="config" title="Configuration" defaultOpen forceOpen={errorSections.has('config')}>
            <CollectionArrayRefField draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} />
            <FormRow label="Field" hint="The field to take from every item. The result is a plain list of just those values. If no item has this field the step is skipped rather than handing on a list of blanks.">
                <FieldKeyCombobox value={draft.field || ''} onChange={(v) => set('field', v)} options={options} placeholder="email" label="Field" onFocusField={onFocusField} />
            </FormRow>
        </AccordionSection>
    );
}

function SummarizeFields({ draft, set, groups, onFocusField, previewSample, errorSections = new Set() }) {
    const elementSample = useElementSample(draft.arrayRef, previewSample);
    const options = useMemo(() => elementFieldOptions(elementSample), [elementSample]);
    return (
        <AccordionSection stepType="summarize" sectionKey="config" title="Configuration" defaultOpen forceOpen={errorSections.has('config')}>
            <CollectionArrayRefField draft={draft} set={set} groups={groups} onFocusField={onFocusField} previewSample={previewSample} />
            {/* `count` ignores the field entirely (it counts items), so asking
                for one there would be misleading. */}
            {draft.op !== 'count' && (
                <FormRow label="Field" hint="The number to work with, read from every item. If no item has this field the step is skipped rather than reporting 0.">
                    <FieldKeyCombobox value={draft.field || ''} onChange={(v) => set('field', v)} options={options} placeholder="amount" label="Field" onFocusField={onFocusField} />
                </FormRow>
            )}
            <FormRow label="What to work out">
                <select value={draft.op || 'sum'} onChange={(e) => set('op', e.target.value)} className={inputClass()}>
                    <option value="sum">Total — add them all up</option>
                    <option value="count">Count — how many items</option>
                    <option value="avg">Average</option>
                    <option value="min">Lowest</option>
                    <option value="max">Highest</option>
                </select>
            </FormRow>
        </AccordionSection>
    );
}

export {
    RetrySection, retryIsSet, FieldsSection, SourceSummaryRow, CollectionArrayRefField, useElementSample,
    DateTimeFields, WaitFields, LimitFields, DedupeFields, AggregateFields, SummarizeFields,
};
