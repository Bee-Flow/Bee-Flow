/**
 * routes/webpages — de versiegeschiedenis als LEESBARE lijst (W4).
 *
 * Vóór deze stap gaf `GET /:id/versions` rijen terug met een samenvatting, een
 * tijd en een aantal bytes. Wie iets maakte, hoe groot de wijziging was, welk
 * nummer een versie draagt en welke versie het publiek eigenlijk leest —
 * daarvan stond niets in het antwoord, dus kon het scherm het ook niet tonen
 * zonder het te verzinnen.
 *
 * Wat hier vastligt is precies wat het antwoord MAG beweren:
 *
 *   MAKER      een `actor_user_id` die niet te lezen is, is NIET de lezer en
 *              NIET leeg. Het antwoord zegt dan dat de maker onbekend is. Het
 *              kale id verlaat de route nooit als los veld — het zit in
 *              `actor`, waar de vraag "wie was dit" al beantwoord is.
 *   GEPUBLICEERD  welke versie het publiek leest, komt uit
 *              `published_version_id` en staat als eigen veld in het antwoord.
 *              Een wijzer naar een versie van een ANDERE pagina levert niets,
 *              geen nummer dat in deze lijst niets betekent.
 *   TERUGZETTEN  maakt een momentopname met `source: 'restore'` en een
 *              samenvatting die zegt dat hij van VÓÓR het terugzetten is.
 *   ÉÉN WEG    Bekijk leest dezelfde route als de lijst en krijgt dezelfde
 *              vorm terug; er is geen tweede weg naar deze rijen.
 *
 * Geen database: auth is gestubd vóór de router laadt en elke store-aanraking
 * is gemonkeypatcht (patroon van webpages.publish.test.js).
 *
 * Run: node --test --test-force-exit routes/webpages.versions.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.NODE_ENV = 'test';

const perms = require('../auth/permissions');
perms.requireAuth = (req, res, next) => next();
const auth = require('../auth');
auth.requireActiveOrgForMutations = () => (req, res, next) => next();
auth.validateSharedGroupsForOrg = async (_org, groups) => (Array.isArray(groups) ? groups : []);
auth.hasPermission = async () => false;
const audience = require('../auth/audience');
audience.resolveAudienceContext = async (req) => ({
    userId: req.session.user.id, orgIds: ['org1'], userGroups: [],
});

const webpageStore = require('../stores/webpageStore');
const webpageDbStore = require('../stores/webpageDbStore');
const userStore = require('../stores/userStore');

const webpagesRouter = require('./webpages');

const OWNER = { id: 'alice', displayName: 'Alice Owner', organizationId: 'org1' };

const BASE_PAGE = {
    id: 'wp1', userId: 'alice', name: 'Page', isPublished: true, sharedGroups: [],
    organizationId: 'org1', publishedVersionId: null, projectId: null,
    htmlSha: 'h1', cssSha: 'c1', jsSha: 'j1', dbSha: '',
    htmlSize: 10, cssSize: 5, jsSize: 5, dbSize: 0, settings: {},
};

function row(over = {}) {
    return {
        id: 'v1', webpageId: 'wp1', summary: 'Edited in code', contentLength: 2048,
        createdAt: '2026-09-01T10:00:00.000Z', source: 'manual',
        seq: 12, actorUserId: 'alice', lineDelta: 4,
        ...over,
    };
}

function withPatches(patches, fn) {
    const originals = patches.map(([obj, key]) => [obj, key, obj[key]]);
    for (const [obj, key, value] of patches) obj[key] = value;
    return fn().finally(() => { for (const [obj, key, orig] of originals) obj[key] = orig; });
}

async function withServer(t, sessionUser, fn) {
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.session = { user: { ...sessionUser } }; next(); });
    app.use(webpagesRouter);
    const server = await new Promise((resolve) => {
        const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    t.after(() => server.close());
    return fn(`http://127.0.0.1:${server.address().port}`);
}

/** De vaste stubs; `over` overschrijft er losse van. */
function patch(page, over = {}) {
    return [
        [webpageStore, 'getWebpage', async (id, userId) => (userId === page.userId ? { ...page } : null)],
        [webpageStore, 'getVersions', async () => []],
        [webpageStore, 'getVersionMeta', async () => null],
        // De opslag is in deze tests bereikbaar. Expliciet, want de ECHTE
        // `slotsAreReadable` antwoordt hier `false` (er draait geen RustFS) en
        // dan zouden alle meet-tests hieronder "niet gemeten" krijgen zonder dat
        // dat iets over de route zegt. Een test die het omgekeerde wil, zet hem
        // zelf op `false` — zie de twee tests over onleesbare opslag.
        [webpageStore, 'slotsAreReadable', () => true],
        [webpageStore, 'listExtraFiles', async () => []],
        // Standaard NIETS opzoeken — een test die de store wél nodig heeft,
        // zet hem expliciet, en een test die per ongeluk gaat opzoeken valt op.
        [userStore, 'getUserAvatarsByIds', async () => { throw new Error('unexpected directory lookup'); }],
        ...Object.entries(over).map(([k, v]) => {
            if (k.startsWith('db:')) return [webpageDbStore, k.slice(3), v];
            if (k.startsWith('user:')) return [userStore, k.slice(5), v];
            return [webpageStore, k, v];
        }),
    ];
}

