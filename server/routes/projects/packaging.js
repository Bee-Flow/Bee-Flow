/**
 * Blueprint packaging — export a Solution so it can be installed elsewhere.
 *
 * ── Two gates, and why each is where it is ─────────────────────────────────
 *
 * LICENCE, on each ROUTE, not on the router. This subtree shares the
 * `/api/projects` mount, which already carries the `projects` gate. A second
 * gate cannot be applied at the mount without gating all of projects — but it
 * cannot be `router.use(requireFeature(...))` on THIS router either: a
 * path-less `use` runs for every request that reaches this router, and
 * routes/projects.js mounts it with `router.use('/', require('./packaging'))`
 * BEFORE routes that have nothing to do with packaging, `PUT
 * /:id/conversations` among them. Those requests matched no route in this
 * file, but the gate ran before Express got the chance to say so, so an org
 * with `projects` but not `blueprint_packaging` got 403 `feature_locked` on
 * work that never touches a Blueprint. Fixed the same way — and for the same
 * reason — as `large_datasets` inside the studio-apps mount
 * (routes/studioAppDatasets.js): the gate is now the first handler of each
 * route below, which is the same chain for these routes and none for
 * anybody else's. featureMap.js documents the pairing.
 *
 * OWNER, per route. Export reads EVERY member of the project, including apps
 * and routines belonging to other members. Editor is not enough for that: an
 * editor can file their own work in and out, which is a different thing from
 * taking a copy of everyone's. The project's owner decides whether the Solution
 * leaves.
 *
 * Bodies are checked by closed schemas in ./schemas.js (validate()).
 *
 * Mounted from routes/projects.js, mirroring the routes/automation.js +
 * routes/automation/ pair the repo already proves.
 */

'use strict';

const express = require('express');
const { requireFeature } = require('../../license/middleware');
const { requireProjectRole } = require('../../auth/projectAccess');
const { captureSolution } = require('../../projects/packaging/capture');
const log = require('../../telemetry/log');
const { validate } = require('../../core/http/validate');
const S = require('./schemas');

const router = express.Router({ mergeParams: true });

// The whole subtree is a paid capability on top of `projects` — applied to
// each route below, never to the router (see the header).
const blueprintPackaging = requireFeature('blueprint_packaging');

/**
 * POST /:id/package/export — capture this project as a Blueprint.
 *
 * Returns the manifest as JSON rather than a download: what the caller does
 * with it (save, install elsewhere, diff against a previous version) is not
 * this route's business, and a JSON body is the only shape all three want.
 */
