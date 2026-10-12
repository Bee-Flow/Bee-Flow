/**
 * Agent-call trigger contract helpers.
 *
 * An `agent_call` automation is a tool an agent can call (agentCallableTools.js).
 * Its declaration lives on the trigger: `toolName`, `description` and
 * `parametersSchema` (a JSON Schema object whose properties arrive in the run as
 * `trigger.output.<name>`). This module is the single home for that contract,
 * the same way appTriggerContract.js is for app triggers:
 *
 *   - sanitizeToolName      the name the agent sees (used by the runtime too);
 *   - normalizeParameters   JSON Schema OR a params list -> the one schema shape
 *                           the canvas editor reads and writes (the server twin
 *                           of agent-hub flow/triggerSchemaUtils.js);
 *   - validateAgentCallTrigger  the rules the save-time validator applies.
 *
 * Why a normaliser at all: the editor reads only `type` and `description` per
 * property (schemaToParams) and rebuilds the whole schema on its next save, and
 * the runtime throws away anything that is not `type: 'object'`
 * (agentCallableTools.normalizeParameters). A schema the builder wrote in some
 * other dialect (shorthand map, `integer`, no `type`) was therefore either
 * invisible to the agent or flattened behind the author's back.
 *
 * Intentionally dependency-light (like appTriggerContract.js): pure functions,
 * no I/O, safe to require from the validator, the builder and the runtime.
 */

'use strict';

const { PARAM_NAME_RE, MAX_PARAMS } = require('./appTriggerContract');

// The types the canvas editor offers for an agent argument
// (flow/settings/triggerEditors.jsx). JSON Schema's `integer` is folded into
// `number`: the editor's select has no such option and would show it blank.
const PARAM_TYPES = Object.freeze(['string', 'number', 'boolean', 'object', 'array']);
const MAX_DESCRIPTION_LEN = 500;
const MAX_TOOL_DESCRIPTION_LEN = 1000;
const MAX_ENUM_VALUES = 50;

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The tool name an agent sees: [a-z0-9_], at most 64 characters. */
function sanitizeToolName(name) {
    return String(name || '')
        .toLowerCase()
        .replace(/[^a-z0-9_]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 64) || 'automation_unnamed';
}

function coerceType(t) {
    if (t === 'integer') return 'number';
    return PARAM_TYPES.includes(t) ? t : 'string';
}

/**
 * One property of the schema. `enum` and `items.type` ride along when present
 * (they make a tool call far more accurate than a bare type); the editor does
 * not know them and drops them the next time the author saves from the canvas.
 */
function propertyOf(row) {
    const type = coerceType(row.type);
    const prop = { type };
    if (typeof row.description === 'string' && row.description.trim()) prop.description = row.description.trim().slice(0, MAX_DESCRIPTION_LEN);
    if (Array.isArray(row.enum)) {
        const values = row.enum.filter(v => ['string', 'number', 'boolean'].includes(typeof v)).slice(0, MAX_ENUM_VALUES);
        if (values.length) prop.enum = values;
    }
    if (type === 'array' && isPlainObject(row.items) && typeof row.items.type === 'string') {
        prop.items = { type: coerceType(row.items.type) };
    }
    return prop;
}

/** Shorthand `{ name: 'string' }` or `{ name: { type } }` map: no `type`, no `properties`. */
function looksLikeShorthand(schema) {
    const entries = Object.entries(schema);
    return entries.length > 0 && entries.every(([, v]) => typeof v === 'string' || (isPlainObject(v) && typeof v.type === 'string'));
}

/** The rows ({ name, type, required, description, enum?, items? }) a JSON Schema or a params list declares. */
function rowsOf({ parametersSchema, params }, notes) {
    if (Array.isArray(params) && params.length) {
        return params.filter(p => isPlainObject(p) && p.name !== undefined && p.name !== null && String(p.name) !== '')
            .map(p => ({ ...p, name: String(p.name) }));
    }
    const schema = parametersSchema;
    if (!isPlainObject(schema)) return [];
    let props = schema.properties;
    if (!isPlainObject(props)) {
        if (schema.type === undefined && looksLikeShorthand(schema)) {
            notes.push('parametersSchema was a {name: type} map; read it as the properties of an object schema.');
            props = Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, typeof v === 'string' ? { type: v } : v]));
        } else {
            return [];
        }
    } else if (schema.type !== undefined && schema.type !== 'object') {
        notes.push(`parametersSchema.type was "${schema.type}"; an agent tool takes an object, so it was read as type "object".`);
    }
    const required = Array.isArray(schema.required) ? schema.required : [];
    return Object.entries(props)
        .filter(([, v]) => isPlainObject(v) || typeof v === 'string')
        .map(([name, v]) => {
            const def = typeof v === 'string' ? { type: v } : v;
            // A model sometimes writes `required: true` on the property itself.
            return { ...def, name, required: required.includes(name) || def.required === true };
        });
}