const getJson = async (url) => {
    const res = await fetch(url);
    return { status: res.status, body: await res.json().catch(() => ({})) };
};

// ── 1. De maker ───────────────────────────────────────────────────────

test('de lezer zelf komt terug als "jij", met de naam uit zijn sessie', async (t) => {
    await withPatches(patch(BASE_PAGE, { getVersions: async () => [row()] }), () =>
        withServer(t, OWNER, async (base) => {
            const { body } = await getJson(`${base}/wp1/versions`);
            assert.deepStrictEqual(body.versions[0].actor, { id: 'alice', name: 'Alice Owner', isYou: true });
        }));
});

test('BIJT: een rij zonder maker zegt dat de maker onbekend is — niet "jij"', async (t) => {
    // Elke rij van vóór de kolom `actor_user_id` valt hieronder. Zou de route
    // terugvallen op de sessie, dan claimde de geschiedenis dat de huidige
    // gebruiker werk deed waar niets over vastligt.
    await withPatches(patch(BASE_PAGE, { getVersions: async () => [row({ actorUserId: null })] }), () =>
        withServer(t, OWNER, async (base) => {
            const { body } = await getJson(`${base}/wp1/versions`);
            assert.strictEqual(body.versions[0].actor, null);
        }));
});

test('BIJT: een maker die niet meer op te zoeken is houdt zijn id en verliest zijn naam', async (t) => {
    let asked = null;
    await withPatches(patch(BASE_PAGE, {
        getVersions: async () => [row({ actorUserId: 'ghost' })],
        'user:getUserAvatarsByIds': async (ids) => { asked = ids; return []; },
    }), () => withServer(t, OWNER, async (base) => {
        const { body } = await getJson(`${base}/wp1/versions`);
        assert.deepStrictEqual(asked, ['ghost'], 'alleen het onbekende id wordt opgezocht');
        assert.deepStrictEqual(body.versions[0].actor, { id: 'ghost', name: null, isYou: false },
            'een verwijderd account is niet "jij" en niet leeg');
    }));
});

test('een mislukte naamopzoeking kost de geschiedenis niet', async (t) => {
    await withPatches(patch(BASE_PAGE, {
        getVersions: async () => [row({ actorUserId: 'ghost' })],
        'user:getUserAvatarsByIds': async () => { throw new Error('directory down'); },
    }), () => withServer(t, OWNER, async (base) => {
        const { status, body } = await getJson(`${base}/wp1/versions`);
        assert.strictEqual(status, 200);
        assert.strictEqual(body.versions[0].actor.name, null);
    }));
});

test('een collega wordt één keer gebatcht opgezocht, niet per rij', async (t) => {
    let lookups = 0;
    const rows = [row({ id: 'a', actorUserId: 'bob' }), row({ id: 'b', actorUserId: 'bob' }), row({ id: 'c' })];
    await withPatches(patch(BASE_PAGE, {
        getVersions: async () => rows,
        'user:getUserAvatarsByIds': async (ids) => {
            lookups++;
            assert.deepStrictEqual(ids, ['bob'], 'de eigen sessie levert alice al — die hoeft niet mee');
            return [{ id: 'bob', displayName: 'Bob B', username: 'bob' }];
        },
    }), () => withServer(t, OWNER, async (base) => {
        const { body } = await getJson(`${base}/wp1/versions`);
        assert.strictEqual(lookups, 1);
        assert.deepStrictEqual(body.versions[0].actor, { id: 'bob', name: 'Bob B', isYou: false });
        assert.strictEqual(body.versions[2].actor.isYou, true);
    }));
});

