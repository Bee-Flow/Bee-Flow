// @typecheck strict
const { KINDS } = require('./recipeDoc');

// Two forced calls at 4000 tokens on a local box; a wedged one must fail the
// dialog with a sentence rather than hang the request behind a proxy timeout.
const MODEL_BUDGET_MS = Number(process.env.PLAYBOOK_COMPOSE_BUDGET_MS || 120000);

/** The kinds a model may propose — the server owns the two closing phases. */
const PROPOSABLE_KINDS = Object.freeze(KINDS.filter((k) => k !== 'access' && k !== 'compliance'));

// The findings that a table would answer. Only these earn the last-resort
// synthesis below — a missing brief or a goalless design is not a table problem.
const TABLE_ERROR_CODES = new Set(['table_schema_missing', 'fill_without_table', 'unknown_placeholder', 'placeholder_before_table', 'requires_role_unknown']);

// `columns` is TOP-LEVEL, REQUIRED and alphabetically FIRST — all three on
// purpose. It used to be an optional nested `table.fields`; Gemma's chat
// template renders a tool's properties sorted by name, so the model wrote
// five long briefs under `phases` before it reached `table`, and being
// optional, skipped it — four composes in one day came back with
// `{{field.…}}` briefs and no table at all (2026-09-17). Required and first,
// the columns are the first thing it writes; `[]` keeps a tableless playbook
// honest instead of leaving the key out.
const RECIPE_TOOL = {
    type: 'function',
    function: {
        name: 'return_playbook',
        description: 'Return the playbook definition: the columns of its table (empty when none), the inputs the person fills in at start, and the phases in order with a brief for every builder phase.',
        parameters: {
            type: 'object',
            properties: {
                columns: {
                    type: 'array',
                    description: 'The columns of the Studio datatable the automation fills and the app reads — one entry per column, in display order. The server creates the table from THIS list; the phase of kind "table" carries no columns of its own. Every {{field.<key>}} a brief uses must be an entry here. Empty array only when the playbook needs no table.',
                    items: {
                        type: 'object',
                        properties: {
                            key: { type: 'string', description: 'snake_case column key in the language asked for, e.g. invoice_date. NEVER id, created_at, updated_at, created_by or org_id — every table already has those.' },
                            name: { type: 'string', description: 'Column title, in the language the system prompt asks for' },
                            type: { type: 'string', enum: ['text', 'richtext', 'number', 'date', 'datetime', 'bool', 'select', 'multiselect', 'file'] },
                            options: { type: 'array', items: { type: 'string' }, description: 'select/multiselect only' },
                            required: { type: 'boolean', description: 'false for optional columns (a status, a file path)' },
                        },
                        required: ['key', 'name', 'type'],
                    },
                },
                title: { type: 'string', description: 'Short name, in the language the system prompt asks for.' },
                description: { type: 'string', description: 'One sentence: what the playbook builds.' },
                inputs: {
                    type: 'array',
                    description: 'What the person types at start. A Nextcloud folder is kind "folder" with key "folderPath".',
                    items: {
                        type: 'object',
                        properties: {
                            key: { type: 'string' }, label: { type: 'string' }, kind: { type: 'string', enum: ['folder', 'text'] }, default: { type: 'string' },
                        },
                        required: ['key', 'label', 'kind'],
                    },
                },
                phases: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            key: { type: 'string', description: 'snake_case, unique' },
                            // `access` and `compliance` are OUT: the prompt
                            // documents six kinds, the validator has no ordering
                            // rule for either, and `withClosingPhases` appends
                            // both deterministically after the last app phase.
                            // A model-emitted `access` in position 2 was kept,
                            // nothing was appended, and the stage mounted with
                            // no app to govern.
                            kind: { type: 'string', enum: PROPOSABLE_KINDS },
                            label: { type: 'string', description: 'Short label, in the language the system prompt asks for' },
                            brief: { type: 'string', description: 'automation/app/app_turn only: the instruction the builder gets, written as MARKDOWN (a ## heading, one numbered step per line, `backticks` round tool names and ids), ≤ 1100 characters, with {{placeholders}}.' },
                            requires: { type: 'string', enum: ['approvals'], description: 'Set on the AUTOMATION that asks for approval in Studio → Approvals (needs the Enterprise capability).' },
                            requiresRole: { type: 'string', description: 'A table column key this phase writes (e.g. status) — the phase is skipped when an existing table lacks it.' },
                            goal: { type: 'string', description: 'design only: what the app is for, in plain words (screens a person needs, what they look up, what they decide).' },
                        },
                        required: ['key', 'kind', 'label'],
                    },
                },
            },
            required: ['title', 'columns', 'phases'],
        },
    },
};

module.exports = { MODEL_BUDGET_MS, PROPOSABLE_KINDS, TABLE_ERROR_CODES, RECIPE_TOOL };
