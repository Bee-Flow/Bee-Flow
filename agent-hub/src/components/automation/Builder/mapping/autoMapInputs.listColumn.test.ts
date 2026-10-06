// @vitest-environment node
/**
 * A LIST input gets a column of an upstream list of records: Gmail "Read
 * many" below "Search" gets `messageIds = steps.search.output.results[*].id`
 * (the id of every result; the runtime's `[*]` maps and flattens). Auto-map
 * used to leave it empty: a column never fills a one-value input, and that
 * rule kept it out of list inputs too. A one-value input still never gets a
 * column, and a list input never gets one scalar.
 */
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { applyAutoMapToStep, autoMapInputs } from './autoMapInputs';
import { idsBase, isPluralOf } from './autoMapListInput';
import { buildRealOutputMap } from './realOutputs';
import { scorePair } from './schemaMatch';
import { computeUpstreamGroups } from './upstream';
import { computeLoopBodyGroups } from './upstream/groups';

// The catalog's output samples, as the server hands them to the builder.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const require_ = createRequire(import.meta.url);
const { OUTPUT_SCHEMAS } = require_(path.resolve(HERE, '../../../../../../server/automation/outputSchemas.js')) as {
    OUTPUT_SCHEMAS: Record<string, { sample: unknown }>;
};

const ids = (key: string) => ({ type: 'array', items: { type: 'string' }, description: `${key} (e.g. the \`id\` of every gmail_search result).` });
// The input schemas of server/integrations/gmailTools.js and outlookTools.js
// (that module cannot load here: it opens the user store).
const INPUTS: Record<string, object> = {
    gmail_search: { properties: { query: { type: 'string' }, maxResults: { type: 'number' } }, required: ['query'] },
    gmail_read: { properties: { messageId: { type: 'string' } }, required: ['messageId'] },
    gmail_read_many: { properties: { messageIds: ids('messageIds') }, required: ['messageIds'] },
    gmail_bulk_modify: {
        properties: {
            messageIds: ids('messageIds'),
            addLabelIds: { type: 'array', items: { type: 'string' }, description: 'Labels (names or IDs) to add to every message.' },
            removeLabelIds: { type: 'array', items: { type: 'string' }, description: 'Labels (names or IDs) to remove from every message.' },
            markRead: { type: 'boolean' }, markUnread: { type: 'boolean' }, archive: { type: 'boolean' },
        },
        required: ['messageIds'],
    },
    outlook_search: { properties: { query: { type: 'string' }, maxResults: { type: 'integer' } }, required: ['query'] },
    outlook_read_many: { properties: { messageIds: ids('messageIds') }, required: ['messageIds'] },
};
const TOOLS = Object.keys(INPUTS);
const CATALOG = {
    apps: [{ id: 'mail', actions: TOOLS.map(name => ({ name, inputSchema: INPUTS[name], outputSample: OUTPUT_SCHEMAS[name]?.sample })) }],
    triggerOutputs: { __manual: { fields: [], sample: {} } },
};

// Screenshot 6: what the pinned Search step returned.
const record = (id: string, subject: string) => ({
    id, to: 'me@example.nl', date: 'Tue, 06 Oct 2026 03:42:53 +0000 (UTC)', from: 'Je MoveMove <no-reply@movemove.com>',
    isBulk: false, snippet: 'Hierbij ontvangt u de specificaties', subject, precedence: null, hasListUnsubscribe: false,
});
const PINNED = {
    query: '((has:attachment filename:pdf factuur) movemove factuur)', total: 201,
    results: [record('1a10f4ea7f6d46a2', 'Factuur 1'), record('1a0eb272a8c8478c', 'Factuur 2'), record('19f0', 'Factuur 3'), record('19e1', 'Factuur 4')],
};

type Step = { id: string; type: string; tool?: string; inputs?: Record<string, unknown>; forEach?: object; pinnedOutput?: unknown };

