/**
 * What an unattended run may do: the steps an action may carry when a trigger starts it.
 *
 * A trigger run has no page and no person: nobody clicked, nobody is asked, nobody sees a
 * message. It runs as the app owner (unattendedIdentity.mts). So:
 *
 *   MAY      every step whose catalogue row says `unattended: 'run'` (componentSpecs/stepMeta.js,
 *            or the kind's own registry file): the flow kinds, record writes and deletes, reads,
 *            the AI steps, the document steps, a transaction, the code step, and the three steps
 *            that reach people in the owner's name (send_email, run_automation,
 *            request_approval). Each acts exactly as when the owner clicks: the same row rules
 *            for role `owner`, the same budgets and daily mail limit, the same outbound checks.
 *
 *   MAY NOT  - anything that needs a page: navigate, open_url, the modal steps, reset_form,
 *              download_file, confirm (also as a first step: nobody answers), toast and refresh
 *              (nobody sees them), the form, focus, scroll, clipboard and `set_ui` steps, `back`,
 *              a browser `wait`;
 *            - ai_browse (it streams into a visitor's page), copy_document (it needs a viewer's
 *              document pool), kb_log_query and kb_log_review (the query log holds what people
 *              asked: read only with a person present);
 *            - http_request: its own row refuses it until that step's outbound rules are decided
 *              for runs without a person;
 *            - a kind nobody declared, or one its trigger kind refuses (TriggerKind.refusedKinds);
 *            - through a called action either: the check follows call_action.
 *
 * The walls of every run stay: no send_email inside a loop, no free URL, no network in the code
 * step, and personal data leaves Bee Flow only by e-mail.
 *
 * The same function is the validator's finding (definitionKeys/triggers.js), the check before a
 * trigger is armed (triggerSync.mts), the check before every fire (unattendedIdentity.mts) and,
 * step by step, the run's own refusal (backgroundRunJob.mts `decide`). Pure: it imports the step
 * tree helpers and the catalogue's policy only.
 */

import { createRequire } from 'node:module';
import { childStepSlots } from '../../shared/appDefinition/stepFlow.mjs';

const nodeRequire = createRequire(import.meta.url);
const { stepPolicy } = nodeRequire('../componentSpecs/stepRegistry.js') as { stepPolicy: (kind: unknown, form: 'unattended') => string };
const { LIMITS } = nodeRequire('../componentSpecs/limits.js') as { LIMITS: { MAX_ACTION_DEPTH: number; MAX_CALL_DEPTH: number } };

type Obj = Record<string, unknown>;
const isObject = (v: unknown): v is Obj => v !== null && typeof v === 'object' && !Array.isArray(v);

export type UnattendedProblem = { code: string; path: string; kind: string; message: string; hint: string };
export type UnattendedOptions = {
    /** The action a call_action names (own property), or null. */
    resolveCalled?: (actionId: string) => Obj | null;
    /** Step kinds the trigger's kind refuses on top of the catalogue (TriggerKind.refusedKinds). */
    refusedKinds?: readonly string[];
};

const MAX_NESTING = LIMITS.MAX_ACTION_DEPTH + 1;
const MAX_PROBLEMS = 20;
export const UNATTENDED_HINT = 'A trigger runs the action on the server as the app owner, with nobody at the page. Keep the steps that need a page or a person in a second action behind a button, and let both call the shared part with call_action.';

/** May a step of this kind run in an unattended run? */
export function runsUnattended(kind: unknown, refusedKinds: readonly string[] = []): boolean {
    return typeof kind === 'string' && stepPolicy(kind, 'unattended') === 'run' && !refusedKinds.includes(kind);
}

/** The steps of an action: a sequence's steps, or a bare action as one step. */
function topSteps(action: Obj): unknown[] {
    if (action.kind === 'sequence') return Array.isArray(action.steps) ? action.steps : [];
    return [action];
}

/**
 * Why `action` may not run unattended: every step that may not, anywhere in its tree (branches,
 * loop bodies, onError handlers) and in the actions it calls. Empty when it may.
 */
export function unattendedActionProblems(action: unknown, id: string, opts: UnattendedOptions = {}): UnattendedProblem[] {
    const out: UnattendedProblem[] = [];
    if (!isObject(action)) {
        return [{ code: 'triggers.action_unresolved', path: '', kind: '', message: `Action "${id}" does not exist in the app.`, hint: 'Create the action first, or point the trigger at an existing one.' }];
    }
    const refused = opts.refusedKinds ?? [];
    const seen = new Set<string>([id]);
    const visit = (list: unknown, base: string, depth: number, callDepth: number): void => {
        if (!Array.isArray(list) || depth > MAX_NESTING) return;
        list.forEach((step, i) => {
            if (!isObject(step) || out.length >= MAX_PROBLEMS) return;
            const path = `${base}[${i}]`;
            const kind = typeof step.kind === 'string' ? step.kind : '(no kind)';
            if (!runsUnattended(kind, refused)) {
                out.push({
                    code: 'triggers.step_not_unattended', path, kind,
                    message: `Action "${id}" is started by a trigger, but ${path} is a ${kind} step, which cannot run without a person at the page.`,
                    hint: UNATTENDED_HINT,
                });
            }
            if (kind === 'call_action' && typeof step.actionId === 'string' && callDepth < LIMITS.MAX_CALL_DEPTH && !seen.has(step.actionId)) {
                const callee = opts.resolveCalled ? opts.resolveCalled(step.actionId) : null;
                if (callee) {
                    seen.add(step.actionId);
                    visit(topSteps(callee), `${path}.call.steps`, 1, callDepth + 1);
                }
            }
            for (const slot of childStepSlots(step)) visit(slot.steps, `${path}${slot.suffix}`, depth + 1, callDepth);
        });
    };
    const steps = topSteps(action);
    if (!steps.length) {
        return [{ code: 'triggers.action_empty', path: 'steps', kind: '', message: `Action "${id}" has no steps, so a trigger has nothing to run.`, hint: 'Add the steps the trigger should run.' }];
    }
    visit(steps, 'steps', 1, 0);
    return out;
}
