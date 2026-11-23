/**
 * Is this definition a plan Cowork may run? The rules, as one pure function.
 *
 * The same function answers when a plan is made, when it is turned on and before every run, so the three cannot
 * disagree (the shape of decision 0023 for App Studio triggers). It returns FINDINGS, each a sentence a person can
 * read; an empty list is a plan.
 *
 * The rules:
 *
 *   SHAPE     a plan is one list of steps: a trigger from the short list, no sub-flows, at least one step.
 *   STEPS     every step type is on Cowork's list (./coworkStepList.mts).
 *   AI        an AI step is offered tools by name only: never the whole catalogue (`allowTools`), never an agent's
 *             grants (an item that runs as an agent is the other engine).
 *   OUTSIDE   outside text (./outsideText.mts) can inform, never instruct:
 *               - an AI step that reads it gets no tools at all, so it can only write its answer;
 *               - a step that goes to the open web takes nothing from it (an address or a query built from a mail is
 *                 a way to send that mail's content out);
 *               - it never picks who receives something (a recipient field of a step that changes or sends);
 *               - it never picks what is changed (a file, folder, table or document id of such a step).
 *             It MAY fill the text of a message, a cell, a digest, and it may decide which of the plan's own branches
 *             runs: both branches were approved with the plan.
 *   ASK       a step that waits for a decision asks the plan's owner. It names no other approver, panel, stage or
 *             escalation: what the plan shows a person is on its card as "only to you", and that has to be true.
 */

import { createRequire } from 'node:module';
import type { Definition, DefStep, Effect, PlanFinding, ToolLookups } from './planTypes.mts';
import { PLAN_TRIGGER_KINDS, isAnnotation, kindOfStepType, refusalOfStepType } from './coworkStepList.mts';
import { outsideTextOf, type OutsideText } from './outsideText.mts';
import { stepsOf, inputsOf, aiToolsOf, refsOfStep, refsOfValue, type WalkedStep } from './planWalk.mts';

const nodeRequire = createRequire(import.meta.url);
const { stepEffect } = nodeRequire('../../automationModel/stepEffect.js') as { stepEffect: (step: DefStep) => Effect };

/** Input names that say WHO receives something. Compared without case, `_` and `-`. */
const DESTINATION_FIELDS: ReadonlySet<string> = new Set([
    'to', 'cc', 'bcc', 'recipient', 'recipients', 'email', 'emails', 'address', 'addresses', 'attendees',
    'userid', 'userids', 'user', 'users', 'channel', 'room', 'roomtoken', 'sharewith', 'signer', 'signers', 'phone',
]);

/** Input names that say WHAT is changed. */
const TARGET_FIELDS: ReadonlySet<string> = new Set([
    'path', 'folder', 'folderid', 'file', 'fileid', 'filename', 'documentid', 'datatableid', 'tableid', 'sheetid',
    'spreadsheetid', 'calendarid', 'boardid', 'cardid', 'noteid', 'url', 'link',
]);

const fieldKey = (name: string): string => name.toLowerCase().replaceAll('_', '').replaceAll('-', '');

const finding = (code: string, stepId: string | null, message: string): PlanFinding => ({ code, stepId, message });

function shapeFindings(definition: Definition | null | undefined, steps: WalkedStep[]): PlanFinding[] {
    const out: PlanFinding[] = [];
    if (!definition || typeof definition !== 'object' || !Array.isArray(definition.steps)) {
        return [finding('plan.shape', null, 'A plan is a trigger and a list of steps.')];
    }
    if (steps.every((s) => isAnnotation(s.type))) out.push(finding('plan.empty', null, 'A plan has at least one step.'));
    const kind = definition.trigger?.kind;
    if (typeof kind !== 'string' || !PLAN_TRIGGER_KINDS.includes(kind)) {
        out.push(finding('trigger.not_allowed', null, `A plan starts on a schedule, when its owner runs it, or on an event of a connected app; not on "${typeof kind === 'string' && kind ? kind : 'nothing'}".`));
    }
    const layers = definition.layers;
    if (layers && typeof layers === 'object' && Object.keys(layers).length > 0) {
        out.push(finding('plan.layers', null, 'A plan is one list of steps: sub-flows are for Studio automations.'));
    }
    return out;
}

