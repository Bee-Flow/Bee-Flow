/**
 * O4 deel C — wat een geëxporteerd Blueprint-bestand over zijn herkomst zegt.
 *
 * Zonder dit blok kan een BESTANDSinstallatie zichzelf nooit aan zijn Blueprint
 * koppelen, en telt zij dus nooit mee in "hoe vaak is dit geïnstalleerd". Dat
 * maakt het stempelen de voorkant van de hele installatietelling.
 *
 * Wat hier wordt vastgepind:
 *
 *   1. HET BLOK WORDT NA DE PUBLICATIE GESTEMPELD, met het echte Blueprint-id
 *      en het echte versienummer. Vóór de publicatie bestaan die niet.
 *   2. EEN EXPORT ZONDER PUBLICATIE CLAIMT GEEN BLUEPRINT. `blueprintId: null`
 *      is de eerlijke waarde: het bestand hoort bij geen enkele galerijrij.
 *   3. DE ORGANISATIENAAM IS BELEEFDHEID, GEEN DRAGEND VELD. Is zij niet te
 *      lezen, dan blijft zij null en gaat de export gewoon door.
 *   4. HET IS DE ORGANISATIE VAN HET PROJECT, niet die van de sessie: een
 *      exporterende gast schrijft niet zijn eigen org in andermans bestand.
 *
 * Hermetisch: capture, de stores en de gates zijn via require.cache vervangen.
 *
 * Run: cd server && node --test routes/projects/packaging.source.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const express = require('express');

// ── De stubs, vóór de router wordt geladen ──────────────────────────────────

const stub = (rel, exports) => {
    const p = require.resolve(rel);
    require.cache[p] = { id: p, filename: p, loaded: true, exports };
};

stub('../../license/middleware', {
    requireFeature: () => (req, res, next) => next(),
    featureAllowedForRequest: async () => ({ allowed: true }),
});
stub('../../auth/projectAccess', {
    // De rolgate is elders getoetst (routes/projects.routetable.test.js pint dat
    // hij op deze route staat); hier gaat het om wat er ná de gate gebeurt.
    requireProjectRole: () => (req, res, next) => next(),
});

const fx = {
    project: null,
    published: null,
    publishThrows: null,
    publishCalls: 0,
    orgName: 'Acme',
    orgNameThrows: false,
    // The server-side publish gate (projects/packaging/publication.js
    // releaseGate): the graph it reads and the verdict it is given.
    graphThrows: false,
    verdict: null,
    // F1: the members as the store lists them, and the ref ledger.
    members: { automations: [] },
    ledger: new Map(),
    ledgerThrows: false,
    allocateCalls: [],
    captureRefs: [],
    publishedManifests: [],
    loadMembersCalls: 0,
    // Runs right after loadMembers answered: a part that arrives between the
    // ledger's read of the members and capture's own.
    afterLoadMembers: null,
};

stub('../../stores/projectStore', {
    getProject: async () => fx.project,
});
// Capture as far as refs go: the members in the order the store lists them,
// numbered by the REAL assignRefs with whatever refs the route handed over.
stub('../../projects/packaging/capture', {
    loadMembers: async () => {
        fx.loadMembersCalls += 1;
        const out = { automations: fx.members.automations, apps: [], webpages: [], datatables: [], agents: [], knowledgeBases: [] };
        if (fx.afterLoadMembers) fx.afterLoadMembers(fx.loadMembersCalls);
        return out;
    },
    captureSolution: async ({ refs = null } = {}) => {
        fx.captureRefs.push(refs);
        const { buildManifest, assignRefs } = require('../../projects/packaging/manifest');
        const members = { automations: fx.members.automations };
        const byId = assignRefs(members, { refs });
        return {
            ok: true,
            manifest: buildManifest({
                project: fx.project, exportedAt: '2026-09-08T00:00:00Z',
                entities: {
                    automations: fx.members.automations.map(a => ({
                        ref: byId.get(a.id), kind: 'automation', title: a.title,
                        definition: { schemaVersion: 2, steps: [] },
                    })),
                },
            }),
        };
    },
});
stub('../../stores/blueprintStore', {
    publishRelease: async ({ manifest }) => {
        fx.publishCalls += 1;
        fx.publishedManifests.push(manifest);
        if (fx.publishThrows) throw fx.publishThrows;
        return fx.published;
    },
    // The ledger's contract in memory: a part keeps its ref, a new one gets
    // the next number of its prefix (stores/blueprintStore.pipeline.test.js
    // proves the real one against Postgres).
    allocateRefs: async (solutionId, members, { prefixOf, kinds = null }) => {
        fx.allocateCalls.push({ solutionId, members, kinds });
        if (fx.ledgerThrows) throw new Error('ledger table missing');
        const out = new Map();
        for (const m of members) {
            const key = `${m.kind}:${m.entityId}`;
            if (!fx.ledger.has(key)) {
                const prefix = prefixOf(m.kind);
                const n = [...fx.ledger.values()].filter(r => r.startsWith(`${prefix}_`)).length + 1;
                fx.ledger.set(key, `${prefix}_${n}`);
            }
            out.set(m.entityId, fx.ledger.get(key));
        }
        return out;
    },
});
stub('../../projects/graphForProject', {
    buildGraphForProject: async (projectId) => {
        if (fx.graphThrows) throw new Error('graph store down');
        return { graph: { projectId, nodes: [], edges: [], externals: [], problems: [] }, members: { apps: [], automations: [], knowledgeBases: [] }, unavailable: [] };
    },
});
stub('../../projects/completeness', { collectCompleteness: async () => fx.verdict });
stub('../../stores/userStore', {
    getOrganization: async (id) => {
        if (fx.orgNameThrows) throw new Error('organisatie onbereikbaar');
        return id ? { id, name: fx.orgName } : null;
    },
});

const router = require('./packaging');
const { terminalErrorHandler } = require('../../core/http/terminalErrorHandler');

// ── Het testserver-tje ──────────────────────────────────────────────────────

let server;
let base;

test.before(async () => {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { user: { id: 'alice', organizationId: 'org_session' } }; next(); });
    app.use('/api/projects', router);
    app.use(terminalErrorHandler);
    await new Promise(resolve => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => { if (server) server.close(); });

function exportProject(body) {
    const payload = JSON.stringify(body || {});
    return new Promise((resolve, reject) => {
        const req = http.request(`${base}/api/projects/p1/package/export`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        }, (r) => {
            let text = '';
            r.on('data', c => { text += c; });
            r.on('end', () => {
                let json = null;
                try { json = JSON.parse(text); } catch { /* niet-JSON is zelf het antwoord */ }
                resolve({ status: r.statusCode, json });
            });
        });
        req.on('error', reject);
        req.end(payload);
    });
}

