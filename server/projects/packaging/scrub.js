/**
 * What never leaves this installation.
 *
 * ── Why one module ─────────────────────────────────────────────────────────
 *
 * There were three partial lists. appStudio/templateCapture.js scrubbed some
 * things, automation/portability.js scrubbed others, and NEITHER scrubbed
 * approver identities or knowledge-base references — so sharing an app template
 * or exporting a routine already shipped one organisation's user ids, group ids
 * and KB ids to another. That was not a hypothetical; it was live in both paths.
 *
 * A fourth list would have made a fourth omission inevitable, and the omissions
 * in this area are not cosmetic: they are one tenant's identifiers arriving in
 * another tenant's install. So the credential-and-people rules live here, every
 * caller runs the same sweep, and each rule is named, explained and tested.
 *
 * ── The boundary ───────────────────────────────────────────────────────────
 *
 * This module owns CREDENTIALS and PEOPLE — the things whose leak is a security
 * problem rather than a broken reference. Format-specific staleness (a
 * routine's pinned outputs, an app's builder transcript, seed rows for tables
 * nobody asked for) stays with the module that understands that format.
 *
 * ── Deliberately NOT scrubbed ──────────────────────────────────────────────
 *
 * `connectorId` stays as authored. In the shipped templates it is a stable NAME
 * (`conn_qimail`), not an opaque id: the app carries the connector's identity
 * and the installer supplies the credentials. Rewriting it would break the app
 * it was captured from on the next round-trip. It is reported in `requires`
 * instead — told, not guessed.
 */

'use strict';

// Required lazily, inside the sweeps. templateCapture and portability both
// call INTO this module, so requiring them at load time would be a cycle and
// one of the three would see a half-built exports object. Deferring to call
// time costs nothing and keeps every caller able to require this normally.
const walkers = () => ({
    walkObjects: require('../../appStudio/templateCapture').walkObjects,
    walkAllSteps: require('../../automation/portability').walkAllSteps,
});

/**
 * Seat fields on an app's `request_approval` action. Each names a PERSON or a
 * GROUP in the source organisation; in the destination they are at best
 * meaningless and at worst a real user who never agreed to approve anything.
 */
const APP_SEAT_FIELDS = [
    'assigneeUserId', 'assigneeGroupId',
    'finalApproverUserId', 'finalApproverGroupId',
    'escalateToUserId', 'escalateToGroupId',
];
const APP_SEAT_LISTS = ['approverUserIds', 'approverGroupIds'];

/** The same seats on an automation's `approval` step, where they are objects. */
const AUTOMATION_SEAT_FIELDS = ['assignee', 'approvers', 'escalateTo', 'finalApprover'];

/**
 * Every rule, named and explained. The test file walks this list and asserts
 * each one both fires and is reported — so adding a rule without a test, or a
 * test without a rule, fails.
 */
const RULES = {
    APP_AUTOMATION_REFERENCE: 'app.automation_reference',
    APP_APPROVER_IDENTITY: 'app.approver_identity',
    APP_KNOWLEDGE_BASE_REFERENCE: 'app.knowledge_base_reference',
    AUTOMATION_APPROVER_IDENTITY: 'automation.approver_identity',
    AUTOMATION_CONNECTION_REFERENCE: 'automation.connection_reference',
    AUTOMATION_DATATABLE_REFERENCE: 'automation.datatable_reference',
    AUTOMATION_KNOWLEDGE_BASE_REFERENCE: 'automation.knowledge_base_reference',
    // ── The three kinds a Solution gained in O1 ──────────────────────────
    DATATABLE_GRANTS: 'datatable.grants',
    DATATABLE_GOVERNANCE: 'datatable.governance',
    DATATABLE_TENANT_IDENTITY: 'datatable.tenant_identity',
    AGENT_TOOL_AUTHORITY: 'agent.tool_authority',
    AGENT_ENABLED_INTEGRATIONS: 'agent.enabled_integrations',
    AGENT_RESOURCE_REFERENCE: 'agent.resource_reference',
    AGENT_TENANT_IDENTITY: 'agent.tenant_identity',
    KNOWLEDGE_BASE_CONTENT: 'knowledge_base.content',
    KNOWLEDGE_BASE_TENANT_IDENTITY: 'knowledge_base.tenant_identity',
    // The rule that catches what nobody thought of. See ALLOW-LISTS below.
    UNLISTED_FIELD: 'any.unlisted_field',
    WEBPAGE_BRIDGE_ARGUMENTS: 'webpage.bridge_arguments',
    WEBPAGE_PUBLIC_AI: 'webpage.public_ai',
};