function aiFindings(s: WalkedStep, outside: OutsideText): PlanFinding[] {
    const out: PlanFinding[] = [];
    if (s.step.allowTools === true) {
        out.push(finding('ai.open_tools', s.id, 'An AI step in a plan is offered tools by name, never every tool its owner has.'));
    }
    if (typeof s.step.agentId === 'string' && s.step.agentId.trim()) {
        out.push(finding('ai.agent', s.id, 'An AI step in a plan does not run as an agent: an item that should, runs as that agent as a whole.'));
    }
    if (outside.reads.has(s.id) && (aiToolsOf(s.step).length > 0 || s.step.allowTools === true)) {
        out.push(finding('ai.outside_text_with_tools', s.id, 'This AI step reads text written outside the workspace, so it may not be offered any tool: it can only write its answer.'));
    }
    return out;
}

/** The fields of an approval step that put someone other than the owner on the decision. */
const OTHER_APPROVER_FIELDS = ['assignee', 'approvers', 'finalApprover', 'escalateTo', 'stages'];

const names = (value: unknown): boolean => (Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== '');

function askFindings(s: WalkedStep): PlanFinding[] {
    if (!OTHER_APPROVER_FIELDS.some((field) => names(s.step[field]))) return [];
    return [finding('ask.other_people', s.id, 'A step that waits for a decision asks the owner of the plan. This one names other people to decide.')];
}

/** Outside text in the fields of a step that say where it goes: a recipient, or the thing that is changed. */
function fieldFindings(s: WalkedStep, effect: Effect, outside: OutsideText): PlanFinding[] {
    if (effect === 'reads') return [];
    const out: PlanFinding[] = [];
    for (const [name, value] of Object.entries(inputsOf(s.step))) {
        const key = fieldKey(name);
        const isDestination = DESTINATION_FIELDS.has(key);
        if (!isDestination && !TARGET_FIELDS.has(key)) continue;
        if (!outside.refsReadIt(refsOfValue(value), s)) continue;
        out.push(isDestination
            ? finding('send.destination_from_outside', s.id, `"${name}" says who receives this, and it is filled from text written outside the workspace. A recipient comes from the plan or from the owner's own data.`)
            : finding('write.target_from_outside', s.id, `"${name}" says what is changed, and it is filled from text written outside the workspace. A target comes from the plan or from the owner's own data.`));
    }
    return out;
}

function stepFindings(s: WalkedStep, lookups: ToolLookups, outside: OutsideText): PlanFinding[] {
    if (isAnnotation(s.type)) return [];
    const kind = kindOfStepType(s.type);
    if (kind === null) return [finding('step.not_allowed', s.id, refusalOfStepType(s.type))];
    const out: PlanFinding[] = kind === 'ai' ? aiFindings(s, outside) : kind === 'ask' ? askFindings(s) : [];
    const tool = typeof s.step.tool === 'string' ? s.step.tool : '';
    if (s.type === 'integration_action' && tool && lookups.isOpenWebRead(tool) && outside.refsReadIt(refsOfStep(s.step), s)) {
        out.push(finding('web.input_from_outside', s.id, 'This step goes to the open web with an address or a query built from text written outside the workspace. That would carry the text out.'));
    }
    return out.concat(fieldFindings(s, stepEffect(s.step), outside));
}

/** Why this definition is not a plan Cowork runs; an empty list when it is one. */
export function checkPlan(definition: Definition | null | undefined, lookups: ToolLookups): PlanFinding[] {
    const steps = stepsOf(definition);
    const shape = shapeFindings(definition, steps);
    if (shape.some((f) => f.code === 'plan.shape')) return shape;
    const outside = outsideTextOf(definition, lookups);
    return shape.concat(steps.flatMap((s) => stepFindings(s, lookups, outside)));
}