function reset() {
    fx.project = { id: 'p1', name: 'Onboarding', organizationId: 'org_project' };
    fx.published = null;
    fx.publishThrows = null;
    fx.orgName = 'Acme';
    fx.orgNameThrows = false;
    fx.publishCalls = 0;
    fx.graphThrows = false;
    fx.verdict = { blocked: false, complete: true, findings: [], unavailable: [] };
    fx.members = { automations: [] };
    fx.ledger = new Map();
    fx.ledgerThrows = false;
    fx.allocateCalls = [];
    fx.captureRefs = [];
    fx.publishedManifests = [];
    fx.loadMembersCalls = 0;
    fx.afterLoadMembers = null;
}

const blockingFinding = {
    code: 'automation.trigger_missing', severity: 'error', kind: 'automation',
    targetRef: { kind: 'automation', id: 'aut_internal_1', title: 'Nightly' },
    message: 'This automation has no trigger.', remediation: 'Add a trigger.',
    deepLink: '/app/studio/automations/aut_internal_1',
};

const publishedAs = (id, version) => ({
    blueprint: {
        id, version, name: 'Onboarding',
        manifest: require('../../projects/packaging/manifest').buildManifest({
            project: fx.project, version,
        }),
    },
    release: { id: 'rel_1', version },
});

// ── 1. Na de publicatie ─────────────────────────────────────────────────────

test('een gepubliceerd bestand draagt het echte Blueprint-id en versienummer', async () => {
    reset();
    fx.published = publishedAs('bp_abc', 3);
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.json.source, {
        blueprintId: 'bp_abc', orgId: 'org_project', orgName: 'Acme', version: 3,
    });
    // De bestaande annotaties blijven staan — het herkomstblok komt erbij, het
    // vervangt niets.
    assert.strictEqual(res.json._savedAs, 'bp_abc');
    assert.strictEqual(res.json._version, 3);
});

