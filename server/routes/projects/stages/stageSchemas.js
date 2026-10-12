'use strict';
/**
 * What the stage routes accept (routes/projects/stages/*, routes/solutionStages.js).
 *
 * Every body and query is closed: a misspelled key is a 400 naming it. The
 * values that are documents of their own (an approval policy, a binding value)
 * are checked by the engine that owns them (approvalGate.validatePolicy,
 * applyBindings.validateBinding); here they are only bounded in size.
 */

const { z, worded, bodyOf, queryOf, closedObject, choice, flag, wholeNumber } = require('../../../core/http/schemaParts');

const ID_MAX = 200;
const KEY_MAX = 128;
const NOTE_MAX = 4000;
const MAX_JSON_BYTES = 32 * 1024;

const anId = (message) => worded(message).trim().min(1, message).max(ID_MAX, message);
const requestKey = worded('requestKey is a short text that stays the same when the request is repeated.')
    .trim().min(1, 'requestKey is a short text that stays the same when the request is repeated.').max(KEY_MAX, `requestKey is at most ${KEY_MAX} characters.`);

const STAGES = ['uat', 'prd'];
const stageName = choice(STAGES, 'A stage is uat or prd.');
const DEPLOY_KINDS = ['deploy', 'rollback', 'redeploy'];

/** A JSON document of bounded size: the engine that owns it checks what is inside. */
const boundedJson = (message) => z.unknown().refine((v) => {
    try { return JSON.stringify(v).length <= MAX_JSON_BYTES; } catch { return false; }
}, message);
const jsonObject = (message) => z.record(z.unknown(), { invalid_type_error: message }).refine((v) => {
    try { return JSON.stringify(v).length <= MAX_JSON_BYTES; } catch { return false; }
}, message);

// ── Stages ────────────────────────────────────────────────────────────────────

const CreateStagesBody = bodyOf({
    stages: z.array(stageName, { required_error: 'stages lists the stages to create: uat, prd.', invalid_type_error: 'stages lists the stages to create: uat, prd.' })
        .min(1, 'Create at least one stage.').max(2, 'There are two stages: uat and prd.')
        .refine((l) => new Set(l).size === l.length, 'Name each stage once.'),
    requestKey: requestKey.optional(),
}, 'Creating stages');

const DeleteStageBody = bodyOf({
    confirm: worded('Type the name of the stage to confirm.').trim().min(1, 'Type the name of the stage to confirm.').max(300, 'confirm is the name of the stage.'),
    mode: choice(['detach', 'delete'], 'mode is detach or delete.'),
    deleteData: flag('deleteData is true or false.').optional(),
    requestKey: requestKey.optional(),
}, 'Removing a stage');

const GATE_FIELDS = ['requiresApproval', 'approvalPolicy', 'rollbackNeedsApproval'];

const PatchStageBody = bodyOf({
    settingsVersion: wholeNumber('settingsVersion is the whole number the settings were loaded with.', { min: 1 }),
    enabled: flag('enabled is true or false.').optional(),
    newPartsActive: flag('newPartsActive is true or false.').optional(),
    requiresApproval: flag('requiresApproval is true or false.').optional(),
    approvalPolicy: jsonObject('approvalPolicy is the approval chain, a JSON object.').nullable().optional(),
    rollbackNeedsApproval: flag('rollbackNeedsApproval is true or false.').optional(),
}, 'Changing the stage settings').refine(
    (b) => Object.keys(b).some((k) => k !== 'settingsVersion'),
    'Say what to change.',
);

/** The same body on the drain router: settings are not changed there. */
const EmptyBody = bodyOf({}, 'This request');

// ── Bindings and variables ────────────────────────────────────────────────────

const PutBindingsBody = bodyOf({
    settingsVersion: wholeNumber('settingsVersion is the whole number the settings were loaded with.', { min: 1 }),
    bindings: z.array(closedObject({
        slot: anId('A binding needs a slot.'),
        value: boundedJson('A binding value is a small JSON document.').nullable(),
    }, 'A binding'), { required_error: 'bindings is a list of { slot, value }.', invalid_type_error: 'bindings is a list of { slot, value }.' })
        .min(1, 'Give at least one binding.').max(200, 'At most 200 bindings per request.'),
}, 'Writing bindings');

const RequirementsQuery = queryOf({ releaseId: anId('releaseId is the id of a release.').optional() }, 'The requirements');

const VARIABLE_TYPES = ['text', 'number', 'boolean', 'url', 'email', 'choice'];
const variableDecl = closedObject({
    name: worded('A variable needs a name.').trim().min(1, 'A variable needs a name.').max(63, 'A variable name has at most 63 characters.'),
    type: choice(VARIABLE_TYPES, 'type is text, number, boolean, url, email or choice.').optional(),
    choices: z.array(worded('A choice is text.').trim().min(1, 'A choice cannot be empty.').max(200, 'A choice has at most 200 characters.')).max(100, 'At most 100 choices.').nullable().optional(),
    description: worded('description is text.').max(500, 'description has at most 500 characters.').optional(),
    required: flag('required is true or false.').optional(),
    steering: flag('steering is true or false.').optional(),
}, 'A variable');