router.post('/:id/package/export', blueprintPackaging, requireProjectRole('owner'), validate({ body: S.ExportBody }), require('../../compliance/dataPortability/stampExport')('solutions'), async (req, res) => {
    try {
        const projectStore = require('../../stores/projectStore');
        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });

        const result = await captureSolution({
            project,
            // Stamped by the caller so capture stays a pure function of the
            // database's state and two runs can be compared.
            exportedAt: new Date().toISOString(),
        });
        if (!result.ok) return res.status(400).json({ error: result.errors.join(' ') });

        // `save` keeps it on the instance so another team can install it
        // without a file passing through anyone's downloads folder. Opt-in,
        // because a download is the more private default and the size ceiling
        // only applies to what is stored.
        //
        // PUBLISHING, not just saving (O4). `publishRelease` writes the gallery
        // row and the history row in one transaction — see its header for why a
        // failed history row must take the gallery row down with it, rather
        // than leaving a version that nobody can find back.
        //
        // DE NOTITIE KOMT VAN DE SERVER, NOOIT UIT DE REQUEST. Zij stond eerst
        // als `req.body?.notes` in deze aanroep, en dat was twee dingen tegelijk
        // fout. Ten eerste vulde niemand haar — de enige client stuurt `{save}`
        // — dus elke release kreeg `{}` en de Versies-tab las ELKE versie als
        // "niet vastgelegd". Ten tweede stond de schrijfkant open: de store
        // toetst alleen "plat object ≤ 64 KB", dus een eigenaar kon zelf een
        // `entities`-lijst posten en het scherm toonde die verzonnen lijst als
        // DE vastgelegde diff — met een entiteit die in werkelijkheid veranderde
        // netjes op 'unchanged'. De diff is een uitspraak van de server over
        // twee manifesten; die hoort de server te doen.
        let saved = null;
        if (req.body?.save) {
            try {
                const store = require('../../stores/blueprintStore');
                const notes = await releaseNotesFor({
                    store, project, userId: req.session.user.id, manifest: result.manifest,
                });
                const published = await store.publishRelease({
                    organizationId: project.organizationId || null,
                    createdBy: req.session.user.id,
                    sourceProjectId: project.id,
                    manifest: result.manifest,
                    notes,
                });
                saved = published.blueprint;
                await announcePublication(project.id, req.session.user.id);
            } catch (err) {
                // The capture succeeded; only publishing it failed. Hand back
                // the manifest anyway so the download still works, and say why.
                return res.json({ ...result.manifest, _saveError: err.message });
            }
        }

        // ── Het herkomstblok, gestempeld op wat de aanroeper meekrijgt ──────
        //
        // HIER en niet in `captureSolution`, om twee redenen die allebei over
        // volgorde gaan: het Blueprint-id bestaat pas nadat de publicatie
        // geslaagd is, en de naam van de organisatie is niets wat een capture
        // hoort te lezen — die kent alleen het project.
        //
        // Zonder publicatie blijft `blueprintId` null. Dat is de eerlijke
        // waarde: een gedownload bestand dat nooit gepubliceerd is, hoort bij
        // geen enkele galerijrij en mag daar dus ook niet naar wijzen.
        //
        // Wat er in dit blok terechtkomt is uitsluitend de eigen identiteit van
        // de EXPORTERENDE organisatie — geen persoon, geen lezerslijst, geen
        // gegevens uit een ander project. En wat de ontvanger ermee mag: niets
        // dat op toegang lijkt. Zie de kop van `readSource` in packaging/manifest.js.
        const source = {
            blueprintId: saved?.id || null,
            orgId: project.organizationId || null,
            orgName: await organizationNameFor(project.organizationId),
            version: saved?.version || result.manifest?.solution?.version || 1,
        };
        const { withSource } = require('../../projects/packaging/manifest');
        res.json(saved
            ? { ...withSource(saved.manifest, source), _savedAs: saved.id, _version: saved.version }
            : withSource(result.manifest, source));
    } catch (err) {
        log.error('[Projects] Blueprint export failed:', err.message);
        res.status(500).json({ error: 'Request failed' });
    }
});

/**
 * Hoe lang één zin mag duren, en hoe lang de hele tekstlaag.
 *
 * Publiceren mag NIET op een model wachten. `buildReleaseNotes` levert de
 * exacte boolean diff zonder één netwerkaanroep en verrijkt hem daarna met één
 * regel per gewijzigde entiteit; die verrijking is het enige dat tijd kost. Met
 * CONCURRENCY 3 in releaseNotes.js is de slechtste uitkomst hier ruwweg
 * NOTE_DEADLINE_MS plus één hangende aanroep van NOTE_CALL_TIMEOUT_MS — de
 * deadline wordt namelijk vóór elke await getoetst, niet tijdens. Vandaar
 * allebei fors onder de moduledefaults (15 s / 45 s): een publicatie die een
 * halve minuut stilstaat leest als kapot.
 */
const NOTE_CALL_TIMEOUT_MS = 6_000;
const NOTE_DEADLINE_MS = 12_000;