const RULE_WHY = {
    [RULES.APP_AUTOMATION_REFERENCE]:
        'A routine id from another installation is a dangling pointer with a plausible shape. The installer wires their own and the editor asks them to.',
    [RULES.APP_APPROVER_IDENTITY]:
        'An approver seat names a real person or group in the source organisation. Carrying it over addresses a decision to someone who never agreed to make it.',
    [RULES.APP_KNOWLEDGE_BASE_REFERENCE]:
        'A knowledge base id identifies an internal resource of the source organisation and resolves to nothing in the destination.',
    [RULES.AUTOMATION_APPROVER_IDENTITY]:
        'Same as the app case: an approval step carries seats, and seats are people.',
    [RULES.AUTOMATION_CONNECTION_REFERENCE]:
        'A saved connection points at a credential row. On another install that id is absent, or — far worse — somebody else\'s credential.',
    [RULES.AUTOMATION_DATATABLE_REFERENCE]:
        'A datatable id names a table in ONE organisation. Elsewhere it resolves to nothing, and on a shared installation it could name somebody else\'s table. The KEY travels instead, so an import can re-link by it.',
    [RULES.AUTOMATION_KNOWLEDGE_BASE_REFERENCE]:
        'Same as the app case (APP_KNOWLEDGE_BASE_REFERENCE): an ai_step\'s knowledgeBaseIds — and a knowledge_write step\'s knowledgeBaseId — identify internal resources of the source organisation and resolve to nothing, or on a shared installation to somebody else\'s knowledge base, in the destination. The write side matters more: an id nobody chose in a step that ADDS documents.',
    [RULES.DATATABLE_GRANTS]:
        'A datatable grant names a person or a group who may read or write that table. It is one organisation\'s access control list, and re-creating it elsewhere would hand rights to strangers who happen to share an id — or, on a shared installation, to real people who never asked for them.',
    [RULES.DATATABLE_GOVERNANCE]:
        'A lawful basis is a legal claim made by ONE controller about ONE processing activity. Carrying it into another organisation\'s processing record states their basis for them, which nobody but them may do. The retention window travels — that one PROTECTS the recipient\'s data rather than describing somebody else\'s.',
    [RULES.DATATABLE_TENANT_IDENTITY]:
        'The scope, the owner, the organisation and the sharing state say WHERE a table lives and WHO reaches it. All four are re-decided by whoever installs it, and carrying them over would file the new table into a tenant that is not theirs.',
    [RULES.AGENT_TOOL_AUTHORITY]:
        'An `actAs: owner` tool grant lets the agent borrow its OWNER\'s connection — sending mail as them, reading their drive. A Blueprint that carried it would arrive able to act with an authority nobody in the destination ever granted, so every grant is written back to `viewer`: the installed agent acts as whoever is using it, and can never exceed them.',
    [RULES.AGENT_ENABLED_INTEGRATIONS]:
        'The list of connected apps an agent may reach is a grant, not a setting: it is only meaningful against credentials that exist in ONE installation. It travels as a REQUIREMENT the installer satisfies deliberately, never as a permission that arrives already switched on.',
    [RULES.AGENT_RESOURCE_REFERENCE]:
        'An agent\'s knowledge_base_ids and attachedSkillIds name internal resources of the source organisation. Elsewhere they resolve to nothing, and on a shared installation they could name somebody else\'s base or skill — the same rule the app and automation cases already apply, reached from the agent side.',
    [RULES.AGENT_TENANT_IDENTITY]:
        'An agent row carries its owner, its organisation, its category, its shared groups and its published projection. Every one of those is the source installation talking about itself, and an installed agent must belong to whoever installed it rather than arrive pre-shared with groups that do not exist.',
    [RULES.KNOWLEDGE_BASE_CONTENT]:
        'A knowledge base IS its documents, and its documents are whatever an organisation put in them — contracts, notes, personal data. A Blueprint carries the SHELL so the recipient fills it with their own material; the sources travel no further, because a source knows where to fetch from and that place is not theirs.',
    [RULES.KNOWLEDGE_BASE_TENANT_IDENTITY]:
        'The tenant, the organisation, the category and the publish state place a base inside ONE installation\'s structure. A category id in particular resolves to a row the destination does not have, so it would arrive filed under nothing at all.',
    [RULES.UNLISTED_FIELD]:
        'Everything a Blueprint carries is named on an allow-list, and anything else is dropped and reported here. Removing known-bad keys instead would mean a column added next year travels by default — which is exactly how a field nobody reviewed ends up in another organisation\'s install.',
    [RULES.WEBPAGE_BRIDGE_ARGUMENTS]:
        'A bridge grant\'s fixedArgs are author-supplied arguments to an integration call and can hold paths, ids, tokens or a whole request body. The tool NAME travels so the installer knows what to re-authorise; the arguments do not.',
    [RULES.WEBPAGE_PUBLIC_AI]:
        'The `ai.public*` half of a page\'s bridge grants decides whether ANONYMOUS visitors may spend the page owner\'s AI budget, and up to how much. Carrying it would let a Blueprint arm public spending on the installer\'s account before they have seen the page — so the whole ai block is dropped and the store\'s own default (public off) is what the installed page gets.',
};

function isObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

function note(report, rule, detail) { report.push({ rule, ...detail }); }

/** Strip the seat fields an app action carries, reporting each removal. */
function scrubAppSeats(action, report) {
    for (const field of APP_SEAT_FIELDS) {
        if (action[field] === undefined || action[field] === null) continue;
        delete action[field];
        note(report, RULES.APP_APPROVER_IDENTITY, { field, actionId: action.id || null });
    }
    for (const field of APP_SEAT_LISTS) {
        if (!Array.isArray(action[field]) || action[field].length === 0) continue;
        const count = action[field].length;
        delete action[field];
        note(report, RULES.APP_APPROVER_IDENTITY, { field, count, actionId: action.id || null });
    }
}

/**
 * Sweep an APP definition. Mutates; returns the report.
 *
 * Note the order this must run in relative to the caller's own collection:
 * anything the caller wants to REPORT in `requires` has to be read before it is
 * removed here. templateCapture collects connectors and knowledge bases first
 * for exactly that reason.
 */
function scrubAppDefinition(definition, report = []) {
    if (!isObject(definition)) return report;
    const { walkObjects } = walkers();
    walkObjects(definition, (obj) => {
        if (obj.kind === 'run_automation' && typeof obj.automationId === 'string' && obj.automationId) {
            note(report, RULES.APP_AUTOMATION_REFERENCE, { automationId: obj.automationId, actionId: obj.id || null });
            obj.automationId = null;
        }
        if (obj.kind === 'request_approval') scrubAppSeats(obj, report);
        if (Array.isArray(obj.knowledgeBaseIds) && obj.knowledgeBaseIds.length) {
            note(report, RULES.APP_KNOWLEDGE_BASE_REFERENCE, { count: obj.knowledgeBaseIds.length });
            obj.knowledgeBaseIds = [];
        }
    });
    return report;
}