// ── 2. Zonder publicatie ────────────────────────────────────────────────────

test('een gewone download claimt geen Blueprint', async () => {
    reset();
    const res = await exportProject({});
    assert.strictEqual(res.json.source.blueprintId, null,
        'dit bestand hoort bij geen enkele galerijrij en mag daar niet naar wijzen');
    assert.strictEqual(res.json.source.orgId, 'org_project');
    assert.strictEqual(res.json.source.version, 1);
});

test('mislukt de publicatie, dan gaat het bestand mee zonder Blueprint-id', async () => {
    reset();
    fx.publishThrows = new Error('de galerij zit vol');
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 200);
    assert.match(res.json._saveError, /galerij zit vol/);
    // Het foutpad stempelt bewust geen herkomst: er IS geen galerijrij, dus een
    // id noemen zou een verwijzing naar niets zijn.
    assert.ok(!res.json.source?.blueprintId, 'geen id van een publicatie die niet gebeurd is');
});

// ── 3. De naam is beleefdheid ───────────────────────────────────────────────

test('een onleesbare organisatienaam laat de export gewoon doorgaan', async () => {
    reset();
    fx.orgNameThrows = true;
    fx.published = publishedAs('bp_abc', 1);
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.source.orgName, null);
    assert.strictEqual(res.json.source.orgId, 'org_project', 'het id staat los van de naam');
});

test('een project zonder organisatie noemt er geen', async () => {
    reset();
    fx.project = { id: 'p1', name: 'Onboarding', organizationId: null };
    const res = await exportProject({});
    assert.strictEqual(res.json.source.orgId, null);
    assert.strictEqual(res.json.source.orgName, null);
});

// ── 4. De org van het PROJECT ───────────────────────────────────────────────

test('het is de organisatie van het project, niet die van de sessie', async () => {
    // De sessie draagt org_session; de Blueprint komt uit een project in
    // org_project. Zou de sessie winnen, dan schreef een gast zijn eigen
    // organisatie in andermans bestand.
    reset();
    const res = await exportProject({});
    assert.strictEqual(res.json.source.orgId, 'org_project');
});

// ── Packaging is for Studio Solutions ──────────────────────────────────────

test('a collaborative project cannot be exported as a Blueprint: 404, nothing published', async () => {
    reset();
    fx.project = { ...fx.project, kind: 'workspace' };
    fx.published = publishedAs('bp_should_not_exist', 1);
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.json.error, 'Not found');
    assert.ok(!('solution' in res.json), 'no manifest of a collaborative project leaves the server');
});

test('a Solution exports as before', async () => {
    reset();
    fx.project = { ...fx.project, kind: 'solution' };
    const res = await exportProject({});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.solution.key, 'sol_p1');
});

// ── The publish gate is the server's ───────────────────────────────────────

test('publishing a Solution with blocking findings is refused 409 release_blocked, nothing published', async () => {
    reset();
    fx.verdict = { blocked: true, complete: true, findings: [blockingFinding], unavailable: [] };
    fx.published = publishedAs('bp_should_not_exist', 1);
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.json.code, 'release_blocked');
    assert.deepStrictEqual(res.json.details.findings.map(f => f.code), ['automation.trigger_missing']);
    assert.strictEqual(fx.publishCalls, 0, 'a blocked Solution never reaches the gallery');
    assert.ok(!('solution' in res.json), 'no manifest rides along with a refusal');
});

test('a gate that could not run blocks publishing: unknown is not clean', async () => {
    reset();
    fx.graphThrows = true;
    fx.published = publishedAs('bp_should_not_exist', 1);
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.json.code, 'release_blocked');
    assert.deepStrictEqual(res.json.details.unavailable, ['all']);
    assert.strictEqual(fx.publishCalls, 0);
});

test('a clean Solution publishes as before', async () => {
    reset();
    fx.published = publishedAs('bp_abc', 2);
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json._savedAs, 'bp_abc');
    assert.strictEqual(fx.publishCalls, 1);
});

