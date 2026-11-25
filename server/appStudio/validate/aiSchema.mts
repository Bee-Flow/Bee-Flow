import { AI_ITEM_TYPES } from '../aiFieldShape.mts';
import { AI_SCHEMA_FIELD_TYPES } from '../componentSpecs/actionSpecsActionKinds.js';
import { LIMITS } from '../componentSpecs/limits.js';
import { HARD_DEPTH_CAP } from '../canonicalize/shared.js';
import type { ValidationCtx } from './shared.js';

type Ctx = Pick<ValidationCtx, 'pushE'>;
type Field = Record<string, unknown>;
const isObject = (v: unknown): v is Field => v !== null && typeof v === 'object' && !Array.isArray(v);

function validateObjectFields(shape: Field, path: string, ctx: Ctx, depth: number) {
    if (shape.fields === undefined) return;
    if (shape.type !== 'object') {
        ctx.pushE({ code: 'action.ai_schema_invalid', severity: 'error', path: `${path}.fields`, message: 'Only an object can declare nested fields.', hint: 'Declare fields on an object.' });
    } else if (!Array.isArray(shape.fields) || shape.fields.length) {
        validateAiSchema('fields', shape.fields, `${path}.fields`, ctx, depth + 1);
    }
}

function validateFieldShape(field: Field, path: string, ctx: Ctx, depth: number) {
    validateObjectFields(field, path, ctx, depth);
    if (field.items === undefined) return;
    const error = (key: string, message: string, hint: string) => ctx.pushE({ code: 'action.ai_schema_invalid', severity: 'error', path: `${path}.${key}`, message, hint });
    if (field.type !== 'array' || !isObject(field.items)) {
        error('items', 'Only array fields accept an items declaration, which must be an object.', 'For a text list use items: { type: "string" }.');
    } else if (typeof field.items.type !== 'string' || !AI_ITEM_TYPES.includes(field.items.type)) {
        error('items.type', 'Array items need a supported element type.', `Use one of: ${AI_ITEM_TYPES.join(', ')}.`);
    } else {
        const unknown = Object.keys(field.items).find((key) => key !== 'type' && key !== 'fields');
        if (unknown) error(`items.${unknown}`, `Unknown array item property "${unknown}".`, 'Use type and, for objects, fields.');
        validateObjectFields(field.items, `${path}.items`, ctx, depth);
    }
}

export function validateAiSchema(field: string, value: unknown, path: string, ctx: Ctx, depth = 0): void {
    const { pushE } = ctx;
    if (depth > HARD_DEPTH_CAP) { pushE({ code: 'action.ai_schema_invalid', severity: 'error', path, message: 'The output schema is nested too deeply.', hint: 'Flatten the nested fields.' }); return; }
    if (!Array.isArray(value)) { pushE({ code: 'action.ai_schema_invalid', severity: 'error', path, message: `\`${field}\` must be an array of { name, type } fields.`, hint: 'Add at least one output field.' }); return; }
    if (value.length === 0) { pushE({ code: 'action.ai_schema_empty', severity: 'error', path, message: `\`${field}\` needs at least one output field.`, hint: 'Declare the fields the AI should return.' }); return; }
    if (value.length > LIMITS.MAX_AI_SCHEMA_FIELDS) { pushE({ code: 'action.ai_schema_too_large', severity: 'error', path, message: `\`${field}\` has ${value.length} fields — the maximum is ${LIMITS.MAX_AI_SCHEMA_FIELDS}.`, hint: 'Reduce the number of output fields.' }); return; }
    const seen = new Set();
    value.forEach((f, i) => {
        const fp = `${path}[${i}]`;
        if (!isObject(f)) { pushE({ code: 'action.ai_schema_invalid', severity: 'error', path: fp, message: 'Each schema field must be an object { name, type }.', hint: 'Provide a name and a type.' }); return; }
        if (typeof f.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,59}$/.test(f.name)) {
            pushE({ code: 'action.ai_schema_invalid', severity: 'error', path: `${fp}.name`, message: `Schema field name ${JSON.stringify(f.name)} must start with a letter and use only letters, digits and underscores.`, hint: 'Rename the field.' });
            return;
        }
        if (seen.has(f.name)) { pushE({ code: 'action.ai_schema_invalid', severity: 'error', path: `${fp}.name`, message: `Duplicate schema field name "${f.name}".`, hint: 'Field names must be unique.' }); return; }
        seen.add(f.name);
        if (typeof f.type !== 'string' || !AI_SCHEMA_FIELD_TYPES.includes(f.type)) {
            pushE({ code: 'action.ai_schema_invalid', severity: 'error', path: `${fp}.type`, message: `Schema field "${f.name}" has invalid type ${JSON.stringify(f.type)}.`, hint: `Use one of: ${AI_SCHEMA_FIELD_TYPES.join(', ')}.` });
        }
        validateFieldShape(f, fp, ctx, depth);
        if (f.description !== undefined && typeof f.description !== 'string') {
            pushE({ code: 'action.ai_schema_invalid', severity: 'error', path: `${fp}.description`, message: `Schema field "${f.name}" description must be a string.`, hint: 'Pass the description as plain text.' });
        } else if (typeof f.description === 'string' && f.description.length > LIMITS.MAX_AI_SCHEMA_FIELD_DESC) {
            pushE({ code: 'action.ai_schema_invalid', severity: 'error', path: `${fp}.description`, message: `Schema field "${f.name}" description is ${f.description.length} chars — the maximum is ${LIMITS.MAX_AI_SCHEMA_FIELD_DESC}.`, hint: 'Shorten the description.' });
        }
    });
}