/**
 * De notitie bij deze publicatie, of null.
 *
 * Twee lagen (zie projects/packaging/releaseNotes.js): de EXACTE diff per
 * entiteit, die geen netwerk raakt en niet kan omvallen, plus een zin per
 * gewijzigde entiteit als er een model voor is. Valt de tweede laag om, dan
 * blijft de eerste staan; valt alles om, dan is de notitie null en publiceert
 * de release zonder — NOOIT een geweigerde publicatie wegens een notitie.
 *
 * Dat laatste is ook de reden voor het slot onderaan: `publishRelease` GOOIT op
 * een notitie boven `MAX_NOTES_BYTES`. `releaseNotesPayload` krimpt tot hij
 * past, maar hij krimpt tot ZIJN eigen grens; zakt de grens van de store daar
 * ooit onder, dan zou een publicatie stuklopen op een bijzaak. Daarom wordt hij
 * hier tegen de echte constante van de store gelegd, en niet tegen een kopie.
 */
async function releaseNotesFor({ store, project, userId, manifest }) {
    try {
        const previousManifest = await previousPublishedManifest({ store, project, userId });
        const { buildReleaseNotes, releaseNotesPayload } = require('../../projects/packaging/releaseNotes');
        const notes = await buildReleaseNotes({
            previousManifest,
            manifest,
            // Wiens model. Zonder gebruiker doet releaseNotes.js geen aanroep;
            // hier is die er altijd, want de route staat achter een sessie.
            userOrgId: project.organizationId || null,
            userId,
            timeoutMs: NOTE_CALL_TIMEOUT_MS,
            deadlineMs: NOTE_DEADLINE_MS,
        });
        const payload = releaseNotesPayload(notes);
        if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > store.MAX_NOTES_BYTES) {
            log.warn('[Projects] release notes did not fit; publishing without them');
            return null;
        }
        return payload;
    } catch (err) {
        // Een notitie is een bijzaak. Publiceren is dat niet.
        log.warn('[Projects] could not build release notes:', err.message);
        return null;
    }
}

/**
 * Het manifest dat de galerij NU voor dit project serveert — de linkerkant van
 * de diff.
 *
 * Precies de rij die `publishRelease` zo meteen gaat bumpen: zelfde
 * `solution_key`, zelfde maker, zelfde organisatie. De versieserie loopt per
 * maker, dus de vorige versie van DEZE serie is de enige eerlijke vergelijking;
 * de laatste release-rij van het project kan van een collega zijn.
 *
 * Org-scoping komt uit `listBlueprintsFor` — de ene scoping-query van de store —
 * en daarbovenop moet de rij van de aanroeper zelf zijn. Is er niets, dan is dit
 * de eerste publicatie en is alles 'added'; dan vertrekt er ook geen enkele
 * modelaanroep, want er valt niets te vergelijken.
 */
async function previousPublishedManifest({ store, project, userId }) {
    const readable = await store.listBlueprintsFor({
        userId, organizationId: project.organizationId || null,
    });
    const mine = (readable || []).find(b => b?.solutionKey === `sol_${project.id}` && b?.createdBy === userId);
    if (!mine?.id) return null;
    const full = await store.getBlueprintById(mine.id);
    return full?.manifest || null;
}

/**
 * Zeg dat er gepubliceerd is. EEN POKE, GEEN ANTWOORD.
 *
 * De Studio-schermen (SolutionDetail.jsx) verversen op `blueprint.published`
 * hun galerijlijst en hun releasegeschiedenis — allebei ORG-GESCOOPTE lezen die
 * zelf beslissen wat de lezer mag zien. Daarom draagt dit event geen
 * Blueprint-id, geen versienummer en geen naam: een projectlid dat buiten de
 * organisatie van de Blueprint valt zou anders via de activiteitenstroom een
 * versienummer op zijn scherm krijgen dat de galerijlijst hem juist onthoudt.
 *
 * Beide helften: `logActivity` voor de pollende fallback (project_activity), en
 * `emitProjectEvent` voor de live stroom. Geen van beide mag een publicatie die
 * al gecommit is alsnog laten mislukken — vandaar de eigen try.
 */
