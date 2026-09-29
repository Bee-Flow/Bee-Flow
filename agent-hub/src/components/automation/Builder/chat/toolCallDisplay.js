/**
 * One builder tool call → the row the Assistant panel shows for it.
 *
 * The panel used to render `tc.name` in a <code> tag: eight rows reading
 * `builder_add_array_op`, three of them identical and standing for three
 * different things. Everything needed to say what actually happened was
 * already in the props and was being thrown away — a mutating call's result
 * carries `added`, the created step itself, with its real type and label.
 *
 * So the step's OWN answer is preferred over any name-parsing: `added.type`
 * feeds the same NODE_DEFS / family colour the canvas uses one column to the
 * right, which is what makes the two agree instead of drifting. Only the
 * handful of tools that create no step need a verb of their own.
 *
 * Every verb is keyed rather than written bare. That is not ceremony: the
 * i18n guard's helper scan (i18nGuard.test.js check 8) exists to stop new
 * tables of untranslated English accumulating in `.js` modules, and a bare
 * `{tool: 'Finished and saved'}` map is precisely the shape it hunts. Keys
 * also mean this file can answer in Dutch the day the rest of the panel does.
 */

import { INTEGRATION_META, resolveIntegrationFromTool } from '../../../../utils/integrationIcons';
import { humanizeToolName } from '../flow/displayHelpers';
import { nodeTypeLabel } from '../flow/nodeDefs';
import { typeGroupOf } from '../flow/nodeTypeColors';

/**
 * Tools that create no step, so `result.added` cannot name them. Past tense,
 * following the App Studio builder's TOOL_LABELS convention — the wording is
 * the product's, not the model's.
 */
const VERBS = {
    builder_propose_trigger: { key: 'routines.builder.act.trigger', en: 'Set the trigger' },
    builder_remove_step: { key: 'routines.builder.act.remove', en: 'Removed a step' },
    builder_update_step: { key: 'routines.builder.act.update', en: 'Adjusted a step' },
    builder_update_steps: { key: 'routines.builder.act.update', en: 'Adjusted a step' },
    builder_replace_step: { key: 'routines.builder.act.replace', en: 'Replaced a step' },
    builder_move_step: { key: 'routines.builder.act.move', en: 'Moved a step' },
    builder_wire_error_branch: { key: 'routines.builder.act.error_branch', en: 'Added a fallback for failures' },
    builder_set_metadata: { key: 'routines.builder.act.metadata', en: 'Named the routine' },
    builder_inspect_tool: { key: 'routines.builder.act.inspect', en: 'Looked up how an app works' },
    builder_summarise: { key: 'routines.builder.act.summarise', en: 'Reviewed the routine' },
    builder_request_dry_run: { key: 'routines.builder.act.dry_run', en: 'Tested the routine' },
    builder_finalize: { key: 'routines.builder.act.finalize', en: 'Finished and saved' },
    builder_set_plan: { key: 'routines.builder.act.plan', en: 'Updated the plan' },
    // A table made at design time — a side effect outside the draft, no step.
    builder_create_datatable: { key: 'routines.builder.act.create_datatable', en: 'Created a table' },
    builder_propose_plan: { key: 'routines.builder.act.plan', en: 'Updated the plan' },
};

/** Model-facing echoes of the whole draft — noise in a per-call detail view. */
const ECHO_KEYS = ['_draftSteps', '_stepIds', '_fixHint', '_needsInspect'];

/**
 * The payload worth showing behind "details": the call's own arguments and
 * result, minus the whole-draft echo builderTools appends to every mutation.
 * That echo repeats the entire step list on EVERY call and says nothing about
 * this one, so it would bury the two fields somebody opened the panel for.
 */
