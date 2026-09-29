/**
 * Wanneer een openbare snapshot opnieuw geschreven moet worden.
 *
 * Een publieke share is geen levende pagina maar een BEVROREN, script-vrije,
 * door DOMPurify gehaalde momentopname (services/webpageSnapshot.js). Op
 * /w/<slug> draait geen `beeflowTables`; de tabelrijen die daar staan zijn
 * server-side uit `publicColumns` gerenderd op het moment dat de snapshot
 * werd geschreven. Dat is precies wat een publieke pagina veilig maakt — en
 * precies waarom hij zichzelf niet bijwerkt.
 *
 * ── WAAROM DIT EEN AVG-PAD IS, GEEN VERVERSKNOPJE ───────────────────
 *
 * Tot nu toe werd een snapshot alleen herschreven als de EIGENAAR de pagina
 * opsloeg (routes/webpages.js). Voor de bytes van de pagina klopt dat. Voor de
 * RIJEN die erin gebakken zitten niet:
 *
 *   - de retentiesweep verwijdert een rij die te oud is;
 *   - iemand oefent zijn recht op verwijdering uit (DSR) en zijn rij gaat weg;
 *   - een routine wist een rij.
 *
 * In alle drie de gevallen is de rij uit de tabel verdwenen en staat hij nog
 * gewoon op de openbare pagina, voor iedereen met het adres, tot de eigenaar
 * toevallig iets opslaat. Een gewiste rij die op een publieke snapshot blijft
 * staan is geen verouderde cache maar een verwijdering die niet heeft
 * plaatsgevonden. Daarom hangt deze module aan dezelfde tap als de live
 * kennisbronnen (K8): `datatableStore.notifyDatatableChanged` — één
 * gedebouncede melding per tabel, na elke schrijfweg die er is, de
 * retentiesweep inbegrepen.
 *
 * ── WAT DIT NIET IS ─────────────────────────────────────────────────
 *
 * Geen garantie en geen synchroniciteit. De tap is een in-process timer: hij
 * overleeft geen herstart en kruist geen replica. Er staat dus "binnen de
 * sync-latentie", niet "onmiddellijk", en wie harde verwijdering nodig heeft,
 * trekt de share in — dát is het enige dat direct werkt. Wat deze module
 * verwijdert, verwijdert hij best-effort; wat hij niet haalt, blijft staan tot
 * de volgende aanleiding. Een backstop zoals `armStaleLiveSources` die voor de
 * kennisbronnen bestaat, is hier nog niet gebouwd (zie openPunten).
 *
 * ── FAALT DICHT, NIET OPEN ──────────────────────────────────────────
 *
 * Kan de lijst gebonden pagina's niet worden gelezen, dan wordt er NIETS
 * herschreven en staat dat in het log. Er is geen tak die bij twijfel "dan
 * maar alles" of "dan maar niets, stil" doet: een onleesbare lijst is een
 * bekend-onbekend en hoort luid te zijn.
 */

'use strict';

const bridgeGrants = require('../../stores/webpage/bridgeGrants');

/**
 * Herschrijf elke levende publieke snapshot van ÉÉN pagina.
 *
 * Verplaatst uit routes/webpages.js zodat er één implementatie is: de route
 * roept hem aan bij een eigenaar-save, deze module bij een tabelmutatie. Twee
 * kopieën zouden betekenen dat de ene wel en de andere niet de ingetrokken
 * shares overslaat.
 *
 * `await`-baar, maar de aanroepers in de routes gebruiken hem fire-and-forget:
 * een save mag nooit wachten op een snapshot.
 */
async function reSnapshotWebpageShares(webpageId, ownerId, deps = {}) {
    const publicShareStore = deps.publicShareStore || require('../../stores/webpagePublicShareStore');
    const webpageSnapshot = deps.webpageSnapshot || require('../../services/webpageSnapshot');
    const log = deps.log || console;
    let written = 0;
    try {
        const shares = await publicShareStore.listSharesForWebpage(webpageId, ownerId);
        for (const sh of (shares || [])) {
            if (sh.revokedAt) continue;
            try {
                await webpageSnapshot.writeSnapshot({ shareId: sh.id, webpageId, ownerId });
                written += 1;
            } catch (e) {
                log.warn(`[Webpages] re-snapshot failed for share ${sh.id}: ${e.message}`);
            }
        }
    } catch (e) {
        log.warn(`[Webpages] re-snapshot enumeration failed: ${e.message}`);
    }
    return written;
}

/** Fire-and-forget-variant voor de routes: nooit awaiten, nooit gooien. */
function reSnapshotWebpageSharesDetached(webpageId, ownerId, deps = {}) {
    Promise.resolve()
        .then(() => reSnapshotWebpageShares(webpageId, ownerId, deps))
        .catch(() => { /* reSnapshotWebpageShares logt zelf al */ });
}

/**
 * De rijen van deze tabel zijn veranderd — vernieuw elke openbare pagina die
 * eraan hangt.
 *
 * Aangeroepen vanaf `datatableStore.notifyDatatableChanged`, dezelfde
 * gedebouncede tap die de live kennisbronnen wapent. Best-effort en zonder
 * ooit te gooien: hij hangt achter een schrijfactie die al gecommit is.
 *
 * @returns het aantal pagina's waarvoor iets is herschreven
 */
async function onDatatableChanged(datatableId, deps = {}) {
    if (!datatableId) return 0;
    const grants = deps.bridgeGrants || bridgeGrants;
    const log = deps.log || console;
    let bound;
    try {
        bound = await grants.listPublicWebpagesBoundToDatatable(datatableId);
    } catch (e) {
        // Onbekend versmalt: niets herschrijven, en het luid zeggen. Stil
        // doorlopen zou betekenen dat een gewiste rij blijft staan zonder dat
        // er ergens een spoor van is.
        log.warn(`[Webpages] could not list pages bound to datatable ${datatableId}: ${e.message}`);
        return 0;
    }
    if (!bound || bound.length === 0) return 0;
    let pages = 0;
    for (const page of bound) {
        const written = await reSnapshotWebpageShares(page.webpageId, page.ownerId, deps);
        if (written > 0) pages += 1;
    }
    if (pages > 0) {
        log.log(`[Webpages] datatable ${datatableId} changed — re-snapshotted ${pages} public page(s)`);
    }
    return pages;
}

module.exports = {
    reSnapshotWebpageShares,
    reSnapshotWebpageSharesDetached,
    onDatatableChanged,
};