async function announcePublication(projectId, actorId) {
    try {
        await require('../../stores/projectStore').logActivity(projectId, actorId, 'blueprint.published', {});
        await require('../../core/projectFeed').emitProjectEvent(projectId, {
            kind: 'blueprint.published', actorId,
        });
    } catch (err) {
        log.warn('[Projects] could not announce a publication:', err.message);
    }
}

/**
 * De naam van een organisatie, of null.
 *
 * NOOIT GOOIEN: een export mag niet stuklopen omdat de organisatienaam niet te
 * lezen was. Null is bovendien geen verlies — de naam is beleefdheid voor de
 * ontvanger, geen dragend veld: het `orgId` staat er los van, en zelfs dat
 * beslist niets.
 */
async function organizationNameFor(organizationId) {
    if (typeof organizationId !== 'string' || !organizationId) return null;
    try {
        const org = await require('../../stores/userStore').getOrganization(organizationId);
        return typeof org?.name === 'string' && org.name ? org.name : null;
    } catch (err) {
        log.warn('[Projects] could not read the organisation name for a Blueprint:', err.message);
        return null;
    }
}

/**
 * A Blueprint, from wherever the caller has one.
 *
 * Either a file they uploaded, or one saved on this instance. Resolving a saved
 * id server-side rather than letting the client hand the manifest back means
 * the bytes that were stored are the bytes that get used.
 */
async function resolveManifest(req) {
    const { manifest, blueprintId } = req.body || {};
    if (blueprintId) {
        const store = require('../../stores/blueprintStore');
        const found = await store.getBlueprintById(blueprintId);
        const readable = store.canRead(found, {
            userId: req.session?.user?.id,
            organizationId: req.session?.user?.organizationId || null,
        });
        if (!found || !readable) return { status: 404, error: 'Not found' };
        // The id travels with the manifest so an install can record where the
        // Solution came from. Only the RESOLVED one: the caller's own
        // `blueprintId` is echoed nowhere, so a project can never claim
        // provenance from a Blueprint this caller could not read.
        //
        // `blueprintOrgId` komt van de GALERIJRIJ en niet uit het manifest: op
        // dit pad heeft de server de bron zelf gelezen, en dat is iets anders
        // dan wat een bestand over zichzelf beweert. install.provenanceOf laat
        // het vastgestelde altijd winnen van het beweerde.
        return { manifest: found.manifest, blueprintId: found.id, blueprintOrgId: found.organizationId || null };
    }
    if (!manifest) return { status: 400, error: 'No Blueprint in the request.' };
    // Een bestand: geen vastgestelde herkomst. Wat het manifest over zichzelf
    // zegt wordt pas in de installer gelezen, en daar als bewering behandeld.
    return { manifest, blueprintId: null, blueprintOrgId: null };
}

/**
 * Which entity kinds this caller's plan allows.
 *
 * Resolved once per kind rather than per entity, by the same rule requireFeature
 * enforces — a second implementation of "does this org have X" would eventually
 * disagree with the middleware.
 */
// The licence features the installer gates entity kinds on. Exported so the
// drift test can compare it against the `ctx.can(...)` calls in the installer.
const INSTALLER_FEATURES = ['app_studio', 'webpages', 'automations'];

async function capabilityPredicate(req) {
    const { featureAllowedForRequest } = require('../../license/middleware');
    const granted = new Map();
    // EVERY feature the installer asks about must be listed here. The predicate
    // ends in `granted.get(feature) === true`, so a name that was never fetched
    // reads as DENIED — which is the safe direction, but it means a missing
    // entry silently disables a whole entity kind instead of failing loudly.
    // That is exactly what happened to datatables: install.js gates them on
    // 'automations' (the licence feature /api/datatables itself uses), the name
    // was not in this list, and every table in a Blueprint was skipped at both
    // install and upgrade with "Tables are not part of this plan."
    // packaging.capabilities.test.js keeps the two in step.
    for (const feature of INSTALLER_FEATURES) {
        try {
            granted.set(feature, (await featureAllowedForRequest(req, feature)).allowed);
        } catch { granted.set(feature, false); }
    }
    return (feature) => granted.get(feature) === true;
}

