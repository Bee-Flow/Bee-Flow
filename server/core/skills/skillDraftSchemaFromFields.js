// @typecheck strict
const { MAX_STEPS, MAX_RULES } = require('./skillStructure');

/** Same cap the create/update routes enforce on `instructions`. */
const MAX_INSTRUCTIONS = 4000;

const MAX_NAME = 200;

const MAX_DESCRIPTION = 1000;

const MAX_TEXT = 4000;

/** One sentence in, one skill out. Longer than this is a document, not a brief. */
const MAX_SENTENCE_CHARS = 1000;

/** How many output fields the model may propose. */
const MAX_OUTPUT_FIELDS = 12;

const OUTPUT_TYPES = Object.freeze(['string', 'number', 'integer', 'boolean', 'array', 'object']);

/** The forced-tool schema. Shared by draft and improve — same contract, per the plan. */
const DRAFT_TOOL = {
    type: 'function',
    function: {
        name: 'draft_skill',
        description: 'Write out the skill: what it is for, when to use it, the steps to follow, the rules, and worked examples.',
        parameters: {
            type: 'object',
            additionalProperties: false,
            required: ['name', 'description', 'steps'],
            properties: {
                name: { type: 'string', description: 'Short name, as a person would say it. No quotes.' },
                description: { type: 'string', description: 'One sentence: what this skill does.' },
                instructions: { type: 'string', description: 'When the agent should reach for this skill, and how. A short paragraph.' },
                steps: {
                    type: 'array',
                    maxItems: MAX_STEPS,
                    description: 'The method, in order. One action per step, phrased as an instruction.',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['text'],
                        properties: {
                            id: { type: 'string', description: 'Only when you are keeping an EXISTING step: copy its id exactly. Leave empty for a new step.' },
                            text: { type: 'string', description: 'One step, one action.' },
                        },
                    },
                },
                rules: {
                    type: 'array',
                    maxItems: MAX_RULES,
                    description: 'What must always or never happen. Keep them checkable.',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['polarity', 'text'],
                        properties: {
                            id: { type: 'string', description: 'Only when keeping an existing rule: copy its id exactly.' },
                            polarity: { type: 'string', enum: ['must', 'never'] },
                            text: { type: 'string' },
                        },
                    },
                },
                examples: {
                    type: 'array',
                    maxItems: 5,
                    description: 'Worked examples: a realistic question and the answer this skill should produce.',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['question', 'good'],
                        properties: {
                            question: { type: 'string' },
                            good: { type: 'string', description: 'The answer the skill should give.' },
                            rationale: { type: 'string', description: 'One sentence: why that answer is right.' },
                        },
                    },
                },
                outputFields: {
                    type: 'array',
                    maxItems: MAX_OUTPUT_FIELDS,
                    description: 'Only when this skill should return structured fields (a form, a record). Leave empty otherwise.',
                    items: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['key', 'type'],
                        properties: {
                            key: { type: 'string', description: 'snake_case field key, letters/digits/underscore.' },
                            type: { type: 'string', enum: [...OUTPUT_TYPES] },
                            title: { type: 'string', description: 'Human label.' },
                        },
                    },
                },
            },
        },
    },
};

/**
 * @param {unknown} v
 * @param {number} max
 */
function clean(v, max) {
    return typeof v === 'string' ? v.replace(/\r\n?/g, '\n').trim().slice(0, max) : '';
}

/**
 * `outputFields` rows → the JSON-schema object `output_schema` stores, or null.
 * @param {unknown} fields  untrusted model output
 */
function schemaFromFields(fields) {
    const rows = Array.isArray(fields) ? fields : [];
    /** @type {Record<string, { type: string, title?: string }>} */
    const properties = {};
    for (const raw of rows.slice(0, MAX_OUTPUT_FIELDS)) {
        if (!raw || typeof raw !== 'object') continue;
        const key = clean(raw.key, 64);
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) continue;   // dropped, never repaired
        if (!OUTPUT_TYPES.includes(raw.type)) continue;
        /** @type {{ type: string, title?: string }} */
        const prop = { type: raw.type };
        const title = clean(raw.title, 200);
        if (title) prop.title = title;
        properties[key] = prop;
    }
    return Object.keys(properties).length > 0 ? { type: 'object', properties } : null;
}

module.exports = { MAX_INSTRUCTIONS, MAX_NAME, MAX_DESCRIPTION, MAX_TEXT, MAX_SENTENCE_CHARS, MAX_OUTPUT_FIELDS, DRAFT_TOOL, clean, schemaFromFields };
