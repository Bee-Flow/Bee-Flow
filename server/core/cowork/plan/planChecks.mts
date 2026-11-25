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
 *   AI        an AI step is offered tools by name only: never the whole catalogue (the tools switch on with no list
 *             to narrow it), never an agent's grants (an item that runs as an agent is the other engine). It uses no
 *             skills and no memory: a skill brings instructions and tools the plan does not show, and memory is text
 *             the plan did not fetch.
 *   OUTSIDE   outside text (./outsideText.mts) can inform, never instruct:
 *               - an AI step that reads it gets no tools at all, so it can only write its answer;
 *               - a step that goes to the open web takes nothing from it (an address or a query built from a mail is
 *                 a way to send that mail's content out);
 *               - it never picks who receives something (a recipient field of a step that changes or sends);
 *               - it never picks what is changed (a file, folder, table or document id of such a step).
 *             It MAY fill the text of a message, a cell, a digest, and it may decide which of the plan's own branches
 *             runs: both branches were approved with the plan.
 *   MAIL      a plan that starts on a new mail drafts; it never sends (decision 0044): every step that sends is refused,
 *             whoever it goes to. A question for the owner and the result for the owner are not sending.
 *   AS SHOWN  every step runs as the plan shows it: no step serves a saved output instead of running (`pinnedOutput`),
 *             and none is switched off (`disabled`: a switched-off check always lets the flow through).
 *   ASK       a step that waits for a decision asks the plan's owner. It names no other approver, panel, stage or
 *             escalation: what the plan shows a person is on its card as "only to you", and that has to be true.
 */

import { createRequire } from 'node:module';
import type { Definition, DefStep, Effect, PlanFinding, ToolLookups } from './planTypes.mts';
import { PLAN_TRIGGER_KINDS, isAnnotation, kindOfStepType, refusalOfStepType } from './coworkStepList.mts';
import { outsideTextOf, startsOnMail, type OutsideText } from './outsideText.mts';
import { stepsOf, inputsOf, aiToolsOf, refsOfStep, refsOfValue, type WalkedStep } from './planWalk.mts';

const nodeRequire = createRequire(import.meta.url);
const { stepEffect } = nodeRequire('../../automationModel/stepEffect.js') as { stepEffect: (step: DefStep) => Effect };
const { NOTEBOOK_TOOLS } = nodeRequire('../../integrations/notebookToolNames.js') as { NOTEBOOK_TOOLS: ReadonlySet<string> };
const { MAIL_APPS } = nodeRequire('../../agentRuntime/toolPolicy/mailAccess.js') as { MAIL_APPS: Record<string, { draft: string; reply: string }> };

/**
 * A mail draft never leaves the owner's mailbox: the owner reads it and sends it, or not. So the one person a draft
 * may be addressed to from outside text is the sender of the mail that started the run, named exactly as
 * `{{trigger.output.mail.from}}` in its `to` (decision 0044). Every other recipient field of a draft, any other
 * outside value, and every step that sends stay refused (decision 0031).
 */
const DRAFT_TOOLS: ReadonlySet<string> = new Set(Object.values(MAIL_APPS).map((a) => a.draft));
const START_SENDER = 'trigger.output.mail.from';

/** Is this the `to` of a mail draft that answers the sender of the mail that started the run, and nothing else? */
function answersStartSender(step: DefStep, key: string, value: unknown, effect: Effect): boolean {
    if (key !== 'to' || effect !== 'writes' || !DRAFT_TOOLS.has(String(step.tool ?? ''))) return false;
    const v = value as { kind?: unknown; path?: unknown; value?: unknown } | null;
    if (v?.kind !== 'ref' && v?.kind !== 'template') return false;
    const raw = (typeof v.path === 'string' ? v.path : typeof v.value === 'string' ? v.value : '').trim();
    const wrapped = raw.startsWith('{{') && raw.endsWith('}}');
    const bare = wrapped ? raw.slice(2, -2).trim() : raw;
    // A template is exactly the one reference; a ref may be written with or without its braces.
    return bare === START_SENDER && (v.kind === 'ref' || wrapped);
}

/** Input names that say WHO receives something. Compared without case, `_` and `-` (fieldKey). Trust per recipient (../planTrust.mts) reads the same list. */
export const DESTINATION_FIELDS: ReadonlySet<string> = new Set([
    'to', 'cc', 'bcc', 'recipient', 'recipients', 'email', 'emails', 'address', 'addresses', 'attendees',
    'userid', 'userids', 'user', 'users', 'channel', 'room', 'roomtoken', 'sharewith', 'signer', 'signers', 'phone',
    // A Talk conversation is named by its token; a reply goes to whoever wrote the message it answers.
    'token', 'conversationtoken', 'replytomessageid', 'inreplyto', 'replyto',
]);

/** Input names that say WHAT is changed. */
const TARGET_FIELDS: ReadonlySet<string> = new Set([
    'path', 'folder', 'folderid', 'file', 'fileid', 'filename', 'documentid', 'datatableid', 'tableid', 'sheetid',
    'spreadsheetid', 'calendarid', 'boardid', 'cardid', 'noteid', 'url', 'link',
]);

export const fieldKey = (name: string): string => name.toLowerCase().replaceAll('_', '').replaceAll('-', '');

const finding = (code: string, stepId: string | null, message: string): PlanFinding => ({ code, stepId, message });

/** A field that names something: a non-empty list, or any value that is not blank. */
const names = (value: unknown): boolean => (Array.isArray(value) ? value.length > 0 : value !== null && value !== undefined && value !== '');

/** Does this node carry a pinned output, which the runner serves instead of running it (core/automationRunner/stepDispatch.js)? */
const pinned = (node: Record<string, unknown> | null | undefined): boolean => node?.pinnedOutput !== undefined && node?.pinnedOutput !== null;

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
    if (pinned(definition.trigger)) {
        out.push(finding('trigger.pinned', null, 'The start of this plan carries a saved sample that a run would use as its start data. A plan starts from what really starts it.'));
    }
    const layers = definition.layers;
    if (layers && typeof layers === 'object' && Object.keys(layers).length > 0) {
        out.push(finding('plan.layers', null, 'A plan is one list of steps: sub-flows are for Studio automations.'));
    }
    return out;
}

