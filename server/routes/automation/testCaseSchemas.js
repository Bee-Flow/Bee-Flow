// @typecheck
/**
 * Request bodies of routes/automation/testCases.js. Every object is closed
 * (.strict()); the messages are written for the person who sent the value.
 *
 * The assertion LIST is checked by automation/testing/assertions.js
 * (validateAssertions) so the route and the unit speak the same rules; its
 * problems come back as one pathed issue each.
 */

'use strict';

const { z, typeError } = require('../../utils/zod');
const { validateAssertions, OPS } = require('../../automation/testing/assertions');
const { envCap } = require('../../automation/mcpRunReadCaps');

const MAX_CODE = 200 * 1024;
const MAX_CASES_PER_RUN = 50;

const NAME_TEXT = 'name is the name of the test case (1 to 80 characters).';
const STEP_TEXT = 'stepId is the id of a code step in this automation.';
const OPS_TEXT = `op must be one of ${OPS.join(', ')}.`;

const Assertion = z.object({
    id: z.string({ error: typeError({ required: 'An assertion needs an id.', invalid: 'id is text.' }) }).min(1, 'An assertion needs an id.').max(40, 'id is at most 40 characters.'),
    op: z.enum(OPS, { error: () => OPS_TEXT }),
    path: z.string({ error: typeError({ invalid: 'path is text.' }) }).max(500, 'path is at most 500 characters.').optional(),
    value: z.unknown().optional(),
}, { error: typeError({ required: 'Send an assertion.', invalid: 'An assertion is an object.' }) }).strict();

/** A list of assertions; the vocabulary's own rules run on the whole list. */
const Assertions = z.array(Assertion, { error: typeError({ invalid: 'assertions is a list.' }) }).superRefine((list, ctx) => {
    const { errors } = validateAssertions(list);
    for (const e of errors) {
        ctx.addIssue({ code: 'custom', path: e.index >= 0 ? [e.index] : [], message: e.index >= 0 ? `Assertion ${e.index + 1}: ${e.message}.` : `Assertions: ${e.message}.` });
    }
});

/** Typed values for a case: an object no larger than the fixture cap. */
const TypedValues = z.record(z.string(), z.unknown(), { error: typeError({ required: 'Send the values.', invalid: 'values is an object.' }) })
    .refine((v) => {
        const cap = envCap('AUTOMATION_TEST_FIXTURE_MAX_BYTES', 1024 * 1024);
        return cap === 0 || Buffer.byteLength(JSON.stringify(v), 'utf8') <= cap;
    }, 'These values are too large to keep as test data.');

const TypedInput = z.object({ kind: z.literal('typed'), values: TypedValues }).strict();
const RunInput = z.object({
    kind: z.literal('run'),
    runId: z.string({ error: typeError({ required: 'Name the run to take the input from.', invalid: 'runId is text.' }) }).min(1).max(200),
    attempts: z.number().int().min(1).max(100000).optional(),
}).strict();
const Input = z.discriminatedUnion('kind', [TypedInput, RunInput], { error: () => 'input.kind is "typed" or "run".' });

const Name = z.string({ error: typeError({ required: NAME_TEXT, invalid: NAME_TEXT }) }).trim().min(1, NAME_TEXT).max(80, NAME_TEXT);
const Expect = z.enum(['success', 'error'], { error: () => 'expect is "success" or "error".' });

const CreateBody = z.object({
    stepId: z.string({ error: typeError({ required: STEP_TEXT, invalid: STEP_TEXT }) }).min(1, STEP_TEXT).max(200, STEP_TEXT),
    name: Name,
    expect: Expect.optional(),
    assertions: Assertions.optional(),
    input: Input,
}).strict();

const UpdateBody = z.object({
    name: Name.optional(),
    expect: Expect.optional(),
    assertions: Assertions.optional(),
    input: Input.optional(),
}).strict();

const RunBody = z.object({
    stepId: z.string({ error: typeError({ required: STEP_TEXT, invalid: STEP_TEXT }) }).min(1, STEP_TEXT).max(200, STEP_TEXT),
    caseIds: z.array(z.string().min(1).max(100), { error: typeError({ invalid: 'caseIds is a list.' }) })
        .max(MAX_CASES_PER_RUN, `caseIds holds at most ${MAX_CASES_PER_RUN} cases.`).optional(),
    code: z.string({ error: typeError({ invalid: 'code is text.' }) }).max(MAX_CODE, 'The code is larger than 200 KB.').optional(),
}).strict();

const ListQuery = z.object({
    stepId: z.string().min(1).max(200).optional(),
}).strict();

module.exports = { CreateBody, UpdateBody, RunBody, ListQuery, Assertion, Assertions, MAX_CODE, MAX_CASES_PER_RUN };
