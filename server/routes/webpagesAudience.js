/**
 * "Wie ziet de pagina, en het adres" — de eigenaar-only REST-kant van de
 * vierde rij (Openbaar) en van de Adres-kaart.
 *
 *   GET /:id/audience          het hele model: de interne stand, de openbare
 *                              stand, het adres, de kolompoort en de oplossing
 *   PUT /:id/audience/public   openbaar aan/uit, mét de kolomkeuze
 *
 * De drie andere rijen (Persoonlijk / Organisatie / Groepen) lopen NIET langs
 * hier: die blijven op `PATCH /:id/publish`, waar ze al zaten, inclusief de
 * organisatie-validatie. Er is geen tweede weg naar dezelfde kolommen.
 *
 * ── EIGENAAR-ONLY, EN DAT IS GEEN FORMALITEIT ───────────────────────
 *
 * Dit scherm zegt welke KOLOMMEN van welke tabel naar buiten mogen, en toont
 * de ontvangerslijst van een e-mailgated link. Een org-lezer van de pagina
 * heeft daar niets te zoeken — hij zou langs deze weg de kolomnamen van
 * andermans tabel leren. Zelfde poort als webpagesGrants: eigenaar-gescoopte
 * lookup, 404 voor de rest, en de code wordt niet gelezen vóór die poort.
 *
 * ── WAT "OPENBAAR ZETTEN" PRECIES DOET ──────────────────────────────
 *
 *   1. de kolomkeuze wordt toegepast op de bindingen — ALTIJD, ook bij een
 *      lege keuze, want een tabel die in het antwoord ontbreekt gaat op nul;
 *   2. de pagina krijgt een adres (`ensureSlug`, idempotent);
 *   3. er komt een canonieke share, of de bestaande blijft;
 *   4. de snapshot wordt geschreven VOORDAT de wijzer verspringt;
 *   5. en elke ANDERE levende share van dezelfde pagina wordt óók opnieuw
 *      gesnapshot. De kolompoort geldt voor het adres én voor elke losse
 *      /share/<token>: een bevroren snapshot die vóór de versmalling is
 *      geschreven blijft anders de weggehaalde kolom serveren.
 *
 * Stap 4 is de volgorde die ertoe doet. Zou de wijzer eerst verspringen en de
 * snapshot daarna falen, dan wijst /w/<slug> naar een share zonder bytes: een
 * adres dat bestaat en niets toont. Nu blijft bij een mislukte snapshot alles
 * staan zoals het stond en komt er een 500 terug.
 */

'use strict';

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();

const webpageStore = require('../stores/webpageStore');
const publicAddress = require('../stores/webpage/publicAddress');
const bridgeGrants = require('../stores/webpage/bridgeGrants');
const publicShareStore = require('../stores/webpagePublicShareStore');
const webpageSnapshot = require('../services/webpageSnapshot');
const projectStore = require('../stores/projectStore');
const datatableAccess = require('../auth/datatableAccess');
const datatableRuntime = require('../core/dataEngine/datatableRuntime');
const audience = require('../core/webpages/webpagePublicAudience');
// Dit is het enige pad dat `bridge_grants.tables` herschrijft, en die lijst is
// de POORT waaruit de dependents-index zijn `mode` en `columns` haalt. Dus ook
// hier reconcilen — zie core/webpages/webpageUsageSync.js.
const webpageUsageSync = require('../core/webpages/webpageUsageSync');
const { requireAuth } = require('../auth/permissions');
const { validate } = require('../core/http/validate');
const { z } = require('zod');
const { worded, bodyOf, choice } = require('./webpages/schemas');
const sharingGate = require('./webpages/sharingGate');