/** Sweep an AUTOMATION definition — root graph and every layer. Mutates. */
function scrubAutomationDefinition(definition, report = []) {
    if (!isObject(definition)) return report;
    const { walkAllSteps } = walkers();
    walkAllSteps(definition, (step, layerKey) => {
        if (step.type === 'approval' && isObject(step.approval)) {
            for (const field of AUTOMATION_SEAT_FIELDS) {
                const value = step.approval[field];
                if (value === undefined || value === null) continue;
                if (Array.isArray(value) && value.length === 0) continue;
                delete step.approval[field];
                note(report, RULES.AUTOMATION_APPROVER_IDENTITY, {
                    field, stepId: step.id || null, layerKey: layerKey || null,
                });
            }
        }
        if (step.type === 'http_request' && isObject(step.auth) && step.auth.connectionId) {
            step.auth = null;
            note(report, RULES.AUTOMATION_CONNECTION_REFERENCE, {
                stepId: step.id || null, layerKey: layerKey || null,
            });
        }
        // portability.js swept this on its own — a fourth partial list, which
        // is the shape this module exists to prevent. The `datatableKey` is
        // left standing on purpose: it is the author's own slug ("invoices"),
        // not an identifier of one organisation's row, and it is the only thing
        // that lets an import re-link the step instead of telling the installer
        // to "pick a table again" with no way to know which one it was.
        if (step.type === 'datatable' && typeof step.datatableId === 'string' && step.datatableId) {
            step.datatableId = '';
            note(report, RULES.AUTOMATION_DATATABLE_REFERENCE, {
                stepId: step.id || null, layerKey: layerKey || null,
                datatableKey: (typeof step.datatableKey === 'string' && step.datatableKey) ? step.datatableKey : null,
            });
        }
        // The SECOND place a step can name a table: the http_request step's
        // "remember answers in a table". Same rule, same reason — a datatable id
        // names a table in ONE organisation — and the whole `cacheInto` goes
        // rather than just the id, because a window with no table to keep is a
        // setting that reads as configured and does nothing.
        if (step.type === 'http_request' && isObject(step.cacheInto)
            && typeof step.cacheInto.datatableId === 'string' && step.cacheInto.datatableId) {
            delete step.cacheInto;
            note(report, RULES.AUTOMATION_DATATABLE_REFERENCE, {
                stepId: step.id || null, layerKey: layerKey || null, datatableKey: null,
                field: 'cacheInto',
            });
        }
        // ai_step Knowledge Base grounding (BFSF-410) — same rule as the app
        // side's APP_KNOWLEDGE_BASE_REFERENCE above, reached from the
        // automation side: an execAiStep KB id is re-checked against the
        // running user/org at run time regardless (it is never trusted
        // blindly), so a stale foreign id left standing would not be
        // SEARCHED on the destination install — but it would still name the
        // source organisation's internal resource in a document the
        // installer did not write. Emptied like the app case, not rebound
        // like a datatable id: there is no author-chosen slug to re-link by.
        if (step.type === 'ai_step' && Array.isArray(step.knowledgeBaseIds) && step.knowledgeBaseIds.length) {
            note(report, RULES.AUTOMATION_KNOWLEDGE_BASE_REFERENCE, {
                stepId: step.id || null, layerKey: layerKey || null, count: step.knowledgeBaseIds.length,
            });
            step.knowledgeBaseIds = [];
        }
        /**
         * `knowledge_write.knowledgeBaseId` — the same rule from the WRITE
         * side, and the side where leaving it would be worse than a dangling
         * pointer.
         *
         * A read that survives export is a search that finds nothing. A WRITE
         * that survives export is an id the recipient never chose, in a step
         * that puts documents into a knowledge base — and on a shared
         * installation that id can name a real base belonging to somebody
         * else. The run-time gate refuses it (the importer will not manage a
         * base in another organisation), but the right place to stop it is
         * before it travels: the recipient must PICK where their routine
         * writes, the same way they pick a datatable.
         *
         * No key to re-link by, so it is emptied rather than rebound.
         */
        if (step.type === 'knowledge_write' && typeof step.knowledgeBaseId === 'string' && step.knowledgeBaseId) {
            note(report, RULES.AUTOMATION_KNOWLEDGE_BASE_REFERENCE, {
                stepId: step.id || null, layerKey: layerKey || null, count: 1, field: 'knowledgeBaseId',
            });
            step.knowledgeBaseId = '';
        }
    });
    return report;
}

// ── Allow-lists: the three kinds that travel as a SHAPE ─────────────────────
//
// The rules above SWEEP a document: they walk what is there and remove what
// must not leave. That works for an app or an automation definition, which is
// the author's own document from end to end.
//
// A table, an agent and a knowledge base are not documents — they are ROWS, and
// a row grows columns. Sweeping a row means listing the columns that are
// dangerous today, and a column added next year travels for free because nobody
// remembered to add it to the list. The three builders below therefore work the
// other way round: they NAME what may leave, copy exactly that, and report
// everything else as UNLISTED_FIELD. A new column shows up in the report on the
// first export instead of in another organisation's install.
//
// Each returns `{ payload, report }` and mutates nothing.

function pick(source, fields) {
    const out = {};
    for (const f of fields) if (source[f] !== undefined) out[f] = source[f];
    return out;
}

/** Report every key of `source` that is not on `allowed` and not `handled`. */
function noteUnlisted(report, kind, source, allowed, handled = []) {
    const known = new Set([...allowed, ...handled]);
    for (const field of Object.keys(source || {})) {
        if (known.has(field)) continue;
        note(report, RULES.UNLISTED_FIELD, { kind, field });
    }
}

/** The columns of a table, as SHAPE. Never a value, never a row. */
const DATATABLE_COLUMN_FIELDS = ['key', 'name', 'type', 'options', 'required', 'unique'];