test('het kale actor-id verlaat de route niet als los veld', async (t) => {
    await withPatches(patch(BASE_PAGE, { getVersions: async () => [row()] }), () =>
        withServer(t, OWNER, async (base) => {
            const { body } = await getJson(`${base}/wp1/versions`);
            assert.ok(!('actorUserId' in body.versions[0]),
                'twee velden voor dezelfde vraag laten het scherm de verkeerde kiezen');
        }));
});

// ── 2. Nummer en regelverschil ────────────────────────────────────────

test('nummer en regelverschil komen door zoals ze zijn, negatief inbegrepen', async (t) => {
    await withPatches(patch(BASE_PAGE, { getVersions: async () => [row({ seq: 14, lineDelta: -21 })] }), () =>
        withServer(t, OWNER, async (base) => {
            const { body } = await getJson(`${base}/wp1/versions`);
            assert.strictEqual(body.versions[0].seq, 14);
            assert.strictEqual(body.versions[0].lineDelta, -21);
        }));
});

test('BIJT: een rij zonder nummer of meting draagt null, geen 0', async (t) => {
    await withPatches(patch(BASE_PAGE, { getVersions: async () => [row({ seq: null, lineDelta: null })] }), () =>
        withServer(t, OWNER, async (base) => {
            const { body } = await getJson(`${base}/wp1/versions`);
            assert.strictEqual(body.versions[0].seq, null);
            assert.strictEqual(body.versions[0].lineDelta, null);
        }));
});

// ── 3. Welke versie het publiek leest ─────────────────────────────────

test('de gepubliceerde versie komt uit published_version_id, met zijn nummer', async (t) => {
    await withPatches(patch({ ...BASE_PAGE, publishedVersionId: 'v-pub' }, {
        getVersions: async () => [row({ id: 'v-pub', seq: 12 }), row({ id: 'v-other', seq: 11 })],
        getVersionMeta: async (vid) => (vid === 'v-pub' ? { id: 'v-pub', webpageId: 'wp1', seq: 12 } : null),
    }), () => withServer(t, OWNER, async (base) => {
        const { body } = await getJson(`${base}/wp1/versions`);
        assert.deepStrictEqual(body.published, { versionId: 'v-pub', seq: 12 });
        assert.strictEqual(body.versions[0].isPublished, true);
        assert.strictEqual(body.versions[1].isPublished, false);
    }));
});

test('BIJT: een wijzer naar een versie van een ANDERE pagina levert niets', async (t) => {
    // getVersionMeta zoekt alleen op id. Zonder de paginacontrole zou hier een
    // nummer verschijnen dat in deze lijst nergens bij hoort.
    await withPatches(patch({ ...BASE_PAGE, publishedVersionId: 'v-foreign' }, {
        getVersions: async () => [row()],
        getVersionMeta: async () => ({ id: 'v-foreign', webpageId: 'wp2', seq: 3 }),
    }), () => withServer(t, OWNER, async (base) => {
        const { body } = await getJson(`${base}/wp1/versions`);
        assert.strictEqual(body.published, null);
    }));
});

test('een pagina zonder gepinde versie zegt dat, en zoekt niets op', async (t) => {
    await withPatches(patch(BASE_PAGE, {
        getVersions: async () => [row()],
        getVersionMeta: async () => { throw new Error('should not be asked'); },
    }), () => withServer(t, OWNER, async (base) => {
        const { body } = await getJson(`${base}/wp1/versions`);
        assert.strictEqual(body.published, null);
        assert.strictEqual(body.versions[0].isPublished, false);
    }));
});