/**
 * The step is offered every tool its owner has: the tools switch is on and no list narrows it. (With a list the
 * runner offers exactly the list, and an empty list offers nothing: core/automationRunner/aiStepTools.js.)
 */
const offersEveryTool = (step: DefStep): boolean => step.allowTools === true && !Array.isArray(step.tools);

function aiFindings(s: WalkedStep, outside: OutsideText): PlanFinding[] {
    const out: PlanFinding[] = [];
    const everyTool = offersEveryTool(s.step);
    if (everyTool) {
        out.push(finding('ai.open_tools', s.id, 'An AI step in a plan is offered tools by name, never every tool its owner has.'));
    }
    if (names(s.step.skillIds)) {
        out.push(finding('ai.skills', s.id, 'An AI step in a plan uses no skills yet: a skill brings instructions and tools that the plan does not show.'));
    }
    if (s.step.useMemory === true) {
        out.push(finding('ai.memory', s.id, 'An AI step in a plan does not use memory yet: it works from what the plan fetched.'));
    }
    if (typeof s.step.agentId === 'string' && s.step.agentId.trim()) {
        out.push(finding('ai.agent', s.id, 'An AI step in a plan does not run as an agent: an item that should, runs as that agent as a whole.'));
    }
    if (outside.reads.has(s.id) && (everyTool || aiToolsOf(s.step).length > 0)) {
        out.push(finding('ai.outside_text_with_tools', s.id, 'This AI step reads text written outside the workspace, so it may not be offered any tool: it can only write its answer.'));
    }
    return out;
}

/** The fields of an approval step that put someone other than the owner on the decision. */
const OTHER_APPROVER_FIELDS = ['assignee', 'approvers', 'finalApprover', 'escalateTo', 'stages'];

function askFindings(s: WalkedStep): PlanFinding[] {
    // The engine and the builder keep them under `approval` (core/automationRunner/execApproval.js); the top level is
    // read too, so neither shape slips through.
    const nested = s.step.approval && typeof s.step.approval === 'object' ? s.step.approval as Record<string, unknown> : {};
    if (!OTHER_APPROVER_FIELDS.some((field) => names(s.step[field]) || names(nested[field]))) return [];
    return [finding('ask.other_people', s.id, 'A step that waits for a decision asks the owner of the plan. This one names other people to decide.')];
}

/** The fields of a table step that pick which table and which rows a write changes (not the values it writes). */
const DATATABLE_TARGET_FIELDS = ['datatableId', 'where', 'rowId', 'rowIds', 'matchColumn'];