test('a plain download is never refused by the gate, and carries the findings without ids', async () => {
    reset();
    // A graph problem as completeness hands it over: the producer's sentence
    // names the automation OUTSIDE the Solution, and the targetId is gone.
    const externalFinding = {
        code: 'external', severity: 'warning', kind: 'solution',
        targetRef: { kind: 'automation', id: 'aut_internal_1', title: 'Mine' },
        message: 'Mine depends on an automation outside this project (aut_SECRET_9f3a), so packaging cannot carry it.',
    };
    fx.verdict = { blocked: true, complete: true, findings: [blockingFinding, externalFinding], unavailable: [] };
    const res = await exportProject({});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.json.solution.key, 'sol_p1');
    assert.strictEqual(res.json._checks.blocked, true);
    assert.deepStrictEqual(res.json._checks.findings, [{
        code: 'automation.trigger_missing', severity: 'error', blockedAt: null, kind: 'automation',
        title: 'Nightly', remediation: 'Add a trigger.',
    }, {
        code: 'external', severity: 'warning', blockedAt: null, kind: 'solution',
        title: 'Mine', remediation: null,
    }]);
    // The file travels to other organisations: no member id, no deep link,
    // and no producer sentence that interpolates an id of this instance.
    const checks = JSON.stringify(res.json._checks);
    assert.ok(!checks.includes('aut_internal_1'));
    assert.ok(!checks.includes('aut_SECRET_9f3a'));
    assert.strictEqual(fx.publishCalls, 0);
});

// ── A Solution stage is not exported on its own ────────────────────────────

test('a Solution stage (UAT/Production) answers 404 on export, nothing published', async () => {
    reset();
    fx.project = { ...fx.project, kind: 'solution', stage: 'prd', stageOf: 'p_dev' };
    fx.published = publishedAs('bp_should_not_exist', 1);
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(res.json.error, 'Not found');
    assert.strictEqual(fx.publishCalls, 0);
});

// ── F1: a publication names every part by its ledger ref ──────────────────

test('reordering Dev parts between two publications still replaces the RIGHT entity on upgrade', async () => {
    // Positional refs over store order made `aut_1` whichever automation the store
    // listed first. A new automation sorting in front of the old ones shifted every
    // ref, and an installed copy's stamp for `aut_1` then received another
    // automation's definition.
    reset();
    const invoices = { id: 'a_invoices', title: 'Invoices' };
    const reminders = { id: 'a_reminders', title: 'Reminders' };
    const intake = { id: 'a_intake', title: 'Intake' };

    fx.published = publishedAs('bp_abc', 1);
    fx.members = { automations: [invoices, reminders] };
    assert.strictEqual((await exportProject({ save: true })).status, 200);

    fx.published = publishedAs('bp_abc', 2);
    fx.members = { automations: [intake, reminders, invoices] };   // a new part, and a different order
    assert.strictEqual((await exportProject({ save: true })).status, 200);

    const refOf = (manifest, title) => manifest.solution.entities.automations.find(a => a.title === title).ref;
    const [first, second] = fx.publishedManifests;
    assert.strictEqual(refOf(second, 'Invoices'), refOf(first, 'Invoices'));
    assert.strictEqual(refOf(second, 'Reminders'), refOf(first, 'Reminders'));
    assert.strictEqual(refOf(second, 'Intake'), 'aut_3', 'a new part gets a new ref, never an old one');

    // The upgrade planner matches stamps by ref: the stamp an install of
    // release 1 wrote for "Invoices" now meets "Invoices" again.
    const stamps = new Map([[refOf(first, 'Invoices'), 'installed_invoices'], [refOf(first, 'Reminders'), 'installed_reminders']]);
    assert.strictEqual(stamps.get(refOf(second, 'Invoices')), 'installed_invoices');
    assert.strictEqual(stamps.get(refOf(second, 'Reminders')), 'installed_reminders');

    assert.deepStrictEqual(fx.allocateCalls[1], {
        solutionId: 'p1',
        members: [
            { kind: 'automations', entityId: 'a_intake' },
            { kind: 'automations', entityId: 'a_reminders' },
            { kind: 'automations', entityId: 'a_invoices' },
        ],
        // A gallery publication retires only the six sections it speaks for.
        kinds: ['automations', 'apps', 'webpages', 'datatables', 'agents', 'knowledgeBases', 'skills', 'documents'],
    });
});

