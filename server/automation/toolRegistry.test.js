// @typecheck
/**
 * The tool catalogue as ONE list.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────
 * `TOOL_REGISTRY` describes the apps that deliver their tools as a TOOLS-array module. A handful of
 * integrations do not do that: `integrationTools.js` pushes their tools INLINE onto the stack, behind a
 * gate of their own (a docker probe for `browse_web`, an admin flag for the regex tools, an entitlement
 * for the notebooks). Those apps were therefore in no list that the agent tool picker reads — and they
 * were not in the index either from which `core/agentRuntime/toolPolicy.js` derives WHICH app owns a
 * tool name.
 *
 * The consequence was one finding, in two halves: the picker could not SHOW `browse_web`, and the
 * runtime let it through as "nobody claims this name" — also for an agent that had been narrowed down
 * to a single Gmail action.
 *
 * `ALL_TOOL_APPS` is the place where those two readers see the same list. What is pinned here is
 * therefore not "the list contains X", but that there is ONE list: two hand-maintained lists is
 * precisely the fault that this was supposed to solve.
 *
 * Run: node --test --test-force-exit automation/toolRegistry.test.js
 */

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const {
    TOOL_REGISTRY, INLINE_TOOL_APPS, ALL_TOOL_APPS, loadTools, appEntryFor,
} = require('./toolRegistry');

const idsOf = (list) => list.map(e => e.app);

test('ALL_TOOL_APPS is de registry PLUS de inline apps — niets minder, niets dubbel', () => {
    assert.ok(Array.isArray(ALL_TOOL_APPS));
    assert.deepStrictEqual(idsOf(ALL_TOOL_APPS), [...idsOf(TOOL_REGISTRY), ...idsOf(INLINE_TOOL_APPS)]);
    assert.strictEqual(new Set(idsOf(ALL_TOOL_APPS)).size, ALL_TOOL_APPS.length,
        'een app-id twee keer betekent dat één van de twee nooit gevonden wordt (first-wins)');
});

test('TOOL_REGISTRY zelf blijft ongemoeid — hij beantwoordt een ANDERE vraag', () => {
    // `getUserPermittedApps` and `appStudio/browseStep.js` cut their answer on TOOL_REGISTRY. Pushing an
    // inline app into it would change their meaning (see core/integrations/integrationTools.permittedApps.test.js);
    // that is why the extension stands beside it and not in it.
    const registryIds = new Set(idsOf(TOOL_REGISTRY));
    for (const entry of INLINE_TOOL_APPS) {
        assert.ok(!registryIds.has(entry.app), `${entry.app} hoort NIET in TOOL_REGISTRY`);
    }
});

test('browse_web is toe te schrijven aan een app — de helft die de rechtenlaag miste', () => {
    const owner = ALL_TOOL_APPS.find(e => loadTools(e).some(t => t?.function?.name === 'browse_web'));
    assert.ok(owner, 'browse_web moet een app hebben, anders glijdt hij langs elke per-actie-grant');
    assert.strictEqual(owner.app, 'browser-fetch');
    assert.strictEqual(owner.grantsRequireEntry, true);
});

test('elke inline app laadt echt tools, en zegt hoe een "niet beschikbaar" gelezen moet worden', () => {
    assert.ok(INLINE_TOOL_APPS.length > 0);
    for (const entry of INLINE_TOOL_APPS) {
        const tools = loadTools(entry);
        assert.ok(tools.length > 0, `${entry.app}: ${entry.module}.${entry.arrayName} laadt niets`);
        for (const t of tools) {
            assert.strictEqual(typeof t?.function?.name, 'string', `${entry.app}: tool zonder naam`);
        }
        // Silence about an inline app is not a choice: the picker never showed it, so nobody can have left it
        // standing. See toolPolicy.js.
        assert.strictEqual(entry.grantsRequireEntry, true,
            `${entry.app}: een inline app moet expliciet gegund worden`);
        // "Afwezig op deze installatie" is something different from "jij hebt hem niet verbonden". The picker must
        // be able to say that difference — and where an app sits behind SEVERAL gates (the browser: docker probe
        // AND org entitlement; the notebooks: feature flag, entitlement and `use_notebooks`) they are listed both,
        // because naming one of them is a claim that the measurement does not yield.
        const kinds = Array.isArray(entry.availability) ? entry.availability : [entry.availability];
        assert.ok(kinds.length > 0, `${entry.app}: availability moet zeggen WAAROM een app kan ontbreken`);
        for (const kind of kinds) {
            assert.ok(['installation', 'connection', 'permission'].includes(kind),
                `${entry.app}: onbekende availability "${kind}"`);
        }
        assert.strictEqual(new Set(kinds).size, kinds.length, `${entry.app}: dubbele availability`);
    }
});

// ── Two entries, one set of tool names (A2-4) ──────────────────────
// `outlook` and `outlook-readonly` load the same module: the same names, on the same credentials, of which
// the second delivers a strict subset. The attribution index of the permission layer assigns a name to ONE
// app, so the other owned none — and a grant that had been stored on that other one went nowhere, while the
// picker simply let it be stored.
//
// The rule is not "this may not be", because the two flavours exist for a reason (the org gate chooses which
// one is offered). The rule is that it must be DECLARED: `grantsVia` points to the app that owns the shared
// names. The permission layer reads that — ownership follows the declaration instead of the order of this
// list, and EVERY claiming app must allow a shared name (core/agentRuntime/toolPolicy.sharedModule.test.js).
//
// This test is the lasting half: whoever adds an entry here that shares names without declaring that gets a
// red result back instead of a silent dead grant.