/**
 * A table's schema, and nothing else.
 *
 * Three things are named as deliberately ABSENT rather than merely missing:
 *
 *   - the ROWS. Not one, ever, under any flag. A table's rows are whatever an
 *     organisation put in it, and the app-template path already learned this
 *     the hard way (`includeData: true` shipping a customer's purchase orders).
 *     There is no read of them here to switch on.
 *   - `datatable_grants`. Who may reach a table is one organisation's access
 *     control list; see DATATABLE_GRANTS.
 *   - the column `id`s (`fld_…`). They are minted per installation, and
 *     normalizeFields re-matches by KEY on the way in, so dropping them lets a
 *     Blueprint arrive without claiming anything about the ids of the install
 *     that produced it.
 *
 * `retentionDays`, `retentionField` and `subjectColumn` DO travel: they narrow
 * what the destination keeps and power its erasure, so carrying them protects
 * the recipient. The lawful basis does not — that is a legal claim only its own
 * controller may make.
 */
const DATATABLE_ALLOWED = ['key', 'name', 'description', 'rowScope', 'retentionDays', 'retentionField', 'subjectColumn'];

function captureDatatableShape(table, tableMeta = null, report = []) {
    const src = isObject(table) ? table : {};
    const payload = pick(src, DATATABLE_ALLOWED);
    payload.key = src.key || '';
    payload.name = src.name || '';
    payload.description = src.description || '';
    payload.rowScope = src.rowScope === 'own' ? 'own' : 'all';

    if (src.lawfulBasis) note(report, RULES.DATATABLE_GOVERNANCE, { field: 'lawfulBasis' });
    for (const field of ['scope', 'scopeKind', 'organizationId', 'ownerUserId', 'isPublished', 'sharedGroups', 'writeMode']) {
        if (src[field] !== undefined && src[field] !== null) {
            note(report, RULES.DATATABLE_TENANT_IDENTITY, { field });
        }
    }
    // Reported unconditionally: a table always HAS grants, even when the list
    // happens to be empty, and "we did not carry them" is the fact worth
    // recording either way.
    note(report, RULES.DATATABLE_GRANTS, { key: payload.key });

    const fields = Array.isArray(tableMeta?.fields) ? tableMeta.fields : [];
    payload.columns = fields.filter(isObject).map((f) => {
        noteUnlisted(report, 'datatable.column', f, DATATABLE_COLUMN_FIELDS, ['id']);
        const col = pick(f, DATATABLE_COLUMN_FIELDS);
        col.key = f.key || '';
        col.name = f.name || col.key;
        col.type = f.type || 'text';
        return col;
    });

    noteUnlisted(report, 'datatable', src, DATATABLE_ALLOWED,
        ['id', 'lawfulBasis', 'scope', 'scopeKind', 'organizationId', 'ownerUserId', 'isPublished',
            'sharedGroups', 'writeMode', 'projectId']);

    return { payload, report };
}

/**
 * The agent fields that travel, and the CONFIG keys inside them.
 *
 * The config list is short on purpose. `config` is an open object — the wizard,
 * the MCP builder and the legacy editor all write into it — so allowing
 * "everything except the bad keys" would mean the next key anybody invents
 * travels before anyone has decided whether it should.
 */
const AGENT_ALLOWED = [
    'name', 'description', 'systemPrompt', 'model', 'starterPrompts',
    'threadsEnabled', 'copyEnabled', 'workspaceEnabled',
];
const AGENT_CONFIG_ALLOWED = ['tools', 'memoryEnabled', 'temperature'];

/**
 * Clamp one `config.tools` map down to what an installed agent may hold.
 *
 * `actAs` is forced to 'viewer' for EVERY entry, whatever it said. That is the
 * whole rights story of an installed agent in one line: it acts as the person
 * using it and can never borrow a connection from the person who exported it.
 */
function captureToolGrants(tools, report) {
    if (!isObject(tools)) return undefined;
    const out = {};
    for (const [app, entry] of Object.entries(tools)) {
        if (!isObject(entry)) continue;
        if (entry.actAs === 'owner') {
            note(report, RULES.AGENT_TOOL_AUTHORITY, { app, from: 'owner' });
        }
        const actions = entry.actions === '*' ? '*'
            : (Array.isArray(entry.actions) ? entry.actions.filter(a => typeof a === 'string') : []);
        out[app] = { actions, actAs: 'viewer' };
        if (entry.confirm === 'ask' || entry.confirm === 'direct') out[app].confirm = entry.confirm;
        noteUnlisted(report, 'agent.config.tools.entry', entry, ['actions', 'actAs', 'confirm']);
    }
    return out;
}

