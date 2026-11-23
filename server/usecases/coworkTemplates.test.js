/**
 * Templates from your organisation (./coworkTemplates.mts): saving cleans the plan, what a template may do is worked
 * out from its definition every time, another organisation finds nothing, and adding one runs and approves nothing.
 * The stores are handed in as an in-memory world, so nothing is mocked.
 *
 * Run: cd server && node --test usecases/coworkTemplates.test.js
 */

'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

const { saveAsTemplate, listTemplates, templateView, useTemplate, deleteTemplate } = require('./coworkTemplates.mts');
const { planFingerprint, permissionsOf } = require('../core/cowork/plan/planPermissions.mts');
const { fakeLookups, supplierRadar } = require('../core/cowork/plan/plan.testkit');
const { buildExport } = require('../automation/portability');

const lookups = fakeLookups();
const PEOPLE = {
    ann: { id: 'ann', organizationId: 'org-a', displayName: 'Ann' },
    bob: { id: 'bob', organizationId: 'org-a', displayName: 'Bob' },
    ada: { id: 'ada', organizationId: 'org-a', displayName: 'Ada' },
    eve: { id: 'eve', organizationId: 'org-b', displayName: 'Eve' },
    solo: { id: 'solo', organizationId: null },
};
const ITEM = { id: 'item-1', userId: 'ann', title: 'Supplier radar', prompt: 'Watch the suppliers.', repeatInterval: 'weekly', triggerKind: 'schedule' };

function world({ approved = /** @type {unknown} */ (supplierRadar()), count = 0 } = {}) {
    const state = {
        templates: /** @type {any[]} */ ([]), items: /** @type {any[]} */ ([]), paused: /** @type {string[]} */ ([]), deleted: /** @type {string[]} */ ([]),
        automations: /** @type {any[]} */ ([]), attached: /** @type {any[]} */ ([]), runs: 0, approvals: 0,
    };
    const deps = {
        templates: {
            create: async (input) => { const t = { id: `tpl-${state.templates.length + 1}`, createdAt: '2026-11-23T10:00:00.000Z', ...structuredClone(input) }; state.templates.push(t); return t; },
            listForOrg: async (orgId) => state.templates.filter((t) => t.organizationId === orgId),
            get: async (id, orgId) => state.templates.find((t) => t.id === id && t.organizationId === orgId) ?? null,
            remove: async (id, orgId, by) => {
                const at = state.templates.findIndex((t) => t.id === id && t.organizationId === orgId && (by.asAdmin || t.createdBy === by.userId));
                if (at < 0) return false;
                state.templates.splice(at, 1);
                return true;
            },
        },
        getUser: async (id) => PEOPLE[id] ?? null,
        isOrgAdmin: async (userId, orgId) => userId === 'ada' && orgId === 'org-a',
        getApprovedPlan: async () => (approved ? { definition: approved } : null),
        clean: (definition) => { const { envelope, warnings } = buildExport({ definition }); return { definition: envelope.automation.definition, warnings }; },
        lookups,
        createSchedule: async (fields) => { const item = { id: `new-${state.items.length + 1}`, isActive: true, ...fields }; state.items.push(item); return item; },
        pauseSchedule: async (id) => { state.paused.push(id); },
        deleteSchedule: async (id) => { state.deleted.push(id); },
        scheduleCount: async () => count,
        maxItems: async () => 10,
        createAutomation: async (input) => { const a = { id: `auto-${state.automations.length + 1}`, isActive: false, ...input }; state.automations.push(a); return a; },
        attachPlanAutomation: async (scheduleId, automationId, opts) => { state.attached.push({ scheduleId, automationId, opts }); return true; },
        now: () => Date.parse('2026-11-23T10:00:00.000Z'),
        // Anything that would run or approve counts here; nothing in the use case reaches it.
        runNow: () => { state.runs += 1; },
        approvePlan: () => { state.approvals += 1; },
    };
    return { deps, state };
}

/** A template stored as saving would store it: the definition cleaned, its fingerprint beside it. */
async function savedTemplate(deps, definition = supplierRadar()) {
    const { envelope } = buildExport({ definition });
    return deps.templates.create({
        organizationId: 'org-a', createdBy: 'ann', title: 'Supplier radar', brief: 'Watch the suppliers.', repeatInterval: 'weekly',
        definition: envelope.automation.definition, fingerprint: planFingerprint(envelope.automation.definition),
    });
}

const refused = (status) => (err) => err.status === status && err.code === 'cowork_template_refused';

test('saving keeps the brief and the schedule shape, and cleans the approved plan with the export sanitiser', async () => {
    const { deps, state } = world();
    const { template, warnings } = await saveAsTemplate({ item: ITEM, userId: 'ann' }, deps);
    assert.deepStrictEqual(template, { id: 'tpl-1', title: 'Supplier radar', brief: 'Watch the suppliers.', repeatInterval: 'weekly', hasPlan: true, createdAt: '2026-11-23T10:00:00.000Z', mine: true });
    const stored = state.templates[0];
    assert.strictEqual(stored.organizationId, 'org-a');
    const table = stored.definition.steps.find((s) => s.id === 'table');
    assert.strictEqual(table.datatableId, '', 'a table of one organisation is not handed around');
    assert.ok(warnings.some((w) => w.includes('datatable')));
    assert.strictEqual(stored.fingerprint, planFingerprint(stored.definition));
    assert.ok(!('permissions' in stored), 'what the plan may do is not stored');
});