/**
 * POST /:id/package/upgrade/plan — what a newer Blueprint would change here.
 *
 * Separate from applying, and deliberately: "3 will be updated, 1 you have
 * edited will be left alone" is a decision, and an upgrade that only tells you
 * afterwards is not offering one. Owner, like every packaging action on a
 * project — an upgrade rewrites other members' entities.
 */
router.post('/:id/package/upgrade/plan', blueprintPackaging, requireProjectRole('owner'), validate({ body: S.UpgradeBody }), async (req, res) => {
    try {
        const resolved = await resolveManifest(req);
        if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

        const { planUpgrade } = require('../../projects/packaging/upgrade');
        const result = await planUpgrade({ projectId: req.params.id, manifest: resolved.manifest });
        if (!result.ok) return res.status(400).json({ error: result.errors.join(' ') });
        res.json(result);
    } catch (err) {
        log.error('[Projects] Blueprint upgrade plan failed:', err.message);
        res.status(500).json({ error: 'Request failed' });
    }
});

/** POST /:id/package/upgrade — apply it. Replaces the untouched, keeps the rest. */
router.post('/:id/package/upgrade', blueprintPackaging, requireProjectRole('owner'), validate({ body: S.UpgradeBody }), async (req, res) => {
    try {
        const resolved = await resolveManifest(req);
        if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

        const { applyUpgrade } = require('../../projects/packaging/upgrade');
        const result = await applyUpgrade({
            projectId: req.params.id,
            manifest: resolved.manifest,
            ownerId: req.session.user.id,
            organizationId: req.session?.user?.organizationId || null,
            can: await capabilityPredicate(req),
            // Only the knowledge-base kind reads this, and only to ask "may
            // this person read this base" before it is linked into a project.
            req,
        });
        if (!result.ok) return res.status(400).json({ error: result.errors.join(' ') });
        res.json(result);
    } catch (err) {
        log.error('[Projects] Blueprint upgrade failed:', err.message);
        res.status(500).json({ error: 'Request failed' });
    }
});

/**
 * GET /:id/package/releases — de publicatiegeschiedenis van deze Oplossing.
 *
 * De galerijrij (`project_blueprints`) wordt bij elke publicatie OVERSCHREVEN en
 * is dus een uitspraak over het heden: "dit is wat er vandaag te installeren
 * valt". `project_releases` is de geschiedenis, één onveranderlijke rij per
 * publicatie, en dit is de enige route die haar naar buiten brengt.
 *
 * EIGENAAR, en niet lager. Dat is niet de gate van "wie mag dit project zien"
 * maar van "wie mag zien wat dit project ooit heeft uitgegeven": een release-rij
 * noemt per entiteit wat er veranderde, dus wie de geschiedenis leest leest een
 * inhoudsopgave van elke versie die er ooit is geweest — inclusief entiteiten
 * die er nu niet meer in zitten. Dezelfde rol als exporteren, om dezelfde reden.
 * De kop van `listReleases` in stores/blueprintStore.js noemt deze gate met
 * zoveel woorden: die functie autoriseert zelf niets.
 *
 * ── HET MANIFEST BLIJFT THUIS ──────────────────────────────────────────────
 *
 * `listReleases` levert de rijen al zonder manifest, en deze route beperkt ze
 * nog verder tot de vier velden die het scherm leest. Met de hand opgeschreven,
 * niet met sleutels-eraf: een kolom die volgend jaar aan `project_releases`
 * wordt toegevoegd bereikt de client dan niet vanzelf.
 *
 * `publishedBy` valt daar bewust buiten. Het is een gebruikers-id, het scherm
 * toont geen namen (het laadt de ledenlijst niet, zie SolutionDetail), en een
 * id waar niemand een naam bij kan zetten is alleen maar een id dat rondreist.
 *
 * `notes` gaat WEL mee en is het punt van deze route: daar zit de boolean diff
 * per entiteit in, plus — als het model die kon schrijven — één regel per
 * gewijzigde entiteit. De diff staat er altijd; de regel kan ontbreken, en de
 * Versies-tab houdt die twee uit elkaar.
 */