export function detailPayload(tc) {
    const result = (tc?.result && typeof tc.result === 'object' && !Array.isArray(tc.result))
        ? Object.fromEntries(Object.entries(tc.result).filter(([k]) => !ECHO_KEYS.includes(k)))
        : tc?.result;
    return { args: tc?.arguments, result };
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' && v ? v : null);

/**
 * The step(s) a call created, as a list whatever the tool's shape: a single
 * add returns `added` as the step itself; `builder_add_steps` returns an
 * ARRAY of `{ id, type, tool?, tempId? }` — one entry per batch entry, in the
 * order the model wrote them. The old `addedStep()` returned null for the
 * array, so a six-step batch rendered as one grey "Steps" row with a wrench,
 * and the canvas dealt its cards in flowOrder rather than the model's.
 * Anything that is not a plain object is dropped, never invented.
 */
export function addedStepsOf(result) {
    if (!isPlainObject(result)) return [];
    const { added } = result;
    if (Array.isArray(added)) return added.filter(isPlainObject);
    return isPlainObject(added) ? [added] : [];
}

/** `builder_add_steps` reports its steps as an array; every single-step tool as one object. */
const isBatch = (result) => isPlainObject(result) && Array.isArray(result.added);

/**
 * The app behind a tool, by name: "Gmail", not "Action". The two id spellings
 * (dashes from the catalog, underscores from the prefix resolver) both hit.
 */
function appLabel(tool) {
    const id = resolveIntegrationFromTool(str(tool));
    if (!id) return null;
    return INTEGRATION_META[id]?.label || INTEGRATION_META[id.replace(/-/g, '_')]?.label || null;
}

/**
 * One batch entry's name. An integration action is named by its APP: a batch
 * of six Gmail actions reading "Action · Action · Action" would say nothing,
 * and the canvas card one column over shows the app's logo, not the word. A
 * batch entry carries no label of its own and none is made up for it.
 */
function stepTitle(step, t) {
    const type = str(step.type);
    const tool = str(step.tool);
    if (type === 'integration_action') return appLabel(tool) || nodeTypeLabel(type, t) || '';
    return (type && nodeTypeLabel(type, t)) || appLabel(tool) || (type ? humanizeToolName(type) : '') || '';
}

/** The created steps in the shape the activity row and the canvas share. */
function stepsOf(raw, t) {
    return raw.map(s => ({
        id: s.id ?? null,
        type: str(s.type),
        tool: str(s.tool),
        family: typeGroupOf(str(s.type)),
        title: stepTitle(s, t),
    }));
}

/** The title for a call, in the order of how much the source really knows. */
function titleFor(name, type, t) {
    // The step's own type first: that is the builder's answer, not a guess
    // from the tool's name, and it is the same word the canvas shows.
    if (type) {
        const label = nodeTypeLabel(type, t);
        if (label) return label;
    }
    const verb = VERBS[name];
    if (verb) return t ? t(verb.key, verb.en) : verb.en;
    // A builder tool added next month must degrade to something readable
    // rather than render a blank row.
    return humanizeToolName(name.replace(/^builder_(add_)?/, '')) || name || '';
}

function batchTitle(n, t) {
    if (n === 1) return t ? t('routines.builder.act.add_step_one', 'Added 1 step') : 'Added 1 step';
    return t ? t('routines.builder.act.add_steps', 'Added {n} steps', { n }) : `Added ${n} steps`;
}

/**
 * @param {{name?: string, arguments?: object, result?: any}} tc
 * @param {Function|null} t  optional translator; without one, English.
 * @returns {{title: string, detail: string, type: string|null, family: string|null,
 *            status: 'done'|'failed', error: string|null, hint: string|null,
 *            steps: Array<{id: any, type: string|null, tool: string|null, family: string|null, title: string}>}}
 *
 * A single-step tool gives today's row: the step's type as the title, its
 * label as the detail. A `builder_add_steps` batch gives "Added n steps" with
 * the entries' names as the detail and `steps` for the row to list; its
 * `type` is null (there is no one type) and its `family` is 'app' only when
 * every entry is an app, so the tile is never one family's colour for a
 * mixed batch.
 */
export function describeToolCall(tc, t = null) {
    const name = str(tc?.name) || '';
    const result = tc?.result;
    const error = isPlainObject(result) ? str(result.error) : null;
    const hint = isPlainObject(result) ? str(result._fixHint) : null;
    const raw = addedStepsOf(result);
    const steps = stepsOf(raw, t);
    const status = error ? 'failed' : 'done';

    if (isBatch(result) && steps.length) {
        return {
            title: batchTitle(steps.length, t),
            detail: steps.map(s => s.title).filter(Boolean).join(' · '),
            type: null,
            family: steps.every(s => s.family === 'app') ? 'app' : null,
            status,
            error,
            hint,
            steps,
        };
    }

    const added = raw[0] || null;
    const type = added ? str(added.type) : null;
    return {
        title: titleFor(name, type, t),
        detail: (added && str(added.label)) || '',
        type,
        family: type ? typeGroupOf(type) : null,
        status,
        error,
        hint,
        steps,
    };
}

/**
 * The row for a test run that is STILL GOING.
 *
 * `builder_request_dry_run` only becomes a call the list can show once the
 * run has finished — the server executes the tool and then reports it — so
 * for as long as the run takes (a file fan-out is minutes) the list had no
 * row for it and the spinner sat on whatever call came before, "Reviewed the
 * routine" most often, which was already done. The server now announces the
 * run the moment its row exists (`dryrun_started`), and this is the row that
 * announcement puts at the foot of the list until the real call lands.
 *
 * @param {{label?: string, done?: number, total?: number}|null} focus
 *   flow/runFocus.js's reading of the live run — the step it is on and the
 *   count so far. Null before the first step row arrives.
 * @param {Function|null} t
 * @returns {{title: string, detail: string, type: null, family: null,
 *            status: 'running', error: null, hint: null, steps: []}}
 */
export function describeLiveRun(focus, t = null) {
    const title = t ? t('routines.builder.act.dry_run_live', 'Testing the routine…') : 'Testing the routine…';
    const total = Math.max(0, Number(focus?.total) || 0);
    const done = Math.min(total, Math.max(0, Number(focus?.done) || 0));
    const label = str(focus?.label);
    // "Read file content · 1/4": the step it is on, then how far it is. Only
    // what the run has reported — no count before the first row exists.
    const detail = [label, total > 0 ? `${done}/${total}` : null].filter(Boolean).join(' · ');
    return { title, detail, type: null, family: null, status: 'running', error: null, hint: null, steps: [] };
}