test('an item without an approved plan saves without one; only the owner saves, and only into an organisation', async () => {
    const { deps, state } = world({ approved: null });
    await saveAsTemplate({ item: ITEM, userId: 'ann', title: '  Weekly radar ' }, deps);
    assert.deepStrictEqual([state.templates[0].definition, state.templates[0].fingerprint, state.templates[0].title], [null, null, 'Weekly radar']);
    await assert.rejects(saveAsTemplate({ item: ITEM, userId: 'bob' }, deps), refused(403));
    await assert.rejects(saveAsTemplate({ item: { ...ITEM, userId: 'solo' }, userId: 'solo' }, deps), refused(409));
    await assert.rejects(saveAsTemplate({ item: { ...ITEM, triggerKind: 'app_event' }, userId: 'ann' }, deps), refused(409));
});

test('the list is the caller\'s organisation; someone without one has none', async () => {
    const { deps } = world();
    await savedTemplate(deps);
    assert.deepStrictEqual((await listTemplates('bob', deps)).map((t) => [t.id, t.mine]), [['tpl-1', false]]);
    assert.deepStrictEqual(await listTemplates('eve', deps), []);
    assert.deepStrictEqual(await listTemplates('solo', deps), []);
});

test('what a template may do is recomputed from its definition; a stored list is never read', async () => {
    const { deps, state } = world();
    await savedTemplate(deps);
    // A template row that claims its plan may do nothing: the claim is ignored.
    state.templates[0].permissions = { v: 1, grants: [], sends: 'none', ai: false, outsideText: false };
    const view = await templateView('bob', 'tpl-1', deps);
    assert.deepStrictEqual(view.plan.permissions, permissionsOf(state.templates[0].definition, lookups));
    assert.ok(view.plan.permissions.grants.some((g) => g.app === 'outlook'));
    assert.deepStrictEqual([view.template.savedBy, view.template.canDelete], ['Ann', false]);
    assert.strictEqual((await templateView('ada', 'tpl-1', deps)).template.canDelete, true, 'an administrator may delete it');
});

test('a plan that is not the one saved is not offered as a plan', async () => {
    const { deps, state } = world();
    await savedTemplate(deps);
    state.templates[0].definition.steps.push({ id: 'send', type: 'integration_action', label: 'Mail everyone', tool: 'outlook_compose', inputs: {} });
    const view = await templateView('bob', 'tpl-1', deps);
    assert.ok(view.plan.findings.some((f) => f.code === 'template.changed'));
    assert.strictEqual(view.plan.attachable, false);
    assert.ok(view.plan.permissions.grants.some((g) => g.effect === 'sends'), 'what it may do still shows what the definition does');
});

test('another organisation gets a 404 for every route', async () => {
    const { deps, state } = world();
    await savedTemplate(deps);
    await assert.rejects(templateView('eve', 'tpl-1', deps), refused(404));
    await assert.rejects(useTemplate('eve', 'tpl-1', deps), refused(404));
    await assert.rejects(deleteTemplate('eve', 'tpl-1', deps), refused(404));
    await assert.rejects(templateView('solo', 'tpl-1', deps), refused(404));
    assert.deepStrictEqual([state.items.length, state.templates.length], [0, 1]);
});

test('using a template makes a paused item with an unapproved plan of the caller\'s, and runs nothing', async () => {
    const { deps, state } = world();
    await savedTemplate(deps);
    const used = await useTemplate('bob', 'tpl-1', deps);
    assert.strictEqual(used.item.isActive, false);
    assert.strictEqual(used.planAttached, true);
    assert.deepStrictEqual(state.items.map((i) => [i.userId, i.title, i.prompt, i.repeatInterval, i.triggerKind]), [['bob', 'Supplier radar', 'Watch the suppliers.', 'weekly', 'schedule']]);
    assert.ok(Date.parse(state.items[0].nextRunAt) > deps.now(), 'nothing is due');
    assert.deepStrictEqual(state.paused, ['new-1']);
    assert.deepStrictEqual(state.automations.map((a) => [a.userId, a.organizationId, a.isActive]), [['bob', 'org-a', false]]);
    assert.deepStrictEqual(state.attached, [{ scheduleId: 'new-1', automationId: 'auto-1', opts: { onlyIfNone: true } }]);
    assert.deepStrictEqual([state.runs, state.approvals], [0, 0], 'nothing ran and nothing was approved');
    assert.notStrictEqual(state.automations[0].definition, state.templates[0].definition, 'the automation has its own copy');
});

test('a template whose plan has findings is added without its plan; a full list refuses; a failed plan leaves no item', async () => {
    const { deps, state } = world();
    await savedTemplate(deps);
    state.templates[0].fingerprint = 'not-the-plan';
    const used = await useTemplate('bob', 'tpl-1', deps);
    assert.deepStrictEqual([used.planAttached, state.automations.length, used.findings.map((f) => f.code)], [false, 0, ['template.changed']]);

    const full = world({ count: 10 });
    await savedTemplate(full.deps);
    await assert.rejects(useTemplate('bob', 'tpl-1', full.deps), refused(400));

    const broken = world();
    await savedTemplate(broken.deps);
    broken.deps.createAutomation = async () => { throw new Error('database gone'); };
    await assert.rejects(useTemplate('bob', 'tpl-1', broken.deps), /database gone/);
    assert.deepStrictEqual(broken.state.deleted, ['new-1']);
});

test('a template is deleted by its creator or an administrator of the organisation only', async () => {
    const { deps, state } = world();
    await savedTemplate(deps);
    await savedTemplate(deps);
    await assert.rejects(deleteTemplate('bob', 'tpl-1', deps), refused(403));
    assert.deepStrictEqual(await deleteTemplate('ann', 'tpl-1', deps), { deleted: true });
    assert.deepStrictEqual(await deleteTemplate('ada', 'tpl-2', deps), { deleted: true });
    assert.deepStrictEqual(state.templates, []);
});