router.get('/:id/package/releases', blueprintPackaging, requireProjectRole('owner'), async (req, res) => {
    try {
        const releases = await require('../../stores/blueprintStore').listReleases(req.params.id);
        res.json({
            releases: (releases || []).map(r => ({
                id: r.id,
                version: r.version,
                notes: r.notes,
                publishedAt: r.publishedAt,
            })),
        });
    } catch (err) {
        // Een 500 — nooit `{ releases: [] }`. Een lege lijst leest als "deze
        // Oplossing is nooit gepubliceerd", en dat is precies het antwoord dat
        // een mislukte lees niet mag geven.
        log.error('[Projects] Blueprint release history failed:', err.message);
        res.status(500).json({ error: 'Request failed' });
    }
});

/**
 * GET /:id/package/installs — hoe vaak deze Oplossing is geïnstalleerd.
 *
 * Twee getallen: in de eigen organisatie, en elders op deze instantie. Verder
 * niets.
 *
 * ── De enige uitzondering op de org-scoping, en hoe smal zij is ────────────
 *
 * Blueprints zijn strikt org-gescoopt. Dit is het enige antwoord dat over die
 * grens heen kijkt, want een Blueprint wordt juist gedeeld met een ander team
 * en de maker heeft er recht op te weten dát er iets mee gebeurt. De
 * uitzondering is daarom zo klein gemaakt dat er niets anders uit kán komen:
 *
 *   • ALLEEN DE BRON. `requireProjectRole('owner')` op het project waar de
 *     Blueprint uit gemaakt is — dezelfde gate als exporteren, en dus per
 *     definitie iemand uit de bron-organisatie. Een installateur elders kan
 *     deze route voor die Blueprint niet bereiken: hij is geen eigenaar van
 *     dit project.
 *   • WELKE BLUEPRINTS ERBIJ HOREN komt uit `listBlueprintsFor` — de ENE
 *     org-scoping-query van de store (zie de kop van `canRead`). Er is hier
 *     geen tweede lezing die het met die query oneens kan raken; wat de lezer
 *     niet in zijn galerij ziet, telt hij hier ook niet.
 *   • DE PAYLOAD IS EEN ALLOW-LIST van twee getallen. Geen project-id, geen
 *     naam, geen eigenaar, geen organisatienaam, geen tijdstip, en geen
 *     uitsplitsing per organisatie — bij n=1 is een aggregaat over één
 *     organisatie geen aggregaat meer.
 *
 * ── Wat dit getal NIET kan zien, en dat is de eerlijke grens ───────────────
 *
 * Alleen deze database. Een bestand dat iemand op zijn eigen self-host
 * installeert is per definitie onzichtbaar, dus het scherm zegt "minstens n" en
 * nooit "n" (SolutionInstallsTab.jsx zet die zin er onvoorwaardelijk bij).
 *
 * WELKE ID'S MEETELLEN — en waarom de galerij alleen niet genoeg is. Gooit de
 * maker zijn Blueprint weg, dan verdwijnt hij uit `listBlueprintsFor` terwijl de
 * projecten die eruit geïnstalleerd zijn gewoon blijven bestaan mét hun
 * `installed_from_blueprint_id`. Met alleen de galerijlijst stond er dan
 * stellig "niemand heeft dit geïnstalleerd" — het antwoord waarop iemand
 * besluit een Oplossing weg te gooien. Daarom komen de id's uit de galerij ÉN
 * uit de eigen publicatiegeschiedenis van dit project (`listReleases`, gescoopt
 * op precies het project-id dat de gate hierboven heeft geautoriseerd). Beide
 * bronnen zijn al van deze lezer; er komt geen id bij uit een andere
 * organisatie.
 *
 * De grens daarvan is eerlijk en blijft de veilige kant op: de geschiedenis
 * bewaart de laatste twintig publicaties, dus een verwijderde Blueprint waarvan
 * óók alle release-rijen weggesnoeid zijn valt alsnog buiten de telling. Dat
 * maakt het getal lager, nooit hoger — en het scherm zegt "minstens".
 *
 * NUL BLIJFT DAARDOOR EEN ANTWOORD: geen galerijrij én geen enkele release-rij
 * betekent dat dit project nooit gepubliceerd is, en dan is "nul installaties"
 * geen gat maar een feit. Een mislukte lees is dat niet, en die eindigt dan ook
 * in de 500 hieronder — het scherm zegt dan "niet te lezen", niet "nul".
 */