/** trigger → <steps…> in a chain; the last one is mapped. */
function chain(steps: Step[]) {
    const all = steps.map(s => ({ inputs: {}, ...s }));
    const ids = ['trg', ...all.map(s => s.id)];
    return {
        trigger: { id: 'trg', type: 'trigger', kind: 'manual' },
        steps: all,
        edges: ids.slice(1).map((to, i) => ({ from: ids[i], to })),
    };
}

/** The Auto-map button: autoMapInputs over the groups the inspector builds (pinned outputs folded in). */
function autoMapButton(def: ReturnType<typeof chain>, stepId: string, catalog: object = CATALOG): Record<string, unknown> {
    const step = def.steps.find(s => s.id === stepId)!;
    // The JS signature defaults the map to null, so its inferred type is null.
    const groups = computeUpstreamGroups(def, stepId, catalog, buildRealOutputMap(def, []) as never);
    const schema = (catalog as typeof CATALOG).apps.flatMap(a => a.actions).find(a => a.name === step.tool)?.inputSchema || null;
    return autoMapInputs(schema, step.inputs || {}, groups) as Record<string, unknown>;
}

const search: Step = { id: 'search', type: 'integration_action', tool: 'gmail_search', pinnedOutput: PINNED };
const ref = (p: string) => ({ kind: 'ref', path: p });

describe('a list input gets a column of an upstream list', () => {
    it('Read many below a pinned Search: messageIds is the id of every result (the screenshot)', () => {
        const def = chain([search, { id: 'many', type: 'integration_action', tool: 'gmail_read_many' }]);
        expect(autoMapButton(def, 'many')).toEqual({ messageIds: ref('steps.search.output.results[*].id') });
        const { definition, mappedKeys, forEachEnabled } = applyAutoMapToStep(def, 'many', CATALOG, { realOutputById: buildRealOutputMap(def, []) });
        expect(mappedKeys).toEqual(['messageIds']);
        expect(forEachEnabled).toBe(false);
        const step = definition.steps.find((s: Step) => s.id === 'many');
        expect(step.inputs).toEqual({ messageIds: ref('steps.search.output.results[*].id') });
        expect(step.forEach).toBeUndefined();
        expect(step.autoMapped).toEqual(['messageIds']);
    });

    it('also from the catalog sample, before anything ran', () => {
        const def = chain([{ id: 'search', type: 'integration_action', tool: 'gmail_search' }, { id: 'many', type: 'integration_action', tool: 'gmail_read_many' }]);
        expect(autoMapButton(def, 'many')).toEqual({ messageIds: ref('steps.search.output.results[*].id') });
    });

    it('bulk modify: the message ids, never a label list', () => {
        const def = chain([search, { id: 'bulk', type: 'integration_action', tool: 'gmail_bulk_modify' }]);
        expect(autoMapButton(def, 'bulk')).toEqual({ messageIds: ref('steps.search.output.results[*].id') });
    });

    it('Outlook read many below Outlook search', () => {
        const def = chain([{ id: 'os', type: 'integration_action', tool: 'outlook_search' }, { id: 'many', type: 'integration_action', tool: 'outlook_read_many' }]);
        expect(autoMapButton(def, 'many')).toEqual({ messageIds: ref('steps.os.output.results[*].id') });
    });

    it('the nearest step wins: below a per-mail read, the id of every read mail', () => {
        const def = chain([
            search,
            { id: 'rd', type: 'integration_action', tool: 'gmail_read', inputs: { messageId: ref('loop.result.id') }, forEach: { overRef: 'steps.search.output.results', itemVar: 'result', maxIterations: 100 } },
            { id: 'many', type: 'integration_action', tool: 'gmail_bulk_modify' },
        ]);
        expect(autoMapButton(def, 'many')).toEqual({ messageIds: ref('steps.rd.output.results[*].output.id') });
    });

    it('an outer list before a list inside it: the mails, not their attachments\' messageId', () => {
        const def = chain([
            { id: 'search', type: 'integration_action', tool: 'gmail_search' },
            { id: 'rm', type: 'integration_action', tool: 'gmail_read_many', inputs: { messageIds: ref('steps.search.output.results[*].id') } },
            { id: 'bulk', type: 'integration_action', tool: 'gmail_bulk_modify' },
        ]);
        expect(autoMapButton(def, 'bulk')).toEqual({ messageIds: ref('steps.rm.output.messages[*].id') });
    });
});