function captureAgentShape(agent, report = []) {
    const src = isObject(agent) ? agent : {};
    // The store hands back snake_case columns beside the camelCase view, so
    // both spellings are read and exactly one is written.
    const read = (camel, snake) => (src[camel] !== undefined ? src[camel] : src[snake]);

    const payload = {
        name: read('name', 'name') || '',
        description: read('description', 'description') || '',
        systemPrompt: read('systemPrompt', 'system_prompt') || '',
        model: read('model', 'model') || null,
        starterPrompts: Array.isArray(read('starterPrompts', 'starter_prompts')) ? read('starterPrompts', 'starter_prompts') : [],
        threadsEnabled: read('threadsEnabled', 'threads_enabled') !== false,
        copyEnabled: read('copyEnabled', 'copy_enabled') !== false,
        workspaceEnabled: read('workspaceEnabled', 'workspace_enabled') === true,
        config: {},
    };

    const config = isObject(src.config) ? src.config : {};
    const tools = captureToolGrants(config.tools, report);
    if (tools) payload.config.tools = tools;
    for (const key of AGENT_CONFIG_ALLOWED) {
        if (key === 'tools') continue;
        if (config[key] !== undefined) payload.config[key] = config[key];
    }

    const integrations = Array.isArray(config.enabledIntegrations)
        ? config.enabledIntegrations.filter(i => typeof i === 'string' && i) : [];
    if (integrations.length) {
        note(report, RULES.AGENT_ENABLED_INTEGRATIONS, { integrations, count: integrations.length });
    }
    for (const [field, list] of [['knowledge_base_ids', config.knowledge_base_ids], ['attachedSkillIds', config.attachedSkillIds]]) {
        if (Array.isArray(list) && list.length) {
            note(report, RULES.AGENT_RESOURCE_REFERENCE, { field, count: list.length });
        }
    }
    noteUnlisted(report, 'agent.config', config, AGENT_CONFIG_ALLOWED,
        ['enabledIntegrations', 'knowledge_base_ids', 'attachedSkillIds', 'avatar']);

    // `embed_enabled` is absent from the payload rather than written as false:
    // createAgent has no parameter for it and the column defaults to FALSE, so
    // an installed agent is un-embeddable because there is nothing to say
    // otherwise. Reported so the omission is a decision on the record.
    for (const field of ['embedEnabled', 'embed_enabled', 'isPublished', 'is_published', 'sharedGroups', 'shared_groups',
        'organizationId', 'organization_id', 'ownerId', 'owner_id', 'categoryId', 'category_id',
        'rev', 'publishedVersion', 'published_version', 'publishedAt', 'published_at',
        'publishedConfig', 'published_config', 'publishedSystemPrompt', 'published_system_prompt']) {
        if (src[field] !== undefined && src[field] !== null && src[field] !== false) {
            note(report, RULES.AGENT_TENANT_IDENTITY, { field });
        }
    }

    noteUnlisted(report, 'agent', src, AGENT_ALLOWED, [
        'id', 'config', 'avatar', 'tools', 'tool_params', 'runtimeSource', 'projectId', 'project_id',
        'system_prompt', 'starter_prompts', 'threads_enabled', 'copy_enabled', 'workspace_enabled',
        'embedEnabled', 'embed_enabled', 'isPublished', 'is_published', 'sharedGroups', 'shared_groups',
        'organizationId', 'organization_id', 'ownerId', 'owner_id', 'categoryId', 'category_id',
        'rev', 'publishedVersion', 'published_version', 'publishedAt', 'published_at', 'publishedRev', 'published_rev',
        'publishedConfig', 'published_config', 'publishedSystemPrompt', 'published_system_prompt',
        'createdAt', 'created_at', 'updatedAt', 'updated_at',
    ]);

    return { payload, report };
}

/** A knowledge base travels as a SHELL — the same shape `duplicate` creates. */
const KNOWLEDGE_BASE_ALLOWED = ['name', 'description', 'icon', 'usageContexts'];

