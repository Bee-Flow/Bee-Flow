// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { readBlueprint, buildResolutions, addressOf, CREATE_EMPTY } from './installRequirements';

/**
 * Reading a Blueprint before installing it.
 *
 * Three things are worth pinning, and all three are about honesty rather than
 * about parsing:
 *
 *   1. A HOLE IS RECOGNISED BY ITS EXACT SHAPE. `auth: null` is what the scrub
 *      leaves behind; a step that never had a credential has no `auth` key.
 *      Asking about the second would send somebody hunting for a credential
 *      the automation does not want.
 *   2. WHAT THE FILE ASKS FOR IS SHOWN, NEVER PRE-TICKED. The wizard's Connect
 *      step lists the tools a page asked for; the installer grants them, and a
 *      file cannot grant them by arriving.
 *   3. ONLY A COMPLETE ANSWER TRAVELS. A resolutions body is built from the
 *      requirement ROWS, so an answer left over from a file that was swapped
 *      out cannot ride along with the next one.
 */

const automation = (ref, steps, over = {}) => ({
    ref, kind: 'automation', title: `Automation ${ref}`,
    definition: { schemaVersion: 2, trigger: { id: 't', type: 'trigger' }, steps, ...over },
});

const blueprint = (entities, over = {}) => ({
    format: 'beeflow.blueprint',
    solution: {
        key: 'sol_1', version: 2, name: 'Onboarding', description: 'A thing',
        entities: { automations: [], apps: [], webpages: [], datatables: [], agents: [], knowledgeBases: [], ...entities },
        ...over,
    },
});

describe('what is in the file', () => {
    it('counts the entities themselves, not what the report claims', () => {
        // The report is the exporter's claim; the entity arrays are the file.
        const read = readBlueprint(blueprint(
            { automations: [automation('aut_1', []), automation('aut_2', [])] },
            { report: { counts: { automations: 99 }, warnings: [] } },
        ));
        expect(read.counts.automations).toBe(2);
        expect(read.counts.webpages).toBe(0);
    });

    it('carries the exporter\'s own "what this does not bring" list through untouched', () => {
        const read = readBlueprint(blueprint({}, {
            report: { warnings: ['App table data is never carried.', 42, 'A page\'s stored data stays behind.'] },
        }));
        expect(read.notCarried).toEqual([
            'App table data is never carried.',
            'A page\'s stored data stays behind.',
        ]);
    });

    it('a file that is not a Blueprint is refused, and an empty one is not', () => {
        for (const junk of [null, undefined, {}, { solution: 'text' }, [], 'nope']) {
            expect(readBlueprint(junk).ok).toBe(false);
        }
        expect(readBlueprint(blueprint({})).ok).toBe(true);
    });
});

describe('what the installer has to supply', () => {
    it('asks for a table only when the Blueprint does not bring one with that key', () => {
        const steps = [
            { id: 's1', type: 'datatable', datatableId: '', datatableKey: 'invoices' },
            { id: 's2', type: 'datatable', datatableId: '', datatableKey: 'contacts' },
        ];
        const read = readBlueprint(blueprint({
            automations: [automation('aut_1', steps)],
            datatables: [{ ref: 'dt_1', key: 'invoices', name: 'Invoices' }],
        }));
        expect(read.requires.tables.map(t => t.key)).toEqual(['contacts']);
    });

    it('never asks about a step that already names a table', () => {
        const read = readBlueprint(blueprint({
            automations: [automation('aut_1', [
                { id: 's1', type: 'datatable', datatableId: 'tbl_live', datatableKey: 'invoices' },
            ])],
        }));
        expect(read.requires.tables).toEqual([]);
    });

    it('a table step with no key at all is not a question anybody can answer', () => {
        // "Pick a table" with nothing to say which one is not a question. The
        // install report names that step instead.
        const read = readBlueprint(blueprint({
            automations: [automation('aut_1', [{ id: 's1', type: 'datatable', datatableId: '' }])],
        }));
        expect(read.requires.tables).toEqual([]);
    });

    it('one key asked for by two steps is ONE row, naming both', () => {
        const read = readBlueprint(blueprint({
            automations: [
                automation('aut_1', [{ id: 's1', type: 'datatable', datatableId: '', datatableKey: 'invoices' }]),
                automation('aut_2', [{ id: 's9', type: 'datatable', datatableId: '', datatableKey: 'invoices' }]),
            ],
        }));
        expect(read.requires.tables).toHaveLength(1);
        expect(read.requires.tables[0].steps.map(s => s.ref)).toEqual(['aut_1', 'aut_2']);
    });

    it('A CONNECTION IS ASKED ABOUT ONLY WHERE THE SCRUB REMOVED ONE', () => {
        // `auth: null` is the scrub's fingerprint. A step that never had a
        // credential has no `auth` key, and asking about it would send somebody
        // looking for something the automation does not want.
        const read = readBlueprint(blueprint({
            automations: [automation('aut_1', [
                { id: 's1', type: 'http_request', auth: null },
                { id: 's2', type: 'http_request' },
                { id: 's3', type: 'http_request', auth: { connectionId: 'conn_theirs' } },
            ])],
        }));
        expect(read.requires.connections.map(c => c.stepId)).toEqual(['s1']);
    });

    it('an approval nobody is seated on is a row; one with any seat is not', () => {
        for (const field of ['assignee', 'approvers', 'escalateTo', 'finalApprover']) {
            const seated = field === 'approvers' ? [{ userId: 'u1' }] : { userId: 'u1' };
            const read = readBlueprint(blueprint({
                automations: [automation('aut_1', [
                    { id: 'open', type: 'approval', approval: { details: 'Sign off?' } },
                    { id: 'taken', type: 'approval', approval: { [field]: seated } },
                ])],
            }));
            expect(read.requires.approvers.map(a => a.stepId)).toEqual(['open']);
        }
    });

    it('reaches a step inside a flowlet, a loop body and a branch', () => {
        const read = readBlueprint(blueprint({
            automations: [automation('aut_1',
                [
                    { id: 'loop', type: 'loop', body: [{ id: 'inLoop', type: 'http_request', auth: null }] },
                    { id: 'split', type: 'parallel', branches: [[{ id: 'inBranch', type: 'http_request', auth: null }]] },
                ],
                { layers: { enrich: { steps: [{ id: 'inLayer', type: 'http_request', auth: null }] } } },
            )],
        }));
        expect(read.requires.connections.map(c => [c.stepId, c.layerKey])).toEqual([
            ['inLoop', null], ['inBranch', null], ['inLayer', 'enrich'],
        ]);
    });
});

