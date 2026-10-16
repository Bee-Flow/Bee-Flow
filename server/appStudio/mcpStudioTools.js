'use strict';

/** The three MCP-only tools, in the same OpenAI shape as TOOL_SCHEMAS. */
const STUDIO_TOOLS = [
    {
        name: 'studio_get_guide',
        description: 'The App Studio builder guide: how to compose screens/sections/components, the full component catalog with every prop and style knob, the action and sequence-step vocabulary, binding kinds and the formula functions. CALL THIS FIRST, once per session, before authoring anything — the app_* tool descriptions teach the call protocol only, not the vocabulary, and ids/props invented without the catalog get rejected by the validator.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'studio_list_apps',
        description: 'List the App Studio apps this token\'s user owns (id, name, description, version, published state, template provenance). Start here to find the appId to work on.',
        parameters: { type: 'object', properties: {} },
    },
    {
        name: 'studio_create_app',
        description: 'Create a new, empty App Studio app owned by this token\'s user and return its appId. Optionally start from a built-in template (see app_list_templates for ids) — a template gives you screens, tables and seed rows to edit rather than a blank canvas.',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'App name (max 80 chars).' },
                description: { type: 'string', description: 'One or two sentences on what the app does.' },
                icon: { type: 'string', description: 'Lucide icon name, e.g. "ClipboardList".' },
                templateId: { type: 'string', description: 'Optional template id to install into the new app (app_list_templates lists them).' },
            },
            required: ['name'],
        },
    },
];

module.exports = { STUDIO_TOOLS };
