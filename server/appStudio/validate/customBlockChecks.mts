/**
 * App Studio validator: what a `custom_block` declares against what its template uses.
 *
 * The value of `props.block` itself (the vocabulary of the template, the stylesheet, the
 * names) is held to its canonical form by the object-shape check (objectChecks.mts with
 * customBlock/blockShape.mts): everything the sanitiser would leave out is an error there.
 * Here are the questions that need the rest of the definition, and the author's own mistakes
 * that are never repaired for them:
 *   - a formula that does not parse, with its template line;
 *   - a formula that reads a name that is no input (inputs are all a template sees);
 *   - an input's binding, like any other binding;
 *   - an event wired to an action that does not exist; a control that raises an event nobody
 *     declared.
 */

import { createRequire } from 'node:module';
import { canonicalTemplate, inspectTemplate } from '../../shared/blockTemplate/index.mjs';

const nodeRequire = createRequire(import.meta.url);
const { pickClosestId } = nodeRequire('./shared') as { pickClosestId: (id: string, candidates: string[]) => string | null };
const { validateBinding } = nodeRequire('./bindings') as { validateBinding: (key: string, value: unknown, path: string, ctx: unknown) => void };

type Finding = { code: string; severity: string; path: string; message: string; hint: string };
type Ctx = { pushE: (rec: Finding) => void; pushW: (rec: Finding) => void; actionIds: Set<string> };

function isObject(v: unknown): v is Record<string, unknown> {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
}

const namesOf = (v: unknown): string[] => (isObject(v) ? Object.keys(v) : []);

function checkEvents(events: unknown, raisedEvents: string[], path: string, ctx: Ctx): void {
    const declared = namesOf(events);
    for (const name of raisedEvents) {
        if (declared.includes(name)) continue;
        ctx.pushW({
            code: 'custom_block.event_undeclared', severity: 'warning', path: `${path}.template`,
            message: `A control raises the event "${name}" (data-emit), but events has no entry of that name, so it does nothing.`,
            hint: `Add "${name}": "<actionId>" to events, or remove data-emit from the control.`,
        });
    }
    for (const name of declared) {
        const ref = (events as Record<string, unknown>)[name];
        if (ref !== null && !(typeof ref === 'string' && ctx.actionIds.has(ref))) {
            const suggestion = pickClosestId(String(ref), Array.from(ctx.actionIds));
            ctx.pushE({
                code: 'event.action_unresolved', severity: 'error', path: `${path}.events.${name}`,
                message: `The event "${name}" references unknown action ${JSON.stringify(ref)}.`,
                hint: suggestion ? `Did you mean "${suggestion}"?` : 'Add the action to definition.actions first, or set the event to null.',
            });
        }
        if (!raisedEvents.includes(name)) {
            ctx.pushW({
                code: 'custom_block.event_unused', severity: 'warning', path: `${path}.events.${name}`,
                message: `No control of the template raises the event "${name}", so its action never runs from this block.`,
                hint: `Put data-emit="${name}" on a <button> of the template, or remove the event.`,
            });
        }
    }
}

/**
 * @param props the node's props, as the walk reads them (untrusted)
 * @param path  the node's path in the definition
 */
export function checkCustomBlock(props: Record<string, unknown>, path: string, ctx: Ctx): void {
    const block = props.block;
    const at = `${path}.props.block`;
    if (!isObject(block) || typeof block.template !== 'string' || !block.template.trim()) {
        ctx.pushW({ code: 'custom_block.empty', severity: 'warning', path: at, message: 'This custom block has no template, so it draws nothing.', hint: 'Write its template with app_edit_block, or remove the block.' });
        return;
    }
    const used = inspectTemplate(canonicalTemplate(block.template).nodes);
    for (const problem of used.errors) {
        ctx.pushE({ code: 'custom_block.formula_invalid', severity: 'error', path: `${at}.template`, message: `Template line ${problem.line}: ${problem.message}`, hint: 'Fix the formula. It uses the same expression language as every other formula of the app.' });
    }
    const inputs = namesOf(block.inputs);
    for (const ref of used.refs) {
        if (inputs.includes(ref)) continue;
        ctx.pushE({
            code: 'custom_block.input_unknown', severity: 'error', path: `${at}.template`,
            message: `The template reads "${ref}", which is not an input of this block. A template sees its inputs and nothing else.`,
            hint: `Add an input named "${ref}" with a binding for the value${inputs.length ? `, or use one of: ${inputs.join(', ')}` : ''}.`,
        });
    }
    for (const name of inputs) validateBinding(name, (block.inputs as Record<string, unknown>)[name], `${at}.inputs.${name}`, ctx);
    checkEvents(block.events, used.events, at, ctx);
}
