/**
 * What the routes of routes/skills.js accept: every body and query is
 * `.strict()` (the reasons are in that file's header). Moved out of
 * routes/skills.js verbatim, next to the `agentOnly`, `category` and copy
 * bodies of the Skill store (2026-11).
 */

import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const { z, typeError } = nodeRequire('../../utils/zod.js') as typeof import('../../utils/zod.js');
const { worded, orEmpty } = nodeRequire('../../core/http/schemaParts.js') as typeof import('../../core/http/schemaParts.js');
const { CATEGORY_MAX } = nodeRequire('../../stores/skill/rows.js') as typeof import('../../stores/skill/rows.js');

export const NoQuery = orEmpty(z.object({}).strict());

const NAME_TEXT = 'A skill needs a name.';
const GROUP_TEXT = 'Each shared group is the id of a group.';
const INTEGRATION_TEXT = 'Each enabled integration is the id of an app.';
const skillName = worded(NAME_TEXT).trim().min(1, NAME_TEXT);

/** The writable fields of a skill, shared by POST / and PUT /:id. All optional here. */
const SKILL_FIELDS = {
    description: worded('A description must be text.'),
    // Checked untrimmed, as it always was: the editor caps at exactly 4000
    // (SkillDetail's INSTRUCTION_LIMIT), and the two limits must be one limit.
    instructions: worded('Instructions must be text.').max(4000, 'Instructions too long (max 4000 characters)'),
    workflow: worded('The workflow must be text.'),
    rules: worded('The rules must be text.'),
    examples: worded('The examples must be text.'),
    icon: worded('An icon must be text.'),
    isShared: z.boolean({ error: typeError({ invalid: 'isShared is true or false.' }) }),
    dynamicActivation: z.boolean({ error: typeError({ invalid: 'dynamicActivation is true or false.' }) }),
    // "Only through agents": ignored as a session skill in a direct chat (core/skills/agentOnlySkills.mts).
    agentOnly: z.boolean({ error: typeError({ invalid: 'agentOnly is true or false.' }) }),
    // Free text, no fixed list; blank or null is no category (stores/skill/rows.js cleanCategory).
    category: worded('A category is text.').max(CATEGORY_MAX, `A category is at most ${CATEGORY_MAX} characters.`).nullable(),
    // `[]` is "the whole organisation" (with isShared); a blank entry is
    // refused rather than dropped, because dropping the only one is `[]` too.
    // null leaves the groups as they are.
    sharedGroups: z.array(worded(GROUP_TEXT).trim().min(1, GROUP_TEXT),
        { error: typeError({ invalid: 'sharedGroups is a list of group ids.' }) }).nullable(),
    automationId: worded('automationId is the id of an automation, or null for none.').nullable(),
    // Not narrowed to KNOWN apps: a stored skill may carry one that has since
    // left the registry, and the autosave resends the whole list every time.
    // The sanitiser drops those, as before; the schema refuses the wrong shape.
    enabledIntegrations: z.array(worded(INTEGRATION_TEXT),
        { error: typeError({ invalid: 'enabledIntegrations is a list of app ids.' }) }).nullable(),
    steps: z.unknown().optional(),
    rulesV2: z.unknown().optional(),
    examplesV2: z.unknown().optional(),
    outputSchema: z.unknown().optional(),
    knowledgeBaseIds: z.unknown().optional(),
    allowedAutomationIds: z.unknown().optional(),
};
const optionalFields = Object.fromEntries(Object.entries(SKILL_FIELDS).map(([k, s]) => [k, s.optional()]));

export const CreateSkillBody = orEmpty(z.object({ name: skillName, ...optionalFields }).strict());
export const UpdateSkillBody = orEmpty(z.object({ name: skillName.optional(), ...optionalFields }).strict());

export const CopyBody = orEmpty(z.object({
    name: worded('The name of the copy must be text.').optional(),
}).strict());

const CONFIRM_TEXT = 'confirmBreaking is true once the list of what breaks has been seen.';
export const DeleteBody = orEmpty(z.object({
    confirmBreaking: z.boolean({ error: typeError({ invalid: CONFIRM_TEXT }) }).optional(),
}).strict());
export const DeleteQuery = orEmpty(z.object({
    confirmBreaking: z.enum(['true', 'false'], { error: () => CONFIRM_TEXT }).optional(),
}).strict());

// The bodies of the handlers in ./skills/*.js. Types and keys only: a blank
// sentence or question is the handler's refusal, with its own code.
export const DraftBody = orEmpty(z.object({
    sentence: worded('The sentence must be text.').optional(),
}).strict());
export const ImproveBody = orEmpty(z.object({
    note: worded('The note must be text.').optional(),
}).strict());
export const TestBody = orEmpty(z.object({
    agentId: worded('agentId is the id of an agent, or null to test without one.').nullable().optional(),
    question: worded('The question must be text.').optional(),
}).strict());
const MESSAGE_TEXT = 'messageIndex is the position of the message in the conversation, from 0.';
const CONVERSATION_TEXT = 'conversationId is the id of one of your conversations.';
export const FromMessageBody = orEmpty(z.object({
    conversationId: worded(CONVERSATION_TEXT).trim().min(1, CONVERSATION_TEXT),
    messageIndex: z.number({ error: MESSAGE_TEXT }).int(MESSAGE_TEXT).min(0, MESSAGE_TEXT),
    question: worded('The question must be text.').optional(),
}).strict());