describe('what the file ASKS to be allowed to do', () => {
    const page = (bridgeGrants) => ({ ref: 'web_1', name: 'Status', bridgeGrants });

    it('lists the tool by name and NEVER its pinned arguments', () => {
        const read = readBlueprint(blueprint({
            webpages: [page({ integrations: [{ tool: 'gmail_send', fixedArgs: { to: 'LEAK-CANARY@example.test' } }] })],
        }));
        expect(read.grants).toEqual([{ ref: 'web_1', name: 'Status', kind: 'integration', tool: 'gmail_send' }]);
        expect(JSON.stringify(read)).not.toContain('LEAK-CANARY');
    });

    it('shows a public-AI request, including one nobody has invented yet', () => {
        const read = readBlueprint(blueprint({
            webpages: [page({ ai: { enabled: true, publicEnabled: true, publicSpendCapUsd: 50, publicSomethingNew: true } })],
        }));
        const row = read.grants.find(r => r.kind === 'public_ai');
        expect(row.flags).toEqual({ publicEnabled: true, publicSpendCapUsd: 50, publicSomethingNew: true });
    });

    it('a cap or a tier on its own opens no door, so it is not a request', () => {
        const read = readBlueprint(blueprint({
            webpages: [page({ ai: { enabled: true, publicSpendCapUsd: 50, publicDefaultTier: 'fast' } })],
        }));
        expect(read.grants).toEqual([]);
    });

    it('an automation grant pointing INSIDE the bundle is not something to re-assign', () => {
        const read = readBlueprint(blueprint({
            automations: [automation('aut_1', [])],
            webpages: [
                page({ automations: [{ automationId: { $ref: 'aut_1' } }] }),
                { ref: 'web_2', name: 'Other', bridgeGrants: { automations: [{ automationId: 'aut_elsewhere' }] } },
            ],
        }));
        expect(read.grants).toEqual([{ ref: 'web_2', name: 'Other', kind: 'automation' }]);
    });
});