router.get('/:id/package/installs', blueprintPackaging, requireProjectRole('owner'), async (req, res) => {
    try {
        const projectStore = require('../../stores/projectStore');
        const project = await projectStore.getProject(req.params.id);
        if (!project) return res.status(404).json({ error: 'Not found' });

        const store = require('../../stores/blueprintStore');
        const readable = await store.listBlueprintsFor({
            userId: req.session?.user?.id,
            organizationId: req.session?.user?.organizationId || null,
        });
        // De Blueprints die uit DIT project komen. `solution_key` is
        // `sol_<projectId>` (packaging/manifest.buildManifest), en de serie loopt
        // per maker — twee collega's die hetzelfde project publiceren hebben elk
        // hun eigen rij, en beide tellen mee.
        const ids = new Set((readable || [])
            .filter(b => b?.solutionKey === `sol_${project.id}`)
            .map(b => b.id));

        // …plus elke Blueprint waaronder dit project ooit gepubliceerd heeft.
        // Zonder deze tweede bron leest een verwijderde galerijrij als "nul
        // installaties". GEEN catch: kan de geschiedenis niet gelezen worden,
        // dan is de telling onbekend en hoort dat als 500 op het scherm te
        // komen, niet als nul.
        for (const release of (await store.listReleases(project.id)) || []) {
            if (typeof release?.blueprintId === 'string' && release.blueprintId) ids.add(release.blueprintId);
        }

        // "Hier" is de organisatie van de Blueprint zelf, en dat is die van het
        // project waar hij uit komt — niet die van de sessie. Voor de eigenaar
        // van dit project zijn dat dezelfde, behalve wanneer het project ooit
        // van organisatie is gewisseld; dan is de vraag "hoeveel bij ons" een
        // vraag over waar de Oplossing nú thuishoort.
        const counted = await store.countInstallsFor([...ids], { organizationId: project.organizationId || null });

        // Twee velden, met de hand opgeschreven. Niets van een projectrij en
        // niets van een galerijrij reist mee.
        res.json({
            installsHere: counted ? counted.here : null,
            installsElsewhere: counted ? counted.elsewhere : null,
        });
    } catch (err) {
        log.error('[Projects] Blueprint install count failed:', err.message);
        res.status(500).json({ error: 'Request failed' });
    }
});

/**
 * POST /package/install — install a Blueprint as a NEW Solution.
 *
 * Not under `/:id`: installing creates a project rather than acting on one, so
 * there is no project to hold a role on. The licence gate above still applies,
 * and the caller must be able to create a project at all — which the
 * `/api/projects` mount's own gate already decides.
 *
 * Capabilities are passed to the installer as a predicate rather than checked
 * up front, because a Blueprint carrying apps must still install its routines
 * on a plan without App Studio. Refusing the whole thing would make a
 * partly-usable Solution unusable.
 */