/** One generic tool below a step that returned `output`. */
function generic(output: unknown, properties: Record<string, object>, inputs: Record<string, unknown> = {}) {
    const catalog = {
        apps: [{ actions: [{ name: 'source', outputSample: output }, { name: 'target', inputSchema: { properties, required: [] } }] }],
        triggerOutputs: { __manual: { fields: [], sample: {} } },
    };
    const def = chain([{ id: 'x', type: 'integration_action', tool: 'source' }, { id: 'y', type: 'integration_action', tool: 'target', inputs }]);
    return autoMapButton(def, 'y', catalog);
}
const list = (items: object = { type: 'string' }) => ({ type: 'array', items });

describe('plural names', () => {
    const CONTACTS = { contacts: [{ id: 'c1', email: 'a@x.nl', subject: 'Hi' }, { id: 'c2', email: 'b@x.nl', subject: 'Yo' }] };

    it('a list input named for many of a field gets that column', () => {
        expect(generic(CONTACTS, { ids: list(), emails: list(), subjects: list() })).toEqual({
            ids: ref('steps.x.output.contacts[*].id'),
            emails: ref('steps.x.output.contacts[*].email'),
            subjects: ref('steps.x.output.contacts[*].subject'),
        });
    });

    it('an upstream list with the input\'s own name still wins', () => {
        const out = { emails: ['a@x.nl', 'b@x.nl'], contacts: [{ email: 'c@x.nl' }] };
        expect(generic(out, { emails: list() })).toEqual({ emails: ref('steps.x.output.emails') });
        expect(generic({ recipients: ['a@x.nl'] }, { recipients: list() })).toEqual({ recipients: ref('steps.x.output.recipients') });
    });

    it('names that do not relate stay empty', () => {
        expect(generic(CONTACTS, { channelIds: list(), recipients: list(), tags: list() })).toEqual({});
        expect(generic({ results: [{ id: 'r1', title: 'x' }] }, { messageIds: list() })).toEqual({});
    });

    it('a column only when its values fit the list\'s items', () => {
        expect(generic(CONTACTS, { ids: list({ type: 'object' }) })).toEqual({});
        expect(generic({ rows: [{ id: 1 }] }, { ids: list({ type: 'number' }) })).toEqual({ ids: ref('steps.x.output.rows[*].id') });
    });

    it('a list the step outputs as a whole', () => {
        expect(generic([{ id: 'a' }, { id: 'b' }], { ids: list() })).toEqual({ ids: ref('steps.x.output[*].id') });
    });

    it('a field the author set is never overwritten', () => {
        expect(generic(CONTACTS, { ids: list() }, { ids: { kind: 'literal', value: ['z'] } })).toEqual({});
    });
});