// ── Wat "openbaar" mag dragen ───────────────────────────────────────
//
// Dit is de schakelaar tussen "alleen binnen Bee Flow" en "iedereen met het
// adres", en de body werd gelezen met terugvallen die allemaal de verkeerde
// kant op vielen:
//
//   - alleen `on === false` zette UIT. `"false"` (een string), `0` of een
//     vergeten `on` PUBLICEERDEN de pagina: share aangemaakt, snapshot
//     geschreven, token terug, onder een 200;
//   - een ontbrekende `publicColumns` zette elke gebonden tabel op nul
//     kolommen. Wie alleen het wachtwoord wilde wijzigen, wiste zo de
//     kolomkeuze;
//   - een fout in `accessMode`, een te kort wachtwoord of een vervaldatum in
//     het verleden werd pas NA stap 1 geweigerd. De kolomkeuze stond dan al
//     opgeslagen — ook een VERBREDE — en de eerstvolgende hersnapshot van een
//     levende link (webpageShareReconciler: een save, een rij die verandert)
//     serveerde de nieuwe kolommen, terwijl de eigenaar een 400 had gezien.
//
// Nu wordt alles wat de body zelf kan laten zien vóór stap 1 gemeten. Wat
// alleen tegen de bestaande share te toetsen is (een wachtwoord-share zonder
// nieuw wachtwoord, een geërfde e-mailmodus zonder lijst) blijft aan
// createShare, zoals voorheen.
const ON_TEXT = 'Say whether the page is public: on is true or false.';
const COLUMNS_TEXT = 'publicColumns maps each table to the columns that may be shown publicly, like { "tbl_1": ["name"] }.';
const COLUMNS_NEEDED = 'Say which columns may be shown publicly (publicColumns); send {} for none.';
const MODE_TEXT = 'accessMode is unlisted, password or email.';
const PASSWORD_TEXT = 'A password is text of at least 6 characters.';
const EMAIL_TEXT = 'Every allowed address is text.';
const EMAILS_NEEDED = 'An e-mail gated page needs at least one allowed address (allowedEmails).';
const EXPIRY_TEXT = 'expiresAt is a date, or null for no expiry.';

const NO_QUERY = z.object({}).strict('This takes no query parameters.');
const PublicBody = bodyOf({
    on: z.boolean({ required_error: ON_TEXT, invalid_type_error: ON_TEXT }),
    publicColumns: z.record(
        z.array(worded(COLUMNS_TEXT), { invalid_type_error: COLUMNS_TEXT }),
        { invalid_type_error: COLUMNS_TEXT },
    ).optional(),
    accessMode: choice(['unlisted', 'password', 'email'], MODE_TEXT).optional(),
    password: worded(PASSWORD_TEXT).min(6, PASSWORD_TEXT).optional(),
    allowedEmails: z.array(worded(EMAIL_TEXT).trim().min(1, EMAIL_TEXT), { invalid_type_error: EMAIL_TEXT }).optional(),
    expiresAt: z.union([z.string(), z.number(), z.null()], { errorMap: () => ({ message: EXPIRY_TEXT }) }).optional(),
}).superRefine((b, ctx) => {
    if (!b || b.on !== true) return;
    if (b.publicColumns === undefined) ctx.addIssue({ code: 'custom', path: ['publicColumns'], message: COLUMNS_NEEDED });
    if (b.accessMode === 'email' && !(b.allowedEmails && b.allowedEmails.length)) {
        ctx.addIssue({ code: 'custom', path: ['allowedEmails'], message: EMAILS_NEEDED });
    }
    if (b.expiresAt !== undefined) {
        try { parseExpiry(b.expiresAt, null); }
        catch (e) { ctx.addIssue({ code: 'custom', path: ['expiresAt'], message: /future/.test(e.message) ? 'expiresAt must be in the future.' : EXPIRY_TEXT }); }
    }
});

/**
 * De basis waarop /w/<slug> wordt uitgeschreven. Zelfde voorkeur als de
 * share-URL-bouwer: een expliciete env wint, anders de herkomst van het
 * verzoek — zodat een link uit een serveromgeving niet naar localhost wijst.
 */
function publicBaseUrl(req) {
    const configured = process.env.PUBLIC_SHARE_BASE_URL || process.env.PUBLIC_BASE_URL || '';
    if (configured) return configured.replace(/\/+$/, '');
    return `${req.protocol}://${req.get('host') || ''}`.replace(/\/+$/, '');
}

/** Eigenaar-gescoopte lookup; stuurt zelf de 404 en geeft dan null terug. */
async function ownedWebpage(req, res) {
    const wp = await webpageStore.getWebpage(req.params.id, req.session.user.id);
    if (!wp) {
        res.status(404).json({ error: 'Webpage not found' });
        return null;
    }
    return wp;
}

