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

const ASK_HOW = 'Store right away, with template_fill_set_values, what the conversation or an attached file states and each field\'s template default (fields[].default). Only call a field filled in after template_fill_set_values stored it. The form under your reply lists every field with its explanation, so NEVER list the missing fields in your chat text: answer in one or two short sentences (what you just stored, then that they can fill in the rest in the form below or tell you here). Never ask for a field that already has a value. NEVER invent a value: a fact the user has not given is left for them to fill in, not guessed.';
const DOC_ID = 'documentId may be left out: the document this conversation is filling in is used.';
const DOC_ID_PARAM = 'Optional: the document from template_fill_start. Left out, the one this conversation is filling in.';

export const TEMPLATE_FILL_TOOLS: ToolDef[] = [
    {
        type: 'function',
        function: {
            name: 'document_templates_list',
            description: 'List the document templates this user may fill in (their own, and the templates shared with them or their team). Returns { templates: [{ templateId, name, docType, fieldCount, requiredCount, description }] }.\n\nUse it when the user wants to fill in a template but did not name one exactly, or names one you have no id for. When the user picked a template in the composer, its id is on the last line of their message as [template:<id>]: go straight to template_fill_start.',
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
            description: `Start filling in a template: makes a NEW document from it (the user's own, private; the template itself is never changed) and returns { documentId, name, url, missingRequired, filled, total, values, fields: [{ key, label, type, required, options?, help, example }] }.\n\nWhen this conversation is already filling in the same template, it returns THAT document (resumed: true) with its current values instead of a second copy; pass fresh: true only when the user explicitly wants another, separate document. Then fill the fields with template_fill_set_values. ${ASK_HOW}`,
            parameters: {
                type: 'object',
                properties: {
                    templateId: { type: 'string', description: 'The template to start from (from the user\'s message or document_templates_list).' },
                    name: { type: 'string', description: 'Optional name of the new document, e.g. "Offerte 2026-031 Van Dijk". Defaults to the template\'s name.' },
                    fresh: { type: 'boolean', description: 'true makes a new copy even when this conversation is already filling in this template. Only when the user asks for a second document.' },
                },
                required: ['templateId'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'template_fill_status',
            description: `Where the template being filled in stands NOW: { documentId, name, values, missingRequired, issues, complete, filled, total, fields }. The user can also fill in fields themselves in the form under your reply, so call this at the start of every turn while a fill is going, BEFORE you ask anything, and never ask for a field that already has a value. ${DOC_ID}`,
            parameters: {
                type: 'object',
                properties: {
                    documentId: { type: 'string', description: DOC_ID_PARAM },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'template_fill_set_values',
            description: `Store field values on the document being filled in. Values are merged with what is already filled in; pass null or "" to clear one. Returns { documentId, values, missingRequired, rejected, issues, complete, filled, total }.\n\nTypes: number as a number (12.5; a text like "12,5" is accepted), date as "YYYY-MM-DD", boolean as true/false, choice as exactly one of its options, list as an array of objects with the list's fields. A value of the wrong type, for an unknown key, or still masked by the Privacy Shield is NOT stored: it comes back in \`rejected\` with the reason, so ask the user again or correct it. Call it as soon as the user gives answers, so the work is saved as you go. ${DOC_ID} ${ASK_HOW}`,
            parameters: {
                type: 'object',
                properties: {
                    documentId: { type: 'string', description: DOC_ID_PARAM },
                    values: { type: 'object', description: 'Field values by key, e.g. { "client_name": "Van Dijk Groep", "amount": 1250 }.' },
                },
                required: ['values'],
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'template_fill_finish',
            description: `Finish the document being filled in. First sum up the filled-in values for the user and let them confirm; only then call this. When a required field is still missing it returns { complete: false, missingRequired } and nothing is finished: ask for those. When complete it returns { documentId, name, url, format, downloadUrl }: end your reply with the clickable link "[<name>](<url>)" (the user downloads it as PDF, or PowerPoint for a presentation, from the card under your reply). ${DOC_ID}`,
            parameters: {
                type: 'object',
                properties: {
                    documentId: { type: 'string', description: DOC_ID_PARAM },
                },
            },
        },
    },
    {
        type: 'function',
        function: {
            name: 'document_add_to_project',
            description: 'Add a document the user made (usually the one just filled in) to one of their projects, so the project\'s members see and edit it there. Only when the user asks for it. Without projectId it returns { projects: [{ id, name }] }: the projects this user may add to; ask which one unless the user named it. With projectId it files the document and returns { project, url }: end your reply with the clickable link "[<name>](<url>)".',
            parameters: {
                type: 'object',
                required: ['documentId'],
                properties: {
                    documentId: { type: 'string', description: 'The document\'s id, from template_fill_start or template_fill_finish.' },
                    projectId: { type: 'string', description: 'The id of the project, from the projects this tool listed. Leave out to list them.' },
                },
            },
        },
    },
];

export const TEMPLATE_FILL_TOOL_NAMES: ReadonlySet<string> = new Set(TEMPLATE_FILL_TOOLS.map((t) => t.function.name));