/** Outside text choosing which rows of the organisation's tables a write changes or deletes. */
function tableFindings(s: WalkedStep, effect: Effect, outside: OutsideText): PlanFinding[] {
    if (s.type !== 'datatable' || effect === 'reads') return [];
    const chosen = DATATABLE_TARGET_FIELDS.filter((field) => outside.refsReadIt(refsOfValue(s.step[field]), s));
    return chosen.length === 0 ? [] : [finding('write.target_from_outside', s.id, `"${chosen[0]}" picks which rows are changed, and it is filled from text written outside the workspace. Which rows a plan changes comes from the plan or from the owner's own data.`)];
}

/** Outside text in the fields of a step that say where it goes: a recipient, or the thing that is changed. */
function fieldFindings(s: WalkedStep, effect: Effect, outside: OutsideText): PlanFinding[] {
    if (effect === 'reads') return [];
    const out: PlanFinding[] = [];
    for (const [name, value] of Object.entries(inputsOf(s.step))) {
        const key = fieldKey(name);
        const isDestination = DESTINATION_FIELDS.has(key);
        if (!isDestination && !TARGET_FIELDS.has(key)) continue;
        if (isDestination && answersStartSender(s.step, key, value, effect)) continue;
        if (!outside.refsReadIt(refsOfValue(value), s)) continue;
        out.push(isDestination
            ? finding('send.destination_from_outside', s.id, `"${name}" says who receives this, and it is filled from text written outside the workspace. A recipient comes from the plan or from the owner's own data.`)
            : finding('write.target_from_outside', s.id, `"${name}" says what is changed, and it is filled from text written outside the workspace. A target comes from the plan or from the owner's own data.`));
    }
    return out;
}

/** A step that would not run as the plan shows it: it serves a saved output, or it is switched off (core/automationRunner/stepDispatch.js). */
function asShownFindings(s: WalkedStep): PlanFinding[] {
    const out: PlanFinding[] = [];
    if (pinned(s.step)) {
        out.push(finding('step.pinned', s.id, 'This step carries a saved output that would be used instead of running it. A plan runs every step for real.'));
    }
    if (s.step.disabled) {
        out.push(finding('step.disabled', s.id, 'This step is switched off, so it would not run as the plan shows it. A plan has no switched-off steps.'));
    }
    return out;
}

function stepFindings(s: WalkedStep, lookups: ToolLookups, outside: OutsideText, onMail: boolean): PlanFinding[] {
    if (isAnnotation(s.type)) return [];
    const kind = kindOfStepType(s.type);
    if (kind === null) return [finding('step.not_allowed', s.id, refusalOfStepType(s.type))];
    const out: PlanFinding[] = kind === 'ai' ? aiFindings(s, outside) : kind === 'ask' ? askFindings(s) : [];
    out.push(...asShownFindings(s));
    const tool = typeof s.step.tool === 'string' ? s.step.tool : '';
    if (NOTEBOOK_TOOLS.has(tool)) {
        out.push(finding('step.chat_notebook', s.id, 'This notebook action requires an open chat notebook. Deliver the result in Cowork with a notification step.'));
    }
    if (s.type === 'integration_action' && tool && lookups.isOpenWebRead(tool) && outside.refsReadIt(refsOfStep(s.step), s)) {
        out.push(finding('web.input_from_outside', s.id, 'This step goes to the open web with an address or a query built from text written outside the workspace. That would carry the text out.'));
    }
    const effect = stepEffect(s.step);
    // A question and a result for the owner "send" only to the owner (the bell, their own mail): those stay.
    if (onMail && effect === 'sends' && kind !== 'ask' && kind !== 'deliver') {
        out.push(finding('mail.sends', s.id, 'This plan starts on a new mail, and this step sends. A plan a mail starts saves a draft for its owner to send; it never sends itself.'));
    }
    return out.concat(fieldFindings(s, effect, outside), tableFindings(s, effect, outside));
}

/** Why this definition is not a plan Cowork runs; an empty list when it is one. */
export function checkPlan(definition: Definition | null | undefined, lookups: ToolLookups): PlanFinding[] {
    const steps = stepsOf(definition);
    const shape = shapeFindings(definition, steps);
    if (shape.some((f) => f.code === 'plan.shape')) return shape;
    const outside = outsideTextOf(definition, lookups);
    const onMail = startsOnMail(definition);
    return shape.concat(steps.flatMap((s) => stepFindings(s, lookups, outside, onMail)));
}