/**
 * De LEVENDE canonieke share, of null.
 *
 * Gaat langs `findLiveShareById`, dezelfde poort als /share/<token>: een
 * wijzer naar een ingetrokken of verlopen share leest hier als "niet
 * openbaar", precies zoals de bezoeker hem ziet. Het alternatief — de rij
 * tonen met een vlaggetje "ingetrokken" — zou het scherm laten zeggen dat de
 * pagina openbaar is terwijl het adres 404 geeft.
 */
async function liveCanonicalShare(webpage) {
    if (!webpage?.publicShareId) return { share: null, known: true };
    try {
        return { share: await publicShareStore.findLiveShareById(webpage.publicShareId), known: true };
    } catch (e) {
        // NIET stil naar null: "niet openbaar" is een bewering over
        // blootstelling, en die mag niet uit een mislukte lezing komen.
        log.warn('[Webpages/audience] could not read the canonical share:', e.message);
        return { share: null, known: false };
    }
}

/**
 * Alle LEVENDE shares van de pagina — het N-share-model blijft.
 *
 * Levend betekent hier hetzelfde als bij de bezoeker (`liveShareOrNull`): niet
 * ingetrokken én niet verlopen. Een verlopen link telt dus niet mee, want het
 * scherm gebruikt dit getal om te zeggen wat er nog openstaat.
 *
 * `null` bij een onleesbare lijst, NIET 0. "Er staat verder niets open" is een
 * bewering over blootstelling, en die mag net zomin uit een mislukte lezing
 * komen als `liveCanonicalShare`'s "niet openbaar".
 */
async function countLiveShares(webpageId, ownerId) {
    try {
        const list = await publicShareStore.listSharesForWebpage(webpageId, ownerId);
        const now = Date.now();
        return (list || []).filter(s => !s.revokedAt
            && !(s.expiresAt && new Date(s.expiresAt).getTime() < now)).length;
    } catch (e) {
        log.warn('[Webpages/audience] could not count the live shares:', e.message);
        return null;
    }
}

/**
 * Versmal ook de ANDERE levende shares van deze pagina.
 *
 * Een snapshot is bevroren: de rijen erin zijn server-side geschreven uit de
 * `publicColumns` van het moment waarop hij werd gemaakt. Herschrijven we na
 * een versmalling alleen de canonieke share, dan blijft elke losse
 * /share/<token> van dezelfde pagina de weggehaalde kolom gewoon serveren —
 * terwijl dit scherm zegt dat die kolom eruit is. Het N-share-model is hier
 * geen randgeval: POST /:id/public-shares maakt zulke losse shares, en het
 * intrekken ervan raakt het adres met opzet niet.
 *
 * Zonder createdBy-filter, dus ALLE shares van de pagina: elke levende link
 * draagt dezelfde poort, ongeacht wie hem heeft aangemaakt.
 *
 * Gooit zodra de lijst onleesbaar is of één share niet herschreven kon worden.
 * Dat is met opzet luid: er staat dan een link open met de oude, bredere
 * kolommen, en het antwoord mag geen smallere stand beweren dan er wordt
 * geserveerd.
 */
async function reSnapshotOtherLiveShares(wp, canonicalShareId) {
    const shares = await publicShareStore.listSharesForWebpage(wp.id, null);
    const failed = [];
    for (const sh of (shares || [])) {
        if (!sh || sh.revokedAt || sh.id === canonicalShareId) continue;
        try {
            await webpageSnapshot.writeSnapshot({ shareId: sh.id, webpageId: wp.id, ownerId: wp.userId });
        } catch (e) {
            log.error(`[Webpages/audience] re-snapshot failed for share ${sh.id}:`, e.message);
            failed.push(sh.id);
        }
    }
    if (failed.length > 0) {
        throw new Error(`${failed.length} other public link(s) still show the previous columns`);
    }
}

/** "Onderdeel van oplossing" — project_id omgekeerd gelezen. */
async function solutionOf(webpage) {
    if (!webpage?.projectId) return null;
    try {
        const p = await projectStore.getProject(webpage.projectId);
        return p ? { id: p.id, name: p.name || '' } : null;
    } catch {
        return null;
    }
}