describe('the one-value rules stay', () => {
    it('a one-value input never gets a column', () => {
        const patch = generic({ results: [record('m1', 'x')] }, { messageId: { type: 'string' }, subject: { type: 'string' } });
        expect(Object.values(patch).some(b => String((b as { path: string }).path).includes('[*]'))).toBe(false);
        expect(patch.messageId).toBeUndefined();
    });

    it('a one-value input below a list still runs per item on connect', () => {
        const def = chain([search, { id: 'rd', type: 'integration_action', tool: 'gmail_read' }]);
        const { definition } = applyAutoMapToStep(def, 'rd', CATALOG, { realOutputById: buildRealOutputMap(def, []) });
        const step = definition.steps.find((s: Step) => s.id === 'rd');
        expect(step.inputs).toEqual({ messageId: ref('loop.result.id') });
        expect(step.forEach).toEqual({ overRef: 'steps.search.output.results', itemVar: 'result', maxIterations: 100 });
    });

    it('a list input never gets one scalar', () => {
        expect(generic({ sender: 'a@x.nl' }, { emails: list() })).toEqual({});
        expect(scorePair({ key: 'emails', type: 'array' }, { key: 'sender', path: 'steps.x.output.sender', sample: 'a@x.nl', groupIndex: 0 }, 0)).toBe(0);
        expect(scorePair({ key: 'fileUrls', type: ['array', 'null'] }, { key: 'link', path: 'steps.x.output.link', sample: 'https://x.nl', groupIndex: 0 }, 0)).toBe(0);
    });

    it('a step that runs once per item keeps its list inputs for the author', () => {
        const def = chain([search, { id: 'bulk', type: 'integration_action', tool: 'gmail_bulk_modify', forEach: { overRef: 'steps.search.output.results', itemVar: 'result', maxIterations: 100 } }]);
        expect(autoMapButton(def, 'bulk').messageIds).toBeUndefined();
    });
});

describe('the name helpers', () => {
    it.each([
        ['emails', 'email', true], ['ids', 'id', true], ['fileIds', 'file_id', true], ['addresses', 'address', true],
        ['entries', 'entry', true], ['recipients', 'recipient', true], ['email', 'email', false], ['messageIds', 'id', false], ['ids', '', false],
    ])('isPluralOf(%s, %s) = %s', (key, field, want) => {
        expect(isPluralOf(key, field)).toBe(want);
    });

    it.each([['messageIds', 'message'], ['message_ids', 'message'], ['fileIDs', 'file'], ['ids', null], ['messageId', null]])('idsBase(%s) = %s', (key, want) => {
        expect(idsBase(key)).toBe(want);
    });
});

/** `target` connected below a step `x` that returned `output`: what auto-map writes on connect. */
function connect(output: unknown, inputSchema: { properties: Record<string, object>; required: string[] }) {
    const catalog = {
        apps: [{ actions: [{ name: 'source', outputSample: output }, { name: 'target', inputSchema }] }],
        triggerOutputs: { __manual: { fields: [], sample: {} } },
    };
    const def = chain([{ id: 'x', type: 'integration_action', tool: 'source' }, { id: 'y', type: 'integration_action', tool: 'target' }]);
    const { definition, forEachEnabled } = applyAutoMapToStep(def, 'y', catalog, { realOutputById: buildRealOutputMap(def, []) });
    const step = definition.steps.find((s: Step) => s.id === 'y');
    return { inputs: (step.inputs || {}) as Record<string, { path?: string }>, forEach: step.forEach, forEachEnabled };
}
const columns = (inputs: Record<string, { path?: string }>) => Object.keys(inputs).filter(k => String(inputs[k]?.path || '').includes('[*]'));

// server/integrations/nextcloudContactsTools.js
const CONTACT_FIELDS = {
    addressbook: { type: 'string' }, uid: { type: 'string' }, fullName: { type: 'string' },
    emails: list(), phones: list(), organization: { type: 'string' },
};
const CONTACTS_UPDATE = { properties: CONTACT_FIELDS, required: ['addressbook', 'uid'] };
const CONTACTS_CREATE = { properties: (({ uid: _uid, ...rest }) => rest)(CONTACT_FIELDS), required: ['addressbook', 'fullName'] };

