// @typecheck
/**
 * Agent CRUD: what a caller may send to the category, transfer and tool-param
 * routes and to the agent save (PUT /:id). Split out of crud.js; behaviour
 * unchanged. The create body (POST /) is deliberately not stated here: see
 * the note above POST / in crud.js.
 */

const { z, typeError } = require('../../utils/zod');
const { worded } = require('../../core/http/schemaParts');

const CATEGORY_NAME = 'A category needs a name.';
const CategoryBody = z.object({
    name: worded(CATEGORY_NAME).trim().min(1, CATEGORY_NAME).max(100, 'A category name is at most 100 characters.'),
    icon: worded('A category icon must be text.').trim().max(16, 'A category icon is at most 16 characters.').optional(),
    color: worded('A category colour must be text.').trim().max(32, 'A category colour is at most 32 characters.').nullish(),
}).strict();

/** Every field optional: a rename must not have to resend icon and colour. */
const CategoryPatch = CategoryBody.partial();

const REASSIGN = 'reassignTo is the id of another category, or "none" to uncategorise.';
const DeleteCategoryQuery = z.object({
    reassignTo: worded(REASSIGN).trim().min(1, REASSIGN).optional(),
}).strict();

const NEW_OWNER = 'A transfer needs the id of the new owner.';
const TransferBody = z.object({
    newOwnerId: worded(NEW_OWNER).trim().min(1, NEW_OWNER),
}).strict();

const ToolParamsBody = z.object({
    // A component declares its own params — endpoints, keys, whatever it
    // takes — so only the envelope around them is stated here.
    params: z.record(z.string(), z.unknown(), { error: typeError({ invalid: 'params is an object of the tool\'s own settings.' }) }).nullish(),
}).strict();

/**
 * An on/off setting as a client sends it: true or false, or the 1 and 0 that
 * AgentDesignerPanel and the AgentDesigner hook send for `workspaceEnabled`.
 * Anything else is refused: the store writes `!!value`, and `!!'false'` is on.
 */
const setting = (name) => {
    const message = `${name} is true or false.`;
    return z.preprocess(
        (v) => (v === 1 ? true : v === 0 ? false : v),
        z.boolean({ error: message }),
    ).optional();
};

/**
 * An object handed on AS SENT. `z.record` would rebuild it, and zod drops a
 * `__proto__` key while rebuilding — so rejectUnsafeConfigKeys would never see
 * the key it exists to refuse, and a polluting body would save under a 200
 * instead of being turned away by name.
 */
const asSent = (message) => z.custom(
    (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    { message },
);

/**
 * PUT /:id — every key a real client sends, and nothing else.
 *
 * Taken from the four callers there are: the agent editor's autosave
 * (AgentWizard/state/agentSaveApi.js), the legacy AgentDesignerPanel and
 * AgentDesigner hook, and KnowledgeStudio's "accept suggestion", which sends
 * `{ config }` alone. crud.validation.test.js sends each of their bodies.
 *
 * Every key is optional, and a key left out means "leave it as stored" all the
 * way down to the SET list — the handler falls back to the row for each one.
 * `config` and `persona` stay open one level down: an allow-list of config keys
 * is not maintainable (see rejectUnsafeConfigKeys), and `normalisePersona`
 * owns the persona's shape.
 *
 * TWO KEYS ARE ACCEPTED AND NOT READ: `organizationId` and `sharedGroups`. The
 * legacy panel sends both on every save; the org is set on creation and the
 * audience belongs to PATCH /:id/publish, so arriving here they change nothing.
 */
const AGENT_BODY = "An agent save is an object of the agent's settings.";
const AgentUpdateBody = z.preprocess(
    (v) => (v === undefined || v === null ? {} : v),
    z.object({
        // `name || agent.name` in the handler: empty or null keeps the name.
        name: worded('name is text.').nullish(),
        description: worded('description is text.').nullish(),
        systemPrompt: worded('systemPrompt is text.').nullish(),
        model: worded('model is the name of a model or a tier.').nullish(),
        avatar: worded('avatar is text: an emoji or the address of an image.').nullish(),
        categoryId: worded('categoryId is the id of a category, or null for none.').nullish(),
        starterPrompts: z.array(worded('starterPrompts is a list of prompts.'), { error: typeError({ invalid: 'starterPrompts is a list of prompts.' }) }).optional(),
        tools: z.array(worded('tools is a list of component ids.'), { error: typeError({ invalid: 'tools is a list of component ids.' }) }).nullish(),
        toolParams: asSent("toolParams is an object of each tool's own settings.").nullish(),
        config: asSent("config is an object of the agent's settings.").optional(),
        persona: asSent('persona is an object, or null to clear it.').nullish(),
        threadsEnabled: setting('threadsEnabled'),
        copyEnabled: setting('copyEnabled'),
        workspaceEnabled: setting('workspaceEnabled'),
        embedEnabled: setting('embedEnabled'),
        baseVersion: z.number({ error: typeError({ invalid: 'baseVersion is the rev the editor loaded, a whole number.' }) })
            .int('baseVersion is the rev the editor loaded, a whole number.').nullish(),
        organizationId: z.unknown().optional(),
        sharedGroups: z.unknown().optional(),
    }, {
        error: (iss) => {
            if (iss.code === 'unrecognized_keys') {
                const names = iss.keys.map((k) => `'${k}'`).join(', ');
                return `An agent has no ${iss.keys.length === 1 ? 'setting' : 'settings'} called ${names}.`;
            }
            if (iss.code === 'invalid_type') return AGENT_BODY;
            return undefined;
        },
    }).strict(),
);

module.exports = { CategoryBody, CategoryPatch, DeleteCategoryQuery, TransferBody, ToolParamsBody, AgentUpdateBody };