/**
 * Zet een leesbare naam bij elke gebonden tabel — best-effort.
 *
 * Het kolomkeuzescherm vraagt "welke kolommen van DEZE tabel mogen naar
 * buiten", en `tbl_9f2a…` is daar geen antwoord op. Faalt de opzoeking (de
 * eigenaar mag de tabel niet meer lezen, de tabel is weg), dan blijft `label`
 * null en toont het scherm het id. Nooit een verzonnen naam, en nooit een
 * fout: de poort moet bedienbaar blijven ook als een binding scheef staat.
 */
async function decorateTableLabels(model, userId) {
    const rows = model?.columnGate?.tables || [];
    if (rows.length === 0) return model;
    let principal = null;
    try { principal = await datatableAccess.resolveDatatablePrincipalForUser(userId); }
    catch { return model; }
    for (const row of rows) {
        try {
            const resolved = await datatableRuntime.resolveForPrincipal(row.datatableId, principal, { needed: 'viewer' });
            row.label = resolved?.table?.name || null;
        } catch {
            row.label = null;
        }
    }
    return model;
}

async function buildModel(req, wp) {
    const grants = await bridgeGrants.getBridgeGrants(wp.id);
    const [canonical, shareCount, solution] = await Promise.all([
        liveCanonicalShare(wp),
        countLiveShares(wp.id, wp.userId),
        solutionOf(wp),
    ]);
    const model = audience.buildAudienceModel({
        webpage: wp,
        canonicalShare: canonical.share,
        canonicalShareKnown: canonical.known,
        shareCount,
        tables: grants.tables,
        // Dezelfde lezing, andere plak: `ai` draagt de publieke AI-schakelaar.
        // Geen extra I/O — `grants` staat hierboven al — en zonder deze regel
        // valt het model terug op "niet gelezen", niet op "uit".
        ai: grants.ai,
        solution,
        baseUrl: publicBaseUrl(req),
    });
    return decorateTableLabels(model, wp.userId);
}

router.get('/:id/audience', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
    try {
        const wp = await ownedWebpage(req, res);
        if (!wp) return;
        res.json(await buildModel(req, wp));
    } catch (err) {
        log.error('[Webpages/audience] load failed:', err);
        res.status(500).json({ error: 'Failed to load who can see this page' });
    }
});

/**
 * Openbaar aan of uit.
 *
 * Body:
 *   on             true | false
 *   publicColumns  { [datatableId]: string[] } — de poort. Ontbreekt een
 *                  gebonden tabel, dan gaat die op NUL kolommen.
 *   accessMode     'unlisted' | 'password' | 'email'
 *   password       alleen bij 'password'
 *   allowedEmails  alleen bij 'email'
 *   expiresAt      ISO-string of null
 */