describe('what the wizard sends', () => {
    const requires = {
        tables: [{ key: 'invoices', steps: [] }, { key: 'contacts', steps: [] }],
        connections: [{ ref: 'aut_1', stepId: 's1', layerKey: null, title: 'R' }],
        approvers: [{ ref: 'aut_1', stepId: 's2', layerKey: 'enrich', title: 'R' }],
    };

    it('turns the answers into the body the server takes', () => {
        const body = buildResolutions(requires, {
            tables: { invoices: 'tbl_mine', contacts: CREATE_EMPTY },
            connections: { [addressOf('aut_1', 's1', null)]: 'conn_mine' },
            approvers: { [addressOf('aut_1', 's2', 'enrich')]: 'group:g_finance' },
        });
        expect(body).toEqual({
            tables: [{ key: 'invoices', datatableId: 'tbl_mine' }, { key: 'contacts', create: true }],
            connections: [{ ref: 'aut_1', stepId: 's1', layerKey: null, connectionId: 'conn_mine' }],
            approvers: [{ ref: 'aut_1', stepId: 's2', layerKey: 'enrich', seat: { groupId: 'g_finance' } }],
        });
    });

    it('a question left unanswered sends nothing at all for that row', () => {
        expect(buildResolutions(requires, {})).toEqual({ tables: [], connections: [], approvers: [] });
        expect(buildResolutions(requires, {
            tables: { invoices: '' }, connections: { [addressOf('aut_1', 's1', null)]: '' },
        })).toEqual({ tables: [], connections: [], approvers: [] });
    });

    it('AN ANSWER TO A QUESTION THAT IS NO LONGER ASKED DOES NOT TRAVEL', () => {
        // Swap the file and the old answers are still in state. Driving off the
        // requirement rows is what stops them riding along.
        const body = buildResolutions(
            { tables: [], connections: [], approvers: [] },
            {
                tables: { invoices: 'tbl_from_the_last_file' },
                connections: { [addressOf('aut_1', 's1', null)]: 'conn_from_the_last_file' },
                approvers: { [addressOf('aut_1', 's2', 'enrich')]: 'user:u_from_the_last_file' },
            },
        );
        expect(body).toEqual({ tables: [], connections: [], approvers: [] });
    });

    it('a seat that names neither a person nor a group is dropped', () => {
        for (const bad of ['', 'nonsense', 'user:', ':u1', 'admin:u1', 'group:']) {
            const body = buildResolutions(requires, { approvers: { [addressOf('aut_1', 's2', 'enrich')]: bad } });
            expect(body.approvers).toEqual([]);
        }
    });

    it('a step address is a key, never something to take apart again', () => {
        // A ref or a step id from a hand-made file can hold any character; the
        // ids in the body come from the ROW, so a separator in a name cannot
        // point a resolution at the wrong step.
        const odd = {
            tables: [],
            connections: [{ ref: 'aut with space', stepId: 'step "quoted"', layerKey: 'a b' }],
            approvers: [],
        };
        const body = buildResolutions(odd, {
            connections: { [addressOf('aut with space', 'step "quoted"', 'a b')]: 'conn_1' },
        });
        expect(body.connections).toEqual([
            { ref: 'aut with space', stepId: 'step "quoted"', layerKey: 'a b', connectionId: 'conn_1' },
        ]);
    });
});

describe('wat het bestand over zijn eigen herkomst beweert', () => {
    // Een Blueprint komt van de schijf van de installateur. `source` is dus
    // invoer van buiten, en dit scherm is de TONENDE helft: het leest de
    // bewering, normaliseert hem, en gebruikt hem nergens voor.

    it('leest de bewering, met alle vier de velden', () => {
        const read = readBlueprint({
            ...blueprint({}),
            source: { blueprintId: 'bp_abc', orgId: 'org1', orgName: 'Acme', version: 3 },
        });
        expect(read.source).toEqual({ blueprintId: 'bp_abc', orgId: 'org1', orgName: 'Acme', version: 3 });
    });

    it('een bestand zonder herkomstblok beweert niets', () => {
        // Vier nulls in plaats van een ontbrekend veld: het scherm hoeft dan
        // nooit te raden tussen "geen bron" en "oud bestand".
        expect(readBlueprint(blueprint({})).source)
            .toEqual({ blueprintId: null, orgId: null, orgName: null, version: null });
    });

    it('alles wat geen string is wordt niets', () => {
        // Zoals een handgemaakt bestand het zou kunnen aanleveren. Zonder deze
        // normalisatie kan een object of een array in de render belanden.
        const read = readBlueprint({
            ...blueprint({}),
            source: { blueprintId: { $ref: 'aut_1' }, orgId: ['org1'], orgName: { toString: () => 'Acme' }, version: 'drie' },
        });
        expect(read.source).toEqual({ blueprintId: null, orgId: null, orgName: null, version: null });
    });

    it('een naam uit een bestand is begrensd', () => {
        // Een naam van tienduizend tekens is geen naam maar een lay-outaanval.
        const read = readBlueprint({
            ...blueprint({}),
            source: { orgName: 'A'.repeat(5000), orgId: '   ', version: 0 },
        });
        expect(read.source.orgName.length).toBe(200);
        expect(read.source.orgId).toBe(null);
        expect(read.source.version).toBe(null);
    });

    it('de bewering verandert niets aan wat er geïnstalleerd wordt', () => {
        // Het herkomstblok is geen entiteit en geen vereiste: het staat naast
        // de inhoud en mag er niets aan toevoegen of van afhalen.
        const plain = readBlueprint(blueprint({ automations: [automation('aut_1', [])] }));
        const claimed = readBlueprint({
            ...blueprint({ automations: [automation('aut_1', [])] }),
            source: { blueprintId: 'bp_van_iemand_anders', orgId: 'org_anders', orgName: 'Niet Wij' },
        });
        expect(claimed.counts).toEqual(plain.counts);
        expect(claimed.requires).toEqual(plain.requires);
        expect(claimed.grants).toEqual(plain.grants);
    });
});