test('the first publication through the ledger numbers parts as positional refs did', async () => {
    // Installs made before the ledger hold stamps under positional refs; the
    // first allocation must hand out the very same ones.
    reset();
    fx.published = publishedAs('bp_abc', 1);
    fx.members = { automations: [{ id: 'a_x', title: 'X' }, { id: 'a_y', title: 'Y' }] };
    await exportProject({ save: true });
    assert.deepStrictEqual(fx.publishedManifests[0].solution.entities.automations.map(a => a.ref), ['aut_1', 'aut_2']);
});

test('a plain download leaves the ledger alone', async () => {
    reset();
    fx.members = { automations: [{ id: 'a_x', title: 'X' }] };
    const res = await exportProject({});
    assert.strictEqual(res.status, 200);
    assert.strictEqual(fx.allocateCalls.length, 0);
    assert.strictEqual(fx.loadMembersCalls, 0);
    assert.deepStrictEqual(fx.captureRefs, [null]);
});

test('a ledger that cannot be written REFUSES the publication: no positional fallback', async () => {
    // Release 1 and 2 through the ledger: X=aut_1, Y=aut_2, then X removed and
    // Z added as aut_3. Positional refs for release 3 would make Z aut_1, and
    // an upgrade would write Z over the installed X.
    reset();
    fx.published = publishedAs('bp_abc', 1);
    fx.members = { automations: [{ id: 'a_x', title: 'X' }, { id: 'a_y', title: 'Y' }] };
    assert.strictEqual((await exportProject({ save: true })).status, 200);

    fx.ledgerThrows = true;
    fx.members = { automations: [{ id: 'a_z', title: 'Z' }, { id: 'a_y', title: 'Y' }] };
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 503);
    assert.strictEqual(res.json.code, 'ref_ledger_unavailable');
    assert.ok(!/ledger table missing/.test(res.json.error), 'the store\'s own message stays in the log');
    assert.strictEqual(fx.publishCalls, 1, 'nothing published the second time');
    assert.strictEqual(fx.captureRefs.length, 1, 'and nothing captured with positional refs');
});

test('a part added between the ledger read and the capture gets a LEDGER ref, never a guessed one', async () => {
    // Capture reads the members itself. A part that arrived in between used to
    // be numbered past the refs handed over, which can be a retired ref.
    reset();
    fx.published = publishedAs('bp_abc', 1);
    fx.members = { automations: [{ id: 'a_x', title: 'X' }, { id: 'a_y', title: 'Y' }] };
    assert.strictEqual((await exportProject({ save: true })).status, 200);
    fx.members = { automations: [{ id: 'a_y', title: 'Y' }] };                 // X leaves: aut_1 retires
    fx.published = publishedAs('bp_abc', 2);
    assert.strictEqual((await exportProject({ save: true })).status, 200);

    fx.published = publishedAs('bp_abc', 3);
    const late = { id: 'a_late', title: 'Late' };
    fx.afterLoadMembers = (n) => { if (n === 3) fx.members = { automations: [fx.members.automations[0], late] }; };
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 200);
    const refs = fx.publishedManifests[2].solution.entities.automations.map(a => [a.title, a.ref]);
    assert.deepStrictEqual(refs, [['Y', 'aut_2'], ['Late', 'aut_3']], 'Late is in the ledger, not a reused number');
    assert.strictEqual(fx.ledger.get('automations:a_late'), 'aut_3');
    assert.strictEqual(fx.publishCalls, 3);
});

test('a Solution that keeps changing during publication is refused, not published with stray refs', async () => {
    reset();
    fx.published = publishedAs('bp_abc', 1);
    fx.members = { automations: [{ id: 'a_x', title: 'X' }] };
    let n = 0;
    fx.afterLoadMembers = () => { n += 1; fx.members = { automations: [...fx.members.automations, { id: `a_new${n}`, title: `New ${n}` }] }; };
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(res.json.code, 'solution_changed');
    assert.strictEqual(fx.publishCalls, 0);
});

test('a blocked publication never touches the ledger', async () => {
    reset();
    fx.verdict = { blocked: true, complete: true, findings: [blockingFinding], unavailable: [] };
    fx.members = { automations: [{ id: 'a_x', title: 'X' }] };
    const res = await exportProject({ save: true });
    assert.strictEqual(res.status, 409);
    assert.strictEqual(fx.allocateCalls.length, 0);
});