test('een wijzer naar een gesnoeide versie levert niets in plaats van een halve chip', async (t) => {
    await withPatches(patch({ ...BASE_PAGE, publishedVersionId: 'v-gone' }, {
        getVersions: async () => [row()],
        getVersionMeta: async () => null,
    }), () => withServer(t, OWNER, async (base) => {
        const { body } = await getJson(`${base}/wp1/versions`);
        assert.strictEqual(body.published, null);
    }));
});

// ── 4. De paginering blijft heel ──────────────────────────────────────

test('hasMore blijft werken en de extra rij lekt niet in het antwoord', async (t) => {
    const many = Array.from({ length: 51 }, (_, i) => row({ id: `v${i}`, seq: 51 - i }));
    await withPatches(patch(BASE_PAGE, { getVersions: async () => many }), () =>
        withServer(t, OWNER, async (base) => {
            const { body } = await getJson(`${base}/wp1/versions`);
            assert.strictEqual(body.hasMore, true);
            assert.strictEqual(body.versions.length, 50);
        }));
});

// ── 5. Bekijk leest dezelfde route ────────────────────────────────────

test('één versie komt in dezelfde vorm terug als een rij uit de lijst', async (t) => {
    await withPatches(patch({ ...BASE_PAGE, publishedVersionId: 'v1' }, {
        getVersion: async () => ({ ...row(), html: '<h1>a</h1>', css: '', js: '' }),
    }), () => withServer(t, OWNER, async (base) => {
        const { body } = await getJson(`${base}/wp1/versions/v1`);
        assert.deepStrictEqual(body.version.actor, { id: 'alice', name: 'Alice Owner', isYou: true });
        assert.strictEqual(body.version.seq, 12);
        assert.strictEqual(body.version.isPublished, true);
        assert.ok(!('actorUserId' in body.version));
        assert.strictEqual(body.version.html, '<h1>a</h1>', 'en de bytes die Bekijk nodig heeft blijven staan');
    }));
});

test('een versie van een andere pagina blijft een 404', async (t) => {
    await withPatches(patch(BASE_PAGE, {
        getVersion: async () => ({ ...row(), webpageId: 'wp2', html: 'x', css: '', js: '' }),
    }), () => withServer(t, OWNER, async (base) => {
        const { status } = await getJson(`${base}/wp1/versions/v1`);
        assert.strictEqual(status, 404);
    }));
});

// ── 6. Terugzetten ────────────────────────────────────────────────────

function restorePatches(calls, over = {}) {
    return patch(BASE_PAGE, {
        getVersion: async () => ({
            id: 'v9', webpageId: 'wp1', seq: 9, source: 'manual', summary: 'x',
            html: 'a\nb\nc\nd', css: '', js: '',
        }),
        readAllSlots: async () => ({ html: 'a', css: '', js: '' }),
        createVersion: async (userId, id, summary, hashes, source, opts) => {
            calls.push({ userId, id, summary, source, opts });
            return { id: 'v-pre', seq: 13 };
        },
        writeSlot: async () => ({ sha: 's', size: 1 }),
        restoreSlotFromVersion: async () => false,
        updateWebpageMetadata: async () => true,
        'db:flush': async () => undefined,
        'db:invalidate': async () => undefined,
        ...over,
    });
}

const restore = (base) => fetch(`${base}/wp1/versions/v9/restore`, { method: 'POST' });

test("terugzetten schrijft een momentopname met source 'restore'", async (t) => {
    const calls = [];
    await withPatches(restorePatches(calls), () => withServer(t, OWNER, async (base) => {
        const res = await restore(base);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].source, 'restore',
            "zonder deze waarde was een terugzetpunt niet van een gewone save te onderscheiden");
        assert.strictEqual(calls[0].opts.actorUserId, 'alice');
    }));
});

test('de samenvatting zegt dat de rij van VÓÓR het terugzetten is, met het nummer erin', async (t) => {
    const calls = [];
    await withPatches(restorePatches(calls), () => withServer(t, OWNER, async (base) => {
        await restore(base);
        assert.strictEqual(calls[0].summary, 'Before restoring v9');
    }));
});

test('het regelverschil van het terugzetten wordt gemeten tegen de LEVENDE bestanden', async (t) => {
    const calls = [];
    // Nu 1 regel, straks 4 → +3.
    await withPatches(restorePatches(calls), () => withServer(t, OWNER, async (base) => {
        await restore(base);
        assert.strictEqual(calls[0].opts.lineDelta, 3);
    }));
});