describe('a step that runs once per item never also gets every row', () => {
    it('contacts update below a list of contacts runs per contact, without every contact\'s emails and phones', () => {
        const out = { contacts: [{ uid: 'u1', fullName: 'An', email: 'an@x.nl', phone: '06-1' }, { uid: 'u2', fullName: 'Bo', email: 'bo@x.nl', phone: '06-2' }] };
        const { inputs, forEach, forEachEnabled } = connect(out, CONTACTS_UPDATE);
        expect(forEachEnabled).toBe(true);
        expect(forEach).toMatchObject({ overRef: 'steps.x.output.contacts', itemVar: 'contact' });
        expect(inputs.uid).toEqual(ref('loop.contact.uid'));
        expect(columns(inputs)).toEqual([]);
        expect(inputs.emails).toBeUndefined();
        expect(inputs.phones).toBeUndefined();
    });

    it('contacts create below a list of people: one contact per person, no column', () => {
        const out = { people: [{ fullName: 'An', email: 'an@x.nl', phone: '06-1' }, { fullName: 'Bo', email: 'bo@x.nl', phone: '06-2' }] };
        const { inputs, forEachEnabled } = connect(out, CONTACTS_CREATE);
        expect(forEachEnabled).toBe(true);
        expect(inputs.fullName).toEqual(ref('loop.people.fullName'));
        expect(columns(inputs)).toEqual([]);
    });

    it('a step that runs once still gets the column on connect', () => {
        const { inputs, forEachEnabled } = connect({ contacts: [{ uid: 'u1', email: 'an@x.nl' }] }, { properties: { emails: list() }, required: ['emails'] });
        expect(forEachEnabled).toBe(false);
        expect(inputs).toEqual({ emails: ref('steps.x.output.contacts[*].email') });
    });
});

describe('a step inside a Loop body', () => {
    /** Search → Loop over its results (itemVar `result`) with `bodyStep` as the body's first step. */
    function bodyAutoMap(bodyStep: Step, { batchSize = 1, source = search, overRef = 'steps.search.output.results', itemVar = 'result', catalog = CATALOG as object } = {}) {
        const loop = { id: 'lp', type: 'loop', overRef, itemVar, batchSize, body: [bodyStep] };
        const def = chain([source, loop as unknown as Step]);
        const outer = computeUpstreamGroups(def, 'lp', catalog, buildRealOutputMap(def, []) as never);
        const preview = { steps: { [source.id]: { output: source.pinnedOutput } } };
        const groups = computeLoopBodyGroups(loop, 0, outer, preview, catalog, def);
        const schema = (catalog as typeof CATALOG).apps.flatMap(a => a.actions).find(a => a.name === bodyStep.tool)?.inputSchema || null;
        return autoMapInputs(schema, bodyStep.inputs || {}, groups) as Record<string, { path?: string }>;
    }

    it('bulk modify in the body never takes every search result (each iteration would change all of them)', () => {
        const patch = bodyAutoMap({ id: 'b', type: 'integration_action', tool: 'gmail_bulk_modify' });
        expect(patch.messageIds).toBeUndefined();
        expect(columns(patch)).toEqual([]);
    });

    it('read many in the body: no column from outside the loop', () => {
        expect(columns(bodyAutoMap({ id: 'b', type: 'integration_action', tool: 'gmail_read_many' }))).toEqual([]);
    });

    it('contacts update in the body: the contact\'s own uid, never everyone\'s emails', () => {
        const people = { contacts: [{ uid: 'u1', fullName: 'An', email: 'an@x.nl', phone: '06-1' }, { uid: 'u2', fullName: 'Bo', email: 'bo@x.nl', phone: '06-2' }] };
        const catalog = {
            apps: [{ actions: [{ name: 'source', outputSample: people }, { name: 'nextcloud_contacts_update', inputSchema: CONTACTS_UPDATE }] }],
            triggerOutputs: { __manual: { fields: [], sample: {} } },
        };
        const patch = bodyAutoMap({ id: 'b', type: 'integration_action', tool: 'nextcloud_contacts_update' }, {
            source: { id: 'src', type: 'integration_action', tool: 'source', pinnedOutput: people }, overRef: 'steps.src.output.contacts', itemVar: 'contact', catalog,
        });
        expect(patch.uid).toEqual(ref('loop.contact.uid'));
        expect(columns(patch)).toEqual([]);
    });

    it('a batched loop: the column of the batch itself', () => {
        expect(bodyAutoMap({ id: 'b', type: 'integration_action', tool: 'gmail_bulk_modify' }, { batchSize: 5 })).toEqual({ messageIds: ref('loop.result[*].id') });
    });

    it('a list inside the current item is still a column', () => {
        const mails = { mails: [{ id: 'm1', subject: 'x', from: 'a@x.nl', attachments: [{ attachmentId: 'a1', filename: 'f.pdf' }] }] };
        const catalog = {
            apps: [{ actions: [{ name: 'source', outputSample: mails }, { name: 'target', inputSchema: { properties: { attachmentIds: list() }, required: [] } }] }],
            triggerOutputs: { __manual: { fields: [], sample: {} } },
        };
        const patch = bodyAutoMap({ id: 'b', type: 'integration_action', tool: 'target' }, {
            source: { id: 'src', type: 'integration_action', tool: 'source', pinnedOutput: mails }, overRef: 'steps.src.output.mails', itemVar: 'mail', catalog,
        });
        expect(patch).toEqual({ attachmentIds: ref('loop.mail.attachments[*].attachmentId') });
    });
});

