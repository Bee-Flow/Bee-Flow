// @typecheck
/**
 * The Teamwork helper's proposal (./coworkDeskHelper.mts) with a stub model: it offers only what the desk allows the
 * caller (their coworks, coworks shared with them by a colleague of their organisation, active colleagues), sends the
 * model the person's words, titles and display names under labels (never an id or an e-mail address), drops whatever
 * the model names outside the lists and reports those words as not found, counts against the Cowork budget, and
 * creates nothing.
 *
 * Run: cd server && node --test usecases/coworkDeskHelper.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { draftDesk } = require('./coworkDeskHelper.mts');
const { readProposal, MAX_STEPS, MAX_CROSSINGS, crossingsOf } = require('./coworkDeskHelperModel.mts');

const TEXT = 'When my supplier mails are done, Ben checks the invoices. Questions go to purchasing: Ben, or Lena when he is away.';

const USERS = {
    ann: { id: 'ann', organizationId: 'org-a', status: 'active', displayName: 'Ann' },
    ben: { id: 'ben', organizationId: 'org-a', status: 'active', displayName: 'Ben' },
    lena: { id: 'lena', organizationId: 'org-a', status: 'active', displayName: '', username: 'lena@example.org' },
    eve: { id: 'eve', organizationId: 'org-b', status: 'active', displayName: 'Eve' },
    lone: { id: 'lone', organizationId: '', status: 'active', displayName: 'Lone' },
};
const ITEMS = {
    'cw-mails': { id: 'cw-mails', userId: 'ann', title: 'Answer supplier mails', agentId: 'ag-1' },
    'cw-taken': { id: 'cw-taken', userId: 'ann', title: 'On another desk' },
    'cw-invoices': { id: 'cw-invoices', userId: 'ben', title: 'Invoice check', planAutomationId: 'pl-1' },
    'cw-eve': { id: 'cw-eve', userId: 'eve', title: 'Eve secret work' },
};

/**
 * Deps with a stub model that answers `answer`; `seen` records what reached the model and what was booked.
 * @param {unknown} answer
 * @param {{ model?: string | null, shieldThrows?: boolean, spent?: boolean }} [opts]
 */
function setup(answer, opts = {}) {
    /** @type {{ messages: any[], usage: any[], budget: any[], tool: any }} */
    const seen = { messages: [], usage: [], budget: [], tool: null };
    /** @type {import('./coworkDeskHelper.mts').HelperDeps} */
    const deps = {
        getUser: async (id) => /** @type {any} */ (USERS)[id] ?? null,
        listMembers: async (orgId) => Object.values(USERS).filter((u) => u.organizationId === orgId),
        getSchedule: async (id) => /** @type {any} */ (ITEMS)[id] ?? null,
        myCoworks: async (userId) => Object.values(ITEMS).filter((i) => i.userId === userId),
        // Eve's item is "shared" with Ann across organisations: the helper must still never offer it.
        sharedWithMe: async (userId) => (userId === 'ann' ? [{ id: 'cw-invoices', ownerId: 'ben', title: 'Invoice check' }, { id: 'cw-eve', ownerId: 'eve', title: 'Eve secret work' }] : []),
        membershipOf: async (id) => (id === 'cw-taken' ? { deskId: 'desk-other', deskOwnerId: 'ann', accepted: true } : null),
        spendLeft: async (item) => {
            seen.budget.push(item.id);
            if (opts.spent) throw Object.assign(new Error('Your organisation has used its Cowork AI budget for this month.'), { status: 409, code: 'cowork_budget_used' });
        },
        resolveModel: async () => (opts.model === undefined ? 'model-fast' : opts.model),
        shield: async () => { if (opts.shieldThrows) throw new Error('PII Detected: blocked'); },
        chat: async (_modelId, messages, tool) => { seen.messages = messages.map((m) => ({ ...m })); seen.tool = tool; return { structured: answer, usage: { input_tokens: 10 } }; },
        logUsage: (call) => { seen.usage.push(call); },
        now: () => 1000,
    };
    return { deps, seen };
}

