/**
 * The function-calling definitions of the chat's template-fill tools: the
 * person picks one of their document templates (Studio → Documents, kind
 * 'template') and the assistant fills its typed fields in together with them.
 * templateFillTools.mts runs them; documentBuilderToolDefs.js offers them next
 * to create_document, wherever that one is offered.
 *
 * The descriptions carry the conversation the model is meant to have: ask in
 * plain language, a few fields at a time, take what is already known, never
 * invent a value, and confirm before finishing.
 */

type ToolDef = {
    type: 'function',
    function: { name: string, description: string, parameters: { type: 'object', properties: Record<string, object>, required?: string[] } },
};

const ASK_HOW = 'Ask the user for what is still missing a few fields at a time (two to four per question), in plain language: use each field\'s label and help, never its raw key. Fill in what the conversation or an attached file already says, and say that you did. NEVER invent a value: a required fact the user has not given is asked for, not guessed.';

export const TEMPLATE_FILL_TOOLS: ToolDef[] = [
    {
        type: 'function',
        function: {
            name: 'document_templates_list',
            description: 'List the document templates this user may fill in (their own, and the templates shared with them or their team). Returns { templates: [{ templateId, name, docType, fieldCount, requiredCount, description }] }.\n\nUse it when the user wants to fill in a template but did not name one exactly, or names one you have no id for. When the user picked a template in the composer, its id is in their message: go straight to template_fill_start.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Optional words from the template\'s name or description, e.g. "offerte" or "engagement letter".' },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'template_fill_start',
            description: `Start filling in a template: makes a NEW document from it (the user's own, private; the template itself is never changed) and returns { documentId, name, url, fields: [{ key, label, type, required, options?, help, example }], values, missingRequired, filled, total }.\n\nCall it once per document, then fill the fields with template_fill_set_values. ${ASK_HOW}`,
            parameters: {
                type: 'object',
                properties: {
                    templateId: { type: 'string', description: 'The template to start from (from the user\'s message or document_templates_list).' },
                    name: { type: 'string', description: 'Optional name of the new document, e.g. "Offerte 2026-031 Van Dijk". Defaults to the template\'s name.' },
                },
                required: ['templateId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'template_fill_set_values',
            description: `Store field values on a document made with template_fill_start. Values are merged with what is already filled in; pass null or "" to clear one. Returns { values, missingRequired, rejected, issues, complete, filled, total }.\n\nTypes: number as a number (12.5; a text like "12,5" is accepted), date as "YYYY-MM-DD", boolean as true/false, choice as exactly one of its options, list as an array of objects with the list's fields. A value of the wrong type or for an unknown key is NOT stored: it comes back in \`rejected\` with the reason, so ask the user again or correct it. Call it as soon as the user gives answers, so the work is saved as you go. ${ASK_HOW}`,
            parameters: {
                type: 'object',
                properties: {
                    documentId: { type: 'string', description: 'The document returned by template_fill_start.' },
                    values: { type: 'object', description: 'Field values by key, e.g. { "client_name": "Van Dijk Groep", "amount": 1250 }.' },
                },
                required: ['documentId', 'values'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'template_fill_finish',
            description: 'Finish a document made with template_fill_start. First sum up the filled-in values for the user and let them confirm; only then call this. When a required field is still missing it returns { complete: false, missingRequired } and nothing is finished: ask for those. When complete it returns { documentId, name, url, format, downloadUrl }: end your reply with the clickable link "[<name>](<url>)" (the user downloads it as PDF, or PowerPoint for a presentation, from the card under your reply).',
            parameters: {
                type: 'object',
                properties: {
                    documentId: { type: 'string', description: 'The document returned by template_fill_start.' },
                },
                required: ['documentId'],
            },
        },
    },
];

export const TEMPLATE_FILL_TOOL_NAMES: ReadonlySet<string> = new Set(TEMPLATE_FILL_TOOLS.map((t) => t.function.name));