test('BIJT: onleesbare huidige bestanden leveren geen 0 maar niets, en het terugzetten gaat door', async (t) => {
    const calls = [];
    await withPatches(restorePatches(calls, { readAllSlots: async () => { throw new Error('rustfs down'); } }), () =>
        withServer(t, OWNER, async (base) => {
            const res = await restore(base);
            assert.strictEqual(res.status, 200, 'niet kunnen meten mag het terugzetten niet blokkeren');
            assert.strictEqual(calls[0].opts.lineDelta, null, '0 zou zeggen dat er niets veranderde');
        }));
});

test('terugzetten geeft de bestanden terug die de editor moet her-baselinen', async (t) => {
    await withPatches(restorePatches([]), () => withServer(t, OWNER, async (base) => {
        const body = await (await restore(base)).json();
        assert.deepStrictEqual(body.files, { html: 'a\nb\nc\nd', css: '', js: '' });
    }));
});

// ── 7. De handmatige bewerking ────────────────────────────────────────

const shareReconciler = require('../core/webpages/webpageShareReconciler');

function savePatches(calls, over = {}) {
    return [
        ...patch(BASE_PAGE, {
            shouldAutoVersion: async () => true,
            // De OUDE bytes, zoals ze nu in de opslag staan.
            readSlot: async (_u, _id, slot) => (slot === 'html' ? 'a\nb\nc' : ''),
            createVersion: async (userId, id, summary, hashes, source, opts) => {
                calls.push({ summary, source, opts });
                return { id: 'v-auto', seq: 3 };
            },
            writeSlot: async () => ({ sha: 'new', size: 1 }),
            updateWebpageMetadata: async () => true,
            ...over,
        }),
        [shareReconciler, 'reSnapshotWebpageSharesDetached', () => {}],
    ];
}

const putHtml = (base, html) => fetch(`${base}/wp1`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ html }),
});

test('een handmatige bewerking heet naar waar hij gemaakt is, niet "Auto-save"', async (t) => {
    const calls = [];
    await withPatches(savePatches(calls), () => withServer(t, OWNER, async (base) => {
        const res = await putHtml(base, 'a\nb\nc\nd\ne');
        assert.strictEqual(res.status, 200);
        assert.strictEqual(calls.length, 1);
        assert.strictEqual(calls[0].summary, 'Edited in code');
        assert.strictEqual(calls[0].source, 'manual');
        assert.strictEqual(calls[0].opts.actorUserId, 'alice');
    }));
});

test('het regelverschil wordt gemeten tegen de bytes die er NU staan', async (t) => {
    const calls = [];
    // Oud: 3 regels. Nieuw: 5. → +2.
    await withPatches(savePatches(calls), () => withServer(t, OWNER, async (base) => {
        await putHtml(base, 'a\nb\nc\nd\ne');
        assert.strictEqual(calls[0].opts.lineDelta, 2);
    }));
});

test('BIJT: onleesbare oude bytes leveren null, en de save gaat gewoon door', async (t) => {
    const calls = [];
    await withPatches(savePatches(calls, { readSlot: async () => { throw new Error('rustfs down'); } }), () =>
        withServer(t, OWNER, async (base) => {
            const res = await putHtml(base, 'a\nb');
            assert.strictEqual(res.status, 200, 'een save mag nooit op een metinkje stuklopen');
            assert.strictEqual(calls[0].opts.lineDelta, null);
        }));
});

test('binnen het debounce-venster verschijnt er geen rij — dat blijft zo', async (t) => {
    const calls = [];
    await withPatches(savePatches(calls, { shouldAutoVersion: async () => false }), () =>
        withServer(t, OWNER, async (base) => {
            await putHtml(base, 'a\nb');
            assert.deepStrictEqual(calls, [],
                'toetsaanslagen horen samengevat te worden; alleen de AI-beurt is per stuk een gebeurtenis');
        }));
});

// ── 8. De sluitronde: "leeg" en "onleesbaar" komen niet op hetzelfde uit ──