/** naam → [app-id, …] over de ECHTE lijst. */
function claimantsByName() {
    const out = new Map();
    for (const entry of ALL_TOOL_APPS) {
        for (const t of loadTools(entry)) {
            const name = t?.function?.name;
            if (typeof name !== 'string' || !name) continue;
            if (!out.has(name)) out.set(name, []);
            const ids = out.get(name);
            if (!ids.includes(entry.app)) ids.push(entry.app);
        }
    }
    return out;
}

const declaredOwnerOf = (appId) => {
    const e = appEntryFor(appId);
    return e && typeof e.grantsVia === 'string' && e.grantsVia ? e.grantsVia : null;
};

test('elke gedeelde toolnaam heeft precies één eigenaar, en de rest DECLAREERT dat', () => {
    const shared = [...claimantsByName()].filter(([, ids]) => ids.length > 1);

    for (const [name, ids] of shared) {
        const owners = ids.filter(id => declaredOwnerOf(id) === null);
        assert.strictEqual(owners.length, 1,
            `"${name}" wordt geleverd door ${ids.join(', ')}. Precies één van die apps mag `
            + 'hem bezitten; de andere moeten `grantsVia: \'<eigenaar>\'` in TOOL_REGISTRY '
            + 'zetten. Zonder die declaratie hangt het eigendom aan de VOLGORDE van deze '
            + 'lijst, en is een grant op de andere app stil dood.');
        for (const id of ids) {
            if (id === owners[0]) continue;
            assert.strictEqual(declaredOwnerOf(id), owners[0],
                `${id} deelt "${name}" met ${owners[0]} en moet daar via grantsVia naar wijzen`);
        }
    }
});

test('grantsVia wijst naar een bestaande app, levert een subset, en ketent niet', () => {
    const claimants = claimantsByName();
    const namesOf = (appId) => loadTools(appEntryFor(appId) || {}).map(t => t?.function?.name).filter(Boolean);

    for (const entry of ALL_TOOL_APPS) {
        const via = declaredOwnerOf(entry.app);
        if (!via) continue;
        assert.notStrictEqual(via, entry.app, `${entry.app}: grantsVia mag niet naar zichzelf wijzen`);
        const owner = appEntryFor(via);
        assert.ok(owner, `${entry.app}: grantsVia wijst naar "${via}", die niet bestaat`);
        assert.strictEqual(declaredOwnerOf(via), null,
            `${entry.app}: grantsVia mag niet ketenen — "${via}" laat zijn grants zelf elders lopen`);

        // A subset, not merely "related": if the alias owns a name that the owner does not deliver, then in practice
        // it owns that name itself, and the declaration says something untrue.
        const ownerNames = new Set(namesOf(via));
        for (const name of namesOf(entry.app)) {
            assert.ok(ownerNames.has(name),
                `${entry.app}: levert "${name}", maar ${via} niet — dan is dit geen subset`);
            assert.ok((claimants.get(name) || []).includes(via),
                `${entry.app}: "${name}" wordt niet echt gedeeld met ${via}`);
        }
    }
});

test('outlook-readonly is de bekende gedeelde entry, en is als zodanig gedeclareerd', () => {
    // Not a "the list contains X" pin: this is the entry on which the finding sat, and the declaration is what
    // takes it out of the silent-dead-grant state.
    const ro = appEntryFor('outlook-readonly');
    assert.ok(ro, 'outlook-readonly hoort in het registry te staan');
    assert.strictEqual(ro.grantsVia, 'outlook');
    assert.strictEqual(ro.module, appEntryFor('outlook').module, 'dezelfde module, dezelfde namen');
});

test('appEntryFor vindt inline apps net zo goed als registry-apps', () => {
    assert.strictEqual(appEntryFor('gmail')?.arrayName, 'GMAIL_TOOLS');
    assert.strictEqual(appEntryFor('browser-fetch')?.arrayName, 'BROWSE_WEB_TOOLS');
    assert.strictEqual(appEntryFor('nope'), null);
    assert.strictEqual(appEntryFor(null), null);
});

// ── The anti-drift pin ───────────────────────────────────────────────
// Source assertions and no require(): toolCatalog.js drags in an express router and half the store graph.
// What is pinned here is structural, so reading the source is itself the honest answer.

test('de KIEZER en de RUNTIME lezen allebei ALL_TOOL_APPS', () => {
    // Since the split of toolPolicy.js, the runtime's attribution index lives in `toolPolicy/appIndex.js` —
    // that is the file that must read ALL_TOOL_APPS.
    const policy = fs.readFileSync(require.resolve('../core/agentRuntime/toolPolicy/appIndex'), 'utf8');
    const catalog = fs.readFileSync(require.resolve('../routes/agents/toolCatalog'), 'utf8');

    assert.match(policy, /ALL_TOOL_APPS/,
        'de attributie-index van de runtime moet de gedeelde lijst lezen');
    assert.match(catalog, /ALL_TOOL_APPS/,
        'de tool-catalogus van de kiezer moet dezelfde lijst lezen');

    // And neither may fall back to the narrower list: that is exactly how
    // browse_web became invisible to both.
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const [name, src] of [['toolPolicy', policy], ['toolCatalog', catalog]]) {
        assert.ok(!/for \(const entry of TOOL_REGISTRY/.test(strip(src)),
            `${name} loopt nog over TOOL_REGISTRY — dan mist hij de inline apps opnieuw`);
    }
});
