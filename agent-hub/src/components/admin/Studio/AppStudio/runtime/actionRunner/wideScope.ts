/**
 * The wide server scope (an app whose definition sets `serverScope: 'wide'`): what the browser sends with
 * ONE server step so that step's formulas read `screen`, `forms` and `actions` on the server as they do here.
 *
 * Only for an app that opted in, and only the roots the step itself names: a step that reads none of them
 * posts the body it always did. The step's own text is searched for the root's name and, for an action
 * result, the action's id. A name that happens to occur in a text only sends a little more than needed.
 * The server bounds what it reads and treats all of it as the viewer's input, like `formValues` and `vars`.
 */
import type { RunnerContext } from './runnerContext';
import type { ActionState, RunStep } from './core';
import type { SeqState } from './serverSteps';

const SERVER_SCOPE_WIDE = 'wide';

type Bag = Record<string, unknown>;
const isBag = (v: unknown): v is Bag => v !== null && typeof v === 'object' && !Array.isArray(v);

function textOf(step: RunStep): string {
    try {
        return JSON.stringify(step) || '';
    } catch {
        return '';
    }
}

/** The results the step names: every action with an entry whose id occurs in the step's text. */
function namedResults(text: string, state: ActionState): Bag {
    const out: Bag = {};
    for (const [actionId, entry] of Object.entries(state)) {
        if (!entry || !text.includes(actionId)) continue;
        out[actionId] = { status: entry.status, result: entry.result ?? null, error: entry.error ?? null };
    }
    return out;
}

/** The extra keys of a /step body for this step: {} unless the app opted in and the step reads a wide root. */
export function wideScopeBody(ctx: RunnerContext, step: RunStep, st: SeqState): Bag {
    const live = ctx.live.current;
    if (live.definition?.serverScope !== SERVER_SCOPE_WIDE) return {};
    const text = textOf(step);
    const out: Bag = {};
    const params = isBag(live.screen) ? live.screen.params : null;
    if (text.includes('screen') && isBag(params) && Object.keys(params).length) out.screenParams = params;
    if (text.includes('forms') && isBag(live.forms) && Object.keys(live.forms).length) out.forms = live.forms;
    if (text.includes('actions')) {
        // As the step's own formulas see it here: the running action's entry is the last step's result.
        const state: ActionState = { ...live.actionState };
        if (st.lastResult !== undefined) state[st.actionId] = { status: 'running', result: st.lastResult, error: null };
        const results = namedResults(text, state);
        if (Object.keys(results).length) out.actionResults = results;
    }
    return out;
}