const GOOD = {
    deskName: 'Supplier invoices',
    steps: [{ cowork: 'C1', words: 'my supplier mails' }, { cowork: 'C2', words: 'Ben checks the invoices' }],
    roles: [{ name: 'Purchasing', holder: 'P2', holderWords: 'Ben', standIn: 'P3' }],
};

test('a proposal from plain words: the chain in order, the role with its stand-in, and the choices for the dropdowns', async () => {
    const { deps, seen } = setup(GOOD);
    const p = await draftDesk({ userId: 'ann', text: TEXT }, deps);
    assert.strictEqual(p.drafted, true);
    assert.strictEqual(p.deskId, null);
    assert.strictEqual(p.deskName, 'Supplier invoices');
    assert.deepStrictEqual(p.chain.map((c) => [c.scheduleId, c.ownerName, c.mine]), [['cw-mails', 'Ann', true], ['cw-invoices', 'Ben', false]]);
    assert.deepStrictEqual(p.roles, [{ role: 'Purchasing', holderId: 'ben', holderName: 'Ben', holderWords: 'Ben', standInId: 'lena', standInName: 'A colleague' }]);
    assert.deepStrictEqual(p.unmatched, []);
    assert.deepStrictEqual(p.choices.coworks.map((c) => c.scheduleId), ['cw-mails', 'cw-invoices'], 'a cowork on another desk and another organisation\'s cowork are never offered');
    assert.ok(p.choices.coworks.every((c) => !('ownerId' in c)), 'no owner id goes to the page with a cowork');
    assert.deepStrictEqual(seen.usage.map((u) => [u.source, u.userId, u.orgId, u.model]), [['cowork_compose', 'ann', 'org-a', 'model-fast']], 'booked as Cowork AI');
    assert.deepStrictEqual(seen.budget, [''], 'without an item only the organisation\'s budget is asked');
    assert.strictEqual(seen.tool.function.parameters.additionalProperties, false, 'a strict schema');
});