test('onbereikbare opslag levert GEEN regelverschil bij het terugzetten', async (t) => {
    // `readSlot` GOOIT niet als RustFS weg is — hij antwoordt met ''. De
    // catch-tak die "niet gemeten" op null zet, vuurde daardoor nooit voor juist
    // het geval waarvoor hij geschreven is, en de rij kreeg ±0: de bewering "er
    // veranderde niets" uit een niet-meting.
    const calls = [];
    await withPatches(restorePatches(calls, {
        slotsAreReadable: () => false,
        readAllSlots: async () => ({ html: '', css: '', js: '' }),
    }), () => withServer(t, OWNER, async (base) => {
        const res = await fetch(`${base}/wp1/versions/v9/restore`, { method: 'POST' });
        assert.strictEqual(res.status, 200);
    }));
    assert.strictEqual(calls[0].opts.lineDelta, null,
        'niet kunnen meten is geen 0 — de rij hoort dan niets over regels te zeggen');
});

test('onbereikbare opslag boekt bij een handmatige save niet de hele tekst als aanwinst', async (t) => {
    const calls = [];
    await withPatches(savePatches(calls, {
        slotsAreReadable: () => false,
        readSlot: async () => '',
    }), () => withServer(t, OWNER, async (base) => {
        const res = await fetch(`${base}/wp1`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ html: 'a\nb\nc\nd' }),
        });
        assert.strictEqual(res.status, 200);
    }));
    assert.strictEqual(calls[0].opts.lineDelta, null,
        'de oude kant is nooit gelezen; +4 zou een verzonnen getal zijn');
});

test('een momentopname waarvan de bytes weg zijn wordt NIET teruggezet', async (t) => {
    // De rij bestaat, de objecten niet meer. Terugzetten zou lege strings over de
    // levende pagina schrijven — blanco — terwijl de bevestiging net beloofde dat
    // je het kon terugdraaien.
    const calls = [];
    await withPatches(restorePatches(calls, {
        getVersion: async () => ({
            id: 'v9', webpageId: 'wp1', seq: 9, source: 'manual', summary: 'x',
            contentLength: 2048, readable: false, html: '', css: '', js: '',
        }),
    }), () => withServer(t, OWNER, async (base) => {
        const res = await fetch(`${base}/wp1/versions/v9/restore`, { method: 'POST' });
        assert.strictEqual(res.status, 409);
        const body = await res.json();
        assert.strictEqual(body.code, 'snapshot_unreadable');
    }));
    assert.strictEqual(calls.length, 0, 'en er is ook geen pre-restore-rij geschreven');
});

test('het terugzetten zegt hoeveel extra bestanden er BUITEN vielen', async (t) => {
    const calls = [];
    await withPatches(restorePatches(calls, {
        listExtraFiles: async () => [{ path: 'modules/state.js' }, { path: 'about.html' }],
    }), () => withServer(t, OWNER, async (base) => {
        const res = await fetch(`${base}/wp1/versions/v9/restore`, { method: 'POST' });
        const body = await res.json();
        assert.strictEqual(body.extraFilesUntouched, 2,
            'een momentopname draagt alleen de slots; dat verzwijgen maakt van een half teruggezette pagina '
            + 'een hele');
    }));
});

test('de lijst zegt WAT een momentopname dekt, per projecttype', async (t) => {
    await withPatches(patch(BASE_PAGE), () => withServer(t, OWNER, async (base) => {
        const { body } = await getJson(`${base}/wp1/versions`);
        assert.ok(body.coverage, 'de lijst draagt een dekkingsverklaring');
        assert.strictEqual(body.coverage.extraFiles, false);
        assert.ok(body.coverage.slots.includes('html'));
        assert.strictEqual(body.coverage.coversProject, true, 'vanilla: de drie slots ZIJN het project');
    }));

    await withPatches(patch({ ...BASE_PAGE, settings: { framework: 'react-mui' } }), () =>
        withServer(t, OWNER, async (base) => {
            const { body } = await getJson(`${base}/wp1/versions`);
            assert.strictEqual(body.coverage.framework, 'react-mui');
            assert.strictEqual(body.coverage.coversProject, false,
                'op het STANDAARD projecttype woont de app in extra bestanden; een lege lijst betekent daar niet '
                + '"je hebt nog niet genoeg bewerkt"');
        }));
});