/**
 * Normalise what the builder was given into the stored `parametersSchema`:
 * `{ type: 'object', properties, required?, additionalProperties: false }`, the
 * exact shape the editor's paramsToSchema writes. Property NAMES are kept as
 * written (a silent rename would break the bindings the author is about to
 * write); the validator reports the ones that are not identifiers.
 *
 * Returns `{ schema, notes }`. `schema` is null when nothing was declared, so
 * the caller can leave the trigger without a schema (the open-object fallback)
 * rather than store an empty one that would read as "this tool takes no input".
 */
function normalizeParameters({ parametersSchema, params } = {}) {
    const notes = [];
    const rows = rowsOf({ parametersSchema, params }, notes);
    if (!rows.length) {
        // An object schema without properties is a tool that takes no argument;
        // anything else unreadable is "nothing declared".
        const noArgs = isPlainObject(parametersSchema)
            && (parametersSchema.type === 'object' || isPlainObject(parametersSchema.properties))
            && !Object.keys(parametersSchema.properties || {}).length;
        return { schema: noArgs ? { type: 'object', properties: {}, additionalProperties: false } : null, notes };
    }
    const properties = {};
    const required = [];
    for (const row of rows.slice(0, MAX_PARAMS)) {
        if (Object.prototype.hasOwnProperty.call(properties, row.name)) {
            notes.push(`argument "${row.name}" was declared twice; the first one is kept.`);
            continue;
        }
        properties[row.name] = propertyOf(row);
        if (row.required === true) required.push(row.name);
    }
    if (rows.length > MAX_PARAMS) notes.push(`only the first ${MAX_PARAMS} arguments are kept.`);
    if (isPlainObject(parametersSchema) && Array.isArray(parametersSchema.required)) {
        const unknown = parametersSchema.required.filter(n => !Object.prototype.hasOwnProperty.call(properties, n));
        if (unknown.length) notes.push(`required named ${unknown.map(n => `"${n}"`).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not in properties; dropped.`);
    }
    return {
        schema: { type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false },
        notes,
    };
}

/**
 * The declaration an agent_call trigger needs from the builder's arguments:
 * `{ fields, notes }` where `fields` holds only what was actually given
 * (toolName, description, parametersSchema), so an update can merge it.
 */
function agentCallFieldsFrom(args = {}) {
    const fields = {};
    const notes = [];
    if (args.toolName !== undefined) {
        const name = typeof args.toolName === 'string' ? args.toolName.trim() : '';
        if (name) {
            fields.toolName = sanitizeToolName(name);
            if (fields.toolName !== name) notes.push(`toolName "${name}" was written as "${fields.toolName}" (lower-case letters, digits and underscores only).`);
        } else {
            fields.toolName = null; // clears it: the tool falls back to automation_<id>
        }
    }
    if (args.description !== undefined) {
        fields.description = typeof args.description === 'string' ? args.description.trim().slice(0, MAX_TOOL_DESCRIPTION_LEN) : '';
    }
    if (args.parametersSchema !== undefined || args.params !== undefined) {
        const { schema, notes: n } = normalizeParameters({ parametersSchema: args.parametersSchema, params: args.params });
        notes.push(...n);
        if (schema) fields.parametersSchema = schema;
        else if (args.parametersSchema !== undefined || (Array.isArray(args.params) && args.params.length)) {
            notes.push('the declared arguments could not be read (expected params:[{name,type,required,description}] or a JSON Schema {type:"object",properties:{…}}); none were saved.');
        } else {
            fields.parametersSchema = null; // an explicit empty list clears the declaration
        }
    }
    return { fields, notes };
}