test('the model sees the words, the titles and the display names under labels; never an id, an e-mail address or another organisation', async () => {
    const { deps, seen } = setup(GOOD);
    await draftDesk({ userId: 'ann', text: TEXT }, deps);
    const sent = seen.messages.map((m) => m.content).join('\n');
    assert.deepStrictEqual(seen.messages.map((m) => m.role), ['system', 'user']);
    assert.strictEqual(seen.messages[1].content, TEXT, 'the person\'s own words, as the user message');
    assert.match(sent, /C1: "Answer supplier mails"/);
    assert.match(sent, /C2: "Invoice check" \(Ben's\)/);
    assert.match(sent, /P2: Ben/);
    for (const secret of ['cw-mails', 'cw-invoices', 'ann', 'ben', 'lena@example.org', 'example.org', 'Eve', 'org-a', 'On another desk', 'ag-1', 'pl-1']) {
        assert.ok(!sent.includes(secret), `${secret} is not sent to the model`);
    }
});

test('what the model names outside the lists is dropped, and the person\'s words come back as not found with a dropdown slot', async () => {
    const { deps } = setup({
        deskName: '',
        steps: [{ cowork: 'C1', words: 'my supplier mails' }, { cowork: 'C9', words: 'checks the invoices' }, { cowork: '', words: 'payments' }, { cowork: 'C1', words: 'again' }],
        roles: [{ name: 'Purchasing', holder: 'cw-eve', holderWords: 'Ben', standIn: 'P2' }, { name: 'Finance', holder: 'P1', holderWords: 'Ann', standIn: '' }],
    });
    const p = await draftDesk({ userId: 'ann', text: TEXT, itemId: 'cw-mails' }, deps);
    assert.strictEqual(p.deskName, 'Answer supplier mails', 'no name: the item\'s title');
    assert.deepStrictEqual(p.chain.map((c) => [c.scheduleId, c.words]), [['cw-mails', 'my supplier mails'], [null, 'checks the invoices']],
        'an unknown label is a slot to choose; words that are not the person\'s are dropped; a cowork comes once');
    assert.deepStrictEqual(p.roles.map((r) => [r.holderId, r.standInId]), [[null, 'ben']], 'a raw id from the model is not a label');
    assert.deepStrictEqual(p.unmatched, ['checks the invoices', 'Ben', 'Finance'], 'a second role is left for All settings');
});

test('readProposal holds a chain to five coworks; the hand-off limits are the engine\'s', () => {
    const coworks = Array.from({ length: 7 }, (_, i) => ({ scheduleId: `c${i}`, title: `T${i}`, ownerId: 'u', ownerName: 'U', mine: true, hasRunner: true }));
    const p = readProposal({ steps: coworks.map((_, i) => ({ cowork: `C${i + 1}`, words: '' })), roles: [] }, { coworks, people: [] }, 'x', 'Teamwork');
    assert.strictEqual(p.chain.length, 5);
    const engine = require('../core/cowork/afterCowork.mts');
    assert.deepStrictEqual([MAX_STEPS, MAX_CROSSINGS], [engine.MAX_CHAIN, engine.MAX_CROSS_OWNER], 'the same limits as the engine');
    assert.strictEqual(crossingsOf(['a', 'b', 'b', 'c', 'a']), 3);
});

test('without a model, or when the shield blocks the words, an empty proposal to fill in by hand; the model is never asked twice', async () => {
    for (const opts of [{ model: null }, { shieldThrows: true }]) {
        const { deps, seen } = setup(GOOD, opts);
        const p = await draftDesk({ userId: 'ann', text: TEXT }, deps);
        assert.deepStrictEqual([p.drafted, p.chain, p.roles, p.deskName], [false, [], [], 'Teamwork']);
        assert.strictEqual(p.choices.people.length, 3);
        assert.deepStrictEqual(seen.usage, [], 'nothing reached the model');
    }
});

test('refusals: no organisation 403, someone else\'s or another organisation\'s item 404, at the budget the model is not asked', async () => {
    const { deps, seen } = setup(GOOD, {});
    await assert.rejects(draftDesk({ userId: 'lone', text: TEXT }, deps), (/** @type {any} */ e) => e.status === 403);
    await assert.rejects(draftDesk({ userId: 'ann', text: TEXT, itemId: 'cw-eve' }, deps), (/** @type {any} */ e) => e.status === 404);
    await assert.rejects(draftDesk({ userId: 'ann', text: TEXT, itemId: 'cw-invoices' }, deps), (/** @type {any} */ e) => e.status === 404);
    const spent = setup(GOOD, { spent: true });
    await assert.rejects(draftDesk({ userId: 'ann', text: TEXT, itemId: 'cw-mails' }, spent.deps), (/** @type {any} */ e) => e.code === 'cowork_budget_used');
    assert.deepStrictEqual(spent.seen.budget, ['cw-mails'], 'the item\'s budget is asked when it is opened from one');
    assert.deepStrictEqual([seen.usage, spent.seen.usage], [[], []]);
});

test('opened from a cowork on someone else\'s desk: changed there, not here', async () => {
    const { deps } = setup(GOOD);
    deps.membershipOf = async () => ({ deskId: 'd-1', deskOwnerId: 'ben', accepted: true });
    await assert.rejects(draftDesk({ userId: 'ann', text: TEXT, itemId: 'cw-mails' }, deps), (/** @type {any} */ e) => e.status === 409);
});

test('an approved task cannot move a desk proposal to another desk if its membership changed', async () => {
    const { applyDeskDraft } = require('./coworkDeskHelperApply.mts');
    const { deps } = setup(null);
    await assert.rejects(
        applyDeskDraft({ userId: 'ann', itemId: 'cw-mails', expectedDeskId: 'previous-desk', draft: {deskName:'Invoices', chain:['cw-mails'], roles:[]} },
            /** @type {any} */ ({ helper: deps })),
        (/** @type {any} */ err) => err.status === 409 && err.message.includes('changed desks'),
    );
});