describe('below ONE mail, never a back-reference or a farther list', () => {
    const readOne = (pinnedOutput?: unknown): Step => ({ id: 'rd', type: 'integration_action', tool: 'gmail_read', inputs: { messageId: ref('steps.search.output.results[0].id') }, ...(pinnedOutput ? { pinnedOutput } : {}) });

    it('search → read one → bulk modify: not the attachments\' messageId', () => {
        const def = chain([search, readOne(), { id: 'bulk', type: 'integration_action', tool: 'gmail_bulk_modify' }]);
        expect(autoMapButton(def, 'bulk')).toEqual({});
        const { mappedKeys } = applyAutoMapToStep(def, 'bulk', CATALOG, { realOutputById: buildRealOutputMap(def, []) });
        expect(mappedKeys).toEqual([]);
    });

    it('a read mail without attachments: not every search result either', () => {
        const mail = { id: 'm1', threadId: 't1', from: 'a@x.nl', to: 'me@x.nl', subject: 'Factuur', date: 'x', body: 'x', attachments: [] };
        const def = chain([search, readOne(mail), { id: 'bulk', type: 'integration_action', tool: 'gmail_bulk_modify' }]);
        expect(autoMapButton(def, 'bulk')).toEqual({});
    });

    it('read one (literal id) → read many: stays empty', () => {
        const def = chain([{ id: 'rd', type: 'integration_action', tool: 'gmail_read', inputs: { messageId: { kind: 'literal', value: 'm1' } } }, { id: 'many', type: 'integration_action', tool: 'gmail_read_many' }]);
        expect(autoMapButton(def, 'many')).toEqual({});
    });

    it('a new-mail trigger shape (messageId, no id) with attachments: stays empty', () => {
        const trig = { messageId: 'm1', threadId: 't1', from: 'a@x.nl', subject: 'Factuur', attachments: [{ attachmentId: 'a1', filename: 'f.pdf', messageId: 'm1' }] };
        expect(generic(trig, { messageIds: list() })).toEqual({});
    });

    it('a foreign key on a list that is not inside one such record is still a column', () => {
        expect(generic({ total: 2, shares: [{ shareId: 's1', fileId: 'f1' }, { shareId: 's2', fileId: 'f2' }] }, { fileIds: list() }))
            .toEqual({ fileIds: ref('steps.x.output.shares[*].fileId') });
    });
});

describe('a list input with allowed values', () => {
    const MEMORY_TYPES = ['person', 'preference', 'fact', 'project', 'workflow', 'instruction'];

    it('labels\' type (system/user) never fills memory_search.types', () => {
        expect(generic(OUTPUT_SCHEMAS.gmail_list_labels?.sample, { types: list({ type: 'string', enum: MEMORY_TYPES }) })).toEqual({});
    });

    it('a column whose values are allowed still fills it', () => {
        expect(generic({ memories: [{ id: 'm1', type: 'fact' }] }, { types: list({ type: 'string', enum: MEMORY_TYPES }) }))
            .toEqual({ types: ref('steps.x.output.memories[*].type') });
    });
});