/** Issue records `[{ code, path, message, hint }]`, like validateAppTriggerParams; empty = valid. */
function validateAgentCallTrigger(trigger) {
    const issues = [];
    const push = (code, path, message, hint) => issues.push({ code, path, message, hint });
    const t = isPlainObject(trigger) ? trigger : {};

    if (t.toolName !== undefined && t.toolName !== null) {
        if (typeof t.toolName !== 'string' || !/[a-z0-9]/i.test(t.toolName)) {
            push('tool_name', 'toolName', 'toolName must be text with at least one letter or digit.', 'Name the tool after what it does, e.g. "lookup_warranty" (lower-case letters, digits, underscores). Leave it out to use automation_<id>.');
        }
    }
    if (typeof t.description !== 'string' || !t.description.trim()) {
        push('description_missing', 'description', 'The agent has no description of this tool, so it cannot know when to call it.', 'Say in one or two sentences what the automation does and when an agent should call it. Until then the agent reads the automation\'s own description or title.');
    } else if (t.description.length > MAX_TOOL_DESCRIPTION_LEN) {
        push('description_invalid', 'description', `description is longer than ${MAX_TOOL_DESCRIPTION_LEN} characters.`, `Shorten it; the agent is given only the first ${MAX_TOOL_DESCRIPTION_LEN}.`);
    }

    const schema = t.parametersSchema;
    if (schema === undefined || schema === null) return issues; // an undeclared tool takes any object
    if (!isPlainObject(schema) || schema.type !== 'object') {
        push('parameters_shape', 'parametersSchema', 'parametersSchema must be a JSON Schema object with type "object".', 'Use {type:"object", properties:{<name>:{type, description}}, required:[…]} or pass params:[{name,type,required,description}].');
        return issues;
    }
    if (schema.properties !== undefined && !isPlainObject(schema.properties)) {
        push('properties_shape', 'parametersSchema.properties', 'parametersSchema.properties must be an object keyed by argument name.', 'Declare each argument as properties.<name> = {type, description}.');
        return issues;
    }
    const props = schema.properties || {};
    const names = Object.keys(props);
    if (names.length > MAX_PARAMS) {
        push('params_too_many', 'parametersSchema.properties', `Too many arguments: ${names.length} > ${MAX_PARAMS}.`, 'Group related values into one object or array argument.');
    }
    for (const name of names) {
        const at = `parametersSchema.properties.${name}`;
        if (!PARAM_NAME_RE.test(name)) {
            push('param_name', at, `Argument name "${name}" is invalid.`, 'Use a letter followed by letters/digits/underscores (max 60 chars); names may not start with "_". It is how steps bind trigger.output.<name>.');
        }
        const type = isPlainObject(props[name]) ? props[name].type : undefined;
        if (typeof type === 'string' && ![...PARAM_TYPES, 'integer'].includes(type)) {
            push('param_type', `${at}.type`, `Argument type "${type}" is not supported.`, `Use one of: ${PARAM_TYPES.join(', ')}.`);
        }
    }
    if (schema.required !== undefined) {
        if (!Array.isArray(schema.required)) {
            push('required_shape', 'parametersSchema.required', 'parametersSchema.required must be a list of argument names.', 'Use required:["name", …] naming arguments declared in properties.');
        } else {
            const unknown = schema.required.filter(n => !Object.prototype.hasOwnProperty.call(props, n));
            if (unknown.length) {
                push('required_unknown', 'parametersSchema.required', `required names ${unknown.map(n => `"${n}"`).join(', ')}, which ${unknown.length === 1 ? 'is' : 'are'} not declared in properties.`, 'Declare it in properties, or drop it from required.');
            }
        }
    }
    return issues;
}

/**
 * The declared arguments of an agent_call trigger as `[{ name, type, required,
 * description }]`, for the builder's ref checks and prompts. Names that are not
 * identifiers are left out: a path cannot address them without brackets.
 */
function agentCallParams(trigger) {
    const schema = trigger && trigger.parametersSchema;
    if (!isPlainObject(schema) || !isPlainObject(schema.properties)) return [];
    const required = Array.isArray(schema.required) ? schema.required : [];
    return Object.entries(schema.properties)
        .filter(([name]) => PARAM_NAME_RE.test(name))
        .map(([name, p]) => ({
            name,
            type: coerceType(isPlainObject(p) ? p.type : undefined),
            required: required.includes(name),
            description: isPlainObject(p) && typeof p.description === 'string' ? p.description : '',
        }));
}

module.exports = {
    PARAM_TYPES,
    MAX_TOOL_DESCRIPTION_LEN,
    sanitizeToolName,
    normalizeParameters,
    agentCallFieldsFrom,
    validateAgentCallTrigger,
    agentCallParams,
};