router.put('/:id/audience/public', requireAuth, validate({ body: PublicBody }), async (req, res) => {
    try {
        const wp = await ownedWebpage(req, res);
        if (!wp) return;
        const userId = req.session.user.id;
        const body = req.body || {};

        if (body.on === false) {
            const share = wp.publicShareId ? await publicShareStore.getShareById(wp.publicShareId) : null;
            // Wijzer eerst weg, dan pas intrekken: valt de intrekking om, dan
            // is de pagina in elk geval niet meer "openbaar" volgens het adres.
            await publicAddress.setCanonicalShare(wp.id, userId, null);
            if (share && share.webpageId === wp.id && !share.revokedAt) {
                await publicShareStore.revokeShare(share.id, share.createdBy);
                await publicShareStore.deleteShare(share.id, share.createdBy).catch(() => {});
            }
            const fresh = await webpageStore.getWebpage(wp.id, userId);
            return res.json(await buildModel(req, fresh || { ...wp, publicShareId: null }));
        }

        // ── openbaar AAN ────────────────────────────────────────────────
        // 1. de poort. Altijd, en vóór alles: de snapshot verderop rendert
        //    bf-table uit precies deze lijst, dus dit moet al opgeslagen zijn
        //    voordat er ook maar één byte naar buiten gaat.
        const current = await bridgeGrants.getBridgeGrants(wp.id);

        // 0. the licence. Making a page public, or making a public page wider
        //    (more columns, a later expiry, weaker protection), is Enterprise:
        //    `webpage_sharing` (./webpages/sharingGate). It is asked before
        //    step 1, so a refusal leaves the column choice as it was. The
        //    canonical share is read here once, because "is it public yet"
        //    decides the question, and step 3 reuses that read. An unreadable
        //    share counts as widening: without the licence, nothing may be
        //    published on a state nobody could check.
        const canonical = await liveCanonicalShare(wp);
        const widens = !canonical.known
            || sharingGate.publicRequestWidens({ existing: canonical.share, currentTables: current.tables, body });
        if (widens && !(await sharingGate.allow(req, res))) return;

        const narrowed = audience.applyColumnChoice(current.tables, body.publicColumns);
        const saved = await bridgeGrants.updateBridgeGrants(wp.id, userId, { tables: narrowed });
        if (!saved) return res.status(404).json({ error: 'Webpage not found' });
        // `applyColumnChoice` versmalt vandaag alleen `publicColumns` en laat de
        // rest van de binding staan, dus de index verandert er meestal niet van.
        // De aanroep staat er toch: de regel is "elk pad dat de bindingen
        // vastlegt", niet "elk pad waarvan we vandaag weten dat het ertoe doet".
        webpageUsageSync.reconcileWebpageUsageDetached(wp.id);

        // 2. het adres. Idempotent — een pagina die eerder openbaar was, houdt
        //    hetzelfde /w/<slug>.
        let slug;
        try {
            slug = await publicAddress.ensureSlug(wp.id, userId, wp.name);
        } catch (e) {
            log.error('[Webpages/audience] could not mint an address:', e);
            return res.status(500).json({ error: 'Could not give this page an address' });
        }
        if (!slug) return res.status(404).json({ error: 'Webpage not found' });

        // 3. de share. Bestaat er al een levende canonieke met dezelfde
        //    toegangsinstelling, dan blijft die — een nieuw token zou elke
        //    gedeelde link breken zonder dat iemand daarom vroeg.
        const { share: existing, known: canonicalKnown } = canonical;
        // ONBEKEND IS HIER GEEN "er is er nog geen". Kon de huidige canonieke
        // share niet gelezen worden, dan leest `existing === null` hieronder als
        // "maak er maar een": er komt een TWEEDE levende link bij en het
        // intrekken van de oude wordt overgeslagen — die blijft dus staan met
        // het OUDE wachtwoord of de oude ontvangerslijst, terwijl het scherm
        // belooft dat links die mensen al hebben stoppen te werken. Onbekend
        // versmalt: niets publiceren, en het zeggen. De kolomkeuze uit stap 1
        // is al opgeslagen — die kant op (smaller) is veilig, en het antwoord
        // beweert niets anders.
        if (!canonicalKnown) {
            return res.status(500).json({
                error: 'Could not read the current public link for this page, so nothing was published. The column choice was saved; the existing link is unchanged. Please try again.',
            });
        }
        const accessMode = body.accessMode || (existing ? existing.accessMode : 'unlisted');
        const requested = {
            accessMode,
            // Alleen een wachtwoord-share heeft er iets aan. `accessOptionsChanged`
            // telt elk meegestuurd wachtwoord als een wijziging, en het paneel
            // houdt een eerder getypt wachtwoord vast nadat de keuze terug is
            // gezet op "unlisted" — dus elke opslag daarna sloeg een NIEUW token
            // en brak elke link die mensen al hadden.
            password: accessMode === 'password' ? body.password : undefined,
            allowedEmails: body.allowedEmails,
        };
        let expiresAt;
        try { expiresAt = parseExpiry(body.expiresAt, existing); }
        catch (e) { return res.status(400).json({ error: e.message }); }

        if (existing && !audience.accessOptionsChanged(existing, requested)) {
            if (body.expiresAt !== undefined) {
                await publicShareStore.updateExpiry(existing.id, existing.createdBy, expiresAt);
            }
            try {
                await webpageSnapshot.writeSnapshot({ shareId: existing.id, webpageId: wp.id, ownerId: wp.userId });
            } catch (e) {
                log.error('[Webpages/audience] re-snapshot failed:', e);
                return res.status(500).json({ error: 'Failed to publish this page: ' + e.message });
            }
            // De poort geldt voor élke levende link van deze pagina, niet
            // alleen voor het adres — anders serveert een losse /share/<token>
            // de zojuist weggevinkte kolom gewoon verder.
            try {
                await reSnapshotOtherLiveShares(wp, existing.id);
            } catch (e) {
                log.error('[Webpages/audience] not every public link was narrowed:', e);
                return res.status(500).json({ error: 'Column choice saved, but not every public link could be updated: ' + e.message });
            }
            const fresh = await webpageStore.getWebpage(wp.id, userId);
            return res.json(await buildModel(req, fresh || wp));
        }

        let created;
        try {
            created = await publicShareStore.createShare({
                webpageId: wp.id,
                createdBy: userId,
                organizationId: wp.organizationId || null,
                accessMode: requested.accessMode,
                password: requested.password,
                allowedEmails: audience.normalizeEmails(requested.allowedEmails),
                expiresAt,
                title: wp.name || '',
            });
        } catch (e) {
            // createShare gooit op een ongeldige modus, een te kort wachtwoord
            // of een lege ontvangerslijst — allemaal invoerfouten van dit
            // scherm, dus 400 met de eigen tekst.
            return res.status(400).json({ error: e.message || 'Could not create the public link' });
        }

        // 4. bytes vóór wijzer.
        try {
            await webpageSnapshot.writeSnapshot({ shareId: created.share.id, webpageId: wp.id, ownerId: wp.userId });
        } catch (e) {
            await publicShareStore.deleteShare(created.share.id, userId).catch(() => {});
            log.error('[Webpages/audience] snapshot failed:', e);
            return res.status(500).json({ error: 'Failed to publish this page: ' + e.message });
        }
        await publicAddress.setCanonicalShare(wp.id, userId, created.share.id);
        // De oude canonieke pas hierna intrekken: tot dit punt was zij het
        // werkende adres, en een fout hierboven mocht haar niet meenemen.
        if (existing) {
            await publicShareStore.revokeShare(existing.id, existing.createdBy).catch(() => {});
            await publicShareStore.deleteShare(existing.id, existing.createdBy).catch(() => {});
        }
        // Pas hierna de overige levende shares: de zojuist ingetrokken oude
        // canonieke hoeft niet meer herschreven te worden, de losse shares wel.
        try {
            await reSnapshotOtherLiveShares(wp, created.share.id);
        } catch (e) {
            log.error('[Webpages/audience] not every public link was narrowed:', e);
            return res.status(500).json({ error: 'Column choice saved, but not every public link could be updated: ' + e.message });
        }

        const fresh = await webpageStore.getWebpage(wp.id, userId);
        const model = await buildModel(req, fresh || { ...wp, slug, publicShareId: created.share.id });
        // Het onbewerkte token gaat één keer mee terug, net als bij POST
        // /:id/public-shares: er bestaat een tweede, token-gebaseerd adres
        // (/share/<token>) en dat is voor de eigenaar de enige kans om het te
        // zien. Het ADRES dat het scherm toont blijft /w/<slug>.
        res.json({ ...model, rawToken: created.rawToken });
    } catch (err) {
        log.error('[Webpages/audience] publish failed:', err);
        res.status(500).json({ error: 'Failed to change who can see this page' });
    }
});

/**
 * `expiresAt` uit de body, of die van de bestaande share als het veld ontbreekt.
 * Dezelfde regels als routes/webpages.js: leeg = geen vervaldatum, en een datum
 * in het verleden is een invoerfout, geen dode link.
 */
function parseExpiry(input, existing) {
    if (input === undefined) return existing?.expiresAt ? new Date(existing.expiresAt) : null;
    if (input === null || input === '') return null;
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) throw new Error('Invalid expires_at');
    if (d.getTime() < Date.now() + 60_000) throw new Error('expires_at must be in the future');
    return d;
}

module.exports = router;
module.exports.parseExpiry = parseExpiry;