router.post('/package/install', blueprintPackaging, validate({ body: S.InstallBody }), async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const resolved = await resolveManifest(req);
        if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });
        const { manifest, blueprintId, blueprintOrgId } = resolved;
        const { name, resolutions } = req.body || {};

        const { installBlueprint } = require('../../projects/packaging/install');
        const organizationId = req.session?.user?.organizationId || null;
        const can = await capabilityPredicate(req);

        const result = await installBlueprint({
            // What the install wizard's Connect step collected: which table a
            // step should use, which HTTP credential, who approves. Handed
            // over raw — projects/packaging/resolutions.js is the one place
            // that decides what a resolutions body may contain, so a second
            // shape check here could only disagree with it.
            manifest, ownerId: userId, organizationId, name, blueprintId, blueprintOrgId,
            can, req, resolutions,
        });
        if (!result.ok) return res.status(400).json({ error: result.errors.join(' ') });

        res.json({ projectId: result.projectId, report: result.report });
    } catch (err) {
        log.error('[Projects] Blueprint install failed:', err.message);
        res.status(500).json({ error: 'Request failed' });
    }
});

/**
 * GET /package/blueprints — the Blueprints this caller could install.
 *
 * Meta only. A gallery is a list of things to choose from; the manifests are
 * multi-megabyte JSONB and nothing on the list screen reads them.
 */
router.get('/package/blueprints', blueprintPackaging, async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const blueprints = await require('../../stores/blueprintStore').listBlueprintsFor({
            userId, organizationId: req.session?.user?.organizationId || null,
        });
        res.json({ blueprints });
    } catch (err) {
        log.error('[Projects] Blueprint list failed:', err.message);
        res.status(500).json({ error: 'Request failed' });
    }
});

/**
 * GET /package/blueprints/:blueprintId — one Blueprint, manifest and all.
 *
 * The listing above is meta only, which is right for a gallery and wrong for
 * the install wizard: its first step says what is in the file and its second
 * says what the recipient has to connect, and both of those are read off the
 * manifest. Without this route a gallery install had to be a leap of faith
 * while a file install got the whole preview — the same act, two honesty
 * levels, decided by where the bytes happened to be.
 *
 * Gated by `canRead`, the same predicate resolveManifest uses before it will
 * install one: same-org, or the creator of a personal one. Reading a Blueprint
 * you may install is not a wider permission than installing it.
 */
router.get('/package/blueprints/:blueprintId', blueprintPackaging, async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });

        const store = require('../../stores/blueprintStore');
        const found = await store.getBlueprintById(req.params.blueprintId);
        const readable = store.canRead(found, {
            userId, organizationId: req.session?.user?.organizationId || null,
        });
        // One answer for "no such Blueprint" and "not yours to read", so this
        // route cannot be used to discover which ids exist in other orgs.
        if (!found || !readable) return res.status(404).json({ error: 'Not found' });

        res.json({ blueprint: found });
    } catch (err) {
        log.error('[Projects] Blueprint read failed:', err.message);
        res.status(500).json({ error: 'Request failed' });
    }
});

/** DELETE /package/blueprints/:blueprintId — creator only. */
router.delete('/package/blueprints/:blueprintId', blueprintPackaging, async (req, res) => {
    try {
        const userId = req.session?.user?.id;
        if (!userId) return res.status(401).json({ error: 'Not authenticated' });
        const ok = await require('../../stores/blueprintStore').deleteBlueprint(req.params.blueprintId, userId);
        if (!ok) return res.status(404).json({ error: 'Not found, or not yours to delete' });
        res.json({ success: true });
    } catch (err) {
        log.error('[Projects] Blueprint delete failed:', err.message);
        res.status(500).json({ error: 'Request failed' });
    }
});

module.exports = router;
module.exports.INSTALLER_FEATURES = INSTALLER_FEATURES;