const PutVariablesBody = bodyOf({
    variables: z.array(variableDecl, { required_error: 'variables is a list.', invalid_type_error: 'variables is a list.' })
        .max(100, 'A Solution has at most 100 variables.'),
}, 'Declaring variables');

const valueScalar = z.union([
    z.string().max(2000, 'A variable value has at most 2000 characters.'), z.number().finite(), z.boolean(), z.null(),
], { errorMap: () => ({ message: 'A variable value is text, a number, true/false, or null to clear it.' }) });

const PutValuesBody = bodyOf({
    values: z.record(valueScalar, { required_error: 'values is { name: value }.', invalid_type_error: 'values is { name: value }.' })
        .refine((v) => Object.keys(v).length >= 1, 'Give at least one value.')
        .refine((v) => Object.keys(v).length <= 100, 'At most 100 values per request.'),
}, 'Entering variable values');

// ── Parts ─────────────────────────────────────────────────────────────────────

const PatchPartBody = bodyOf({
    active: flag('active is true or false.').optional(),
    audience: closedObject({
        published: flag('published is true or false.'),
        sharedGroups: z.array(anId('A group is an id.')).max(200, 'At most 200 groups.').optional(),
    }, 'The audience').optional(),
}, 'Changing a part').refine((b) => b.active !== undefined || b.audience !== undefined, 'Say what to change: active or audience.');

/** The drain router changes the on/off switch and nothing else. */
const PatchPartActiveBody = bodyOf({ active: flag('active is true or false.') }, 'Switching a part');

const PartOptionsBody = bodyOf({
    reference: flag('reference is true or false.').optional(),
    contentMode: choice(['shell', 'carry'], 'contentMode is shell or carry.').optional(),
    acks: z.array(z.union([
        anId('An acknowledgement names a document.'),
        closedObject({ docRef: anId('An acknowledgement names a document.'), contentHash: anId('contentHash is a hash.').optional() }, 'An acknowledgement'),
    ])).max(1000, 'At most 1000 acknowledgements.').optional(),
}, 'Setting part options').refine((b) => Object.keys(b).length > 0, 'Say what to set: reference, contentMode or acks.');

// ── Releases and deployments ──────────────────────────────────────────────────

const CutReleaseBody = bodyOf({
    requestKey: requestKey.optional(),
    notes: worded('notes is text.').max(NOTE_MAX, `notes has at most ${NOTE_MAX} characters.`).optional(),
}, 'Cutting a release');

const acknowledgement = closedObject({
    code: anId('An acknowledgement needs a code.'),
    ref: anId('ref is a part ref.').nullable().optional(),
    docRef: anId('docRef is a document ref.').nullable().optional(),
}, 'An acknowledgement');
const acknowledgements = z.array(acknowledgement, { invalid_type_error: 'acknowledgements is a list of { code, ref?, docRef? }.' })
    .max(300, 'At most 300 acknowledgements.');

const PlanBody = bodyOf({
    releaseId: anId('releaseId is the id of a release.').nullable().optional(),
    kind: choice(DEPLOY_KINDS, 'kind is deploy, rollback or redeploy.').optional(),
}, 'Planning a deployment');

const DeployBody = bodyOf({
    releaseId: anId('releaseId is the id of a release.').nullable().optional(),
    kind: choice(DEPLOY_KINDS, 'kind is deploy, rollback or redeploy.').default('deploy'),
    planHash: worded('planHash is the hash of the plan that was reviewed.').trim().min(1, 'planHash is the hash of the plan that was reviewed.').max(200, 'planHash is the hash of the plan.'),
    requestKey,
    acknowledgements: acknowledgements.default([]),
    note: worded('note is text.').max(500, 'note has at most 500 characters.').optional(),
}, 'Deploying a release');

const ReleaseAndDeployBody = bodyOf({
    requestKey,
    notes: worded('notes is text.').max(NOTE_MAX, `notes has at most ${NOTE_MAX} characters.`).optional(),
    acknowledgements: acknowledgements.default([]),
}, 'Cutting a release and deploying it');

const DeploymentsQuery = queryOf({
    stage: stageName.optional(),
    cursor: worded('cursor is the nextCursor of the previous page.').max(600, 'cursor is the nextCursor of the previous page.').optional(),
    limit: wholeNumber('limit is a whole number from 1 to 100.', { min: 1, max: 100 }).optional(),
}, 'The deployment list');

const DetachBody = bodyOf({
    confirm: worded('Type the name of the stage to confirm.').trim().min(1, 'Type the name of the stage to confirm.').max(300, 'confirm is the name of the stage.'),
}, 'Detaching a stage');

module.exports = {
    STAGES, DEPLOY_KINDS, GATE_FIELDS, VARIABLE_TYPES,
    CreateStagesBody, DeleteStageBody, PatchStageBody, EmptyBody,
    PutBindingsBody, RequirementsQuery, PutVariablesBody, PutValuesBody,
    PatchPartBody, PatchPartActiveBody, PartOptionsBody,
    CutReleaseBody, PlanBody, DeployBody, ReleaseAndDeployBody, DeploymentsQuery, DetachBody,
};