function captureKnowledgeBaseShape(kb, report = []) {
    const src = isObject(kb) ? kb : {};
    let usageContexts = src.usageContexts ?? src.usage_contexts;
    if (typeof usageContexts === 'string') {
        try { usageContexts = JSON.parse(usageContexts); } catch { usageContexts = null; }
    }

    const payload = {
        name: src.name || '',
        description: src.description || '',
        icon: src.icon || null,
    };
    if (Array.isArray(usageContexts)) {
        payload.usageContexts = usageContexts.filter(c => typeof c === 'string');
    }

    // Always reported: a base always HAS content, and "the documents did not
    // travel" is what whoever installs it needs to be told.
    note(report, RULES.KNOWLEDGE_BASE_CONTENT, { name: payload.name });
    for (const field of ['tenantId', 'tenant_id', 'organizationId', 'organization_id',
        'categoryId', 'category_id', 'isPublished', 'is_published', 'sharedGroups', 'shared_groups']) {
        if (src[field] !== undefined && src[field] !== null && src[field] !== false) {
            note(report, RULES.KNOWLEDGE_BASE_TENANT_IDENTITY, { field });
        }
    }
    noteUnlisted(report, 'knowledge_base', src, KNOWLEDGE_BASE_ALLOWED, [
        'id', 'usage_contexts', 'tenantId', 'tenant_id', 'organizationId', 'organization_id',
        'categoryId', 'category_id', 'isPublished', 'is_published', 'sharedGroups', 'shared_groups',
        'projectId', 'createdAt', 'created_at', 'updatedAt', 'updated_at',
    ]);

    return { payload, report };
}

/**
 * A webpage's bridge grants, rebuilt from an allow-list.
 *
 * Two leaks lived in the old spread-and-patch version of this, in the same
 * three lines: `integrations[].fixedArgs` was stripped by hand while
 * `automations[]` used `{ ...g, automationId: null }` — which carries every
 * other key a grant has now or gains later — and the whole `ai` block was
 * cloned verbatim, `publicEnabled` and `publicSpendCapUsd` included.
 *
 * The `ai` block is dropped ENTIRELY rather than clamped. It holds no author
 * work worth carrying (an enable flag, a grounding flag, a tier, a spend cap),
 * and its public half decides whether anonymous visitors may spend the
 * installer's AI budget. The store's own default — public off — is what the
 * installed page gets, and install.js writes that default rather than the file.
 */
function captureBridgeGrants(grants, report = []) {
    const src = isObject(grants) ? grants : {};
    const out = { automations: [], integrations: [] };

    if (isObject(src.ai)) note(report, RULES.WEBPAGE_PUBLIC_AI, { fields: Object.keys(src.ai) });

    if (Array.isArray(src.automations)) {
        for (const g of src.automations) {
            if (!isObject(g)) continue;
            const entry = {};
            // A $ref put here by the rewrite is an in-bundle pointer and must
            // survive; anything else is an id from another installation and is
            // nulled like every other unresolvable reference.
            entry.automationId = isObject(g.automationId) && typeof g.automationId.$ref === 'string'
                ? g.automationId : null;
            if (typeof g.label === 'string') entry.label = g.label;
            noteUnlisted(report, 'webpage.bridge_grants.automation', g, ['automationId', 'label']);
            out.automations.push(entry);
        }
    }
    if (Array.isArray(src.integrations)) {
        for (const g of src.integrations) {
            if (!isObject(g)) continue;
            if (g.fixedArgs !== undefined) note(report, RULES.WEBPAGE_BRIDGE_ARGUMENTS, { tool: g.tool || null });
            const entry = { tool: typeof g.tool === 'string' ? g.tool : null };
            if (typeof g.label === 'string') entry.label = g.label;
            noteUnlisted(report, 'webpage.bridge_grants.integration', g, ['tool', 'label'], ['fixedArgs']);
            out.integrations.push(entry);
        }
    }
    noteUnlisted(report, 'webpage.bridge_grants', src, ['automations', 'integrations'], ['ai']);
    return { payload: out, report };
}

module.exports = {
    RULES,
    RULE_WHY,
    APP_SEAT_FIELDS,
    APP_SEAT_LISTS,
    AUTOMATION_SEAT_FIELDS,
    scrubAppDefinition,
    scrubAutomationDefinition,
    // Allow-list builders (the three kinds that travel as a shape)
    DATATABLE_ALLOWED, DATATABLE_COLUMN_FIELDS, AGENT_ALLOWED, AGENT_CONFIG_ALLOWED, KNOWLEDGE_BASE_ALLOWED,
    captureDatatableShape, captureAgentShape, captureKnowledgeBaseShape, captureBridgeGrants,
};
