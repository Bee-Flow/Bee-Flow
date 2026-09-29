/**
 * Webpagina's — wie gebruikt er een (W5 deel B).
 *
 *   GET /:id/usage  →  { usage, unchecked, sources, complete }
 *
 * Voedt hetzelfde tabblad als elke andere soort: `shared/UsedByTab.jsx` via
 * `hooks/useUsage.js`, dat `webpage → webpages` al in `USAGE_KIND_PATH` heeft
 * staan met "W5" erachter. Het antwoord volgt daarom letterlijk de vorm van de
 * kennisbank (`routes/knowledgeBases/usage.js`) en de vergadernotitie
 * (`routes/transcriptions/usage.js`): `usage` is de lijst, `unchecked` de
 * soorten die niet beantwoord konden worden. De client hoeft niets te leren.
 *
 * ── EIGENAAR-GESCOOPT, ZOALS DE ANDERE WEBPAGINA-ROUTES ─────────────
 *
 * `webpageStore.getWebpage(id, userId)` is eigenaar-gescoopt in SQL; een
 * org-lezer die de pagina wél mag OPENEN krijgt hier 404, precies zoals bij
 * `routes/webpagesGrants.js` en `routes/webpagesAudience.js`. Dat is geen
 * strengheid om de strengheid: dit antwoord vertelt in welke Oplossing de
 * pagina ligt en dat er een bouwgesprek aan hangt. Dat is de werkindeling van
 * de eigenaar, en een gepubliceerde pagina is geen uitnodiging om die uit te
 * lezen. Dezelfde 404 als elke andere route op dit id, zodat deze niet te
 * gebruiken is om te achterhalen welke pagina-ids bestaan.
 *
 * ── DRIE VELDEN, DRIE VERSCHILLENDE UITSPRAKEN ──────────────────────
 *
 *   usage      wat er gevonden is. Rijen van een ander (een Oplossing van een
 *              collega) houden soort en rol en verliezen hun naam.
 *   unchecked  welke soorten NIET beantwoord konden worden. "Ik kon de agents
 *              niet nakijken" is een andere zin dan "geen agent gebruikt deze
 *              pagina", en alleen op de tweede mag iemand verwijderen. De
 *              verwijderpoort moet dit als IN GEBRUIK lezen — dezelfde regel
 *              die `routes/transcriptions/noteActions.js` vastlegt.
 *   sources    per soort de stand + `found`, in de vorm die
 *              `routes/studio/attention.js` voor "Vraagt aandacht" heeft
 *              gezet. `unchecked` is de platte samenvatting daarvan, zodat de
 *              bestaande client onveranderd blijft werken; `sources` is er
 *              voor het scherm dat WIL zeggen welke deelvraag omviel.
 *   complete   de vergunning om "niets gebruikt deze pagina" te zeggen.
 *
 * Vandaag is `complete` altijd false, omdat niet vast te stellen is welke
 * agents een pagina als tool mogen openen — zie de kop van
 * core/webpages/webpageUsage.js. Dat is de eerlijke stand, geen bug.
 *
 * Gemonteerd vanuit routes/webpages.js (`router.use(...)`), naast de
 * grants- en audience-routers, en dus vóór `GET /:id`.
 *
 * ── GEEN QUERY ──────────────────────────────────────────────────────
 *
 * De route leest alleen het id uit het pad. Een querysleutel viel stil weg:
 * `?kind=agent` kreeg álle soorten terug onder een 200, alsof dat filter
 * bestond. Nu is dat een 400 in één zin, zoals bij
 * `routes/transcriptions/usage.js`.
 */

const express = require('express');
const log = require('../telemetry/log');
const router = express.Router();

const webpageStore = require('../stores/webpageStore');
// Als MODULE-object, niet gedestructureerd: dat is wat routes/webpagesGrants.js
// ook doet, en het is de reden dat de test hiernaast de scan kan vervangen
// zonder een database.
const webpageUsage = require('../core/webpages/webpageUsage');
const { requireAuth } = require('../auth/permissions');
const { validate } = require('../core/http/validate');
const { z } = require('zod');

/** Niets. Gezegd in plaats van weggelaten: een genegeerde sleutel is een belofte. */
const NO_QUERY = z.object({}).strict('This usage list takes no parameters; it always covers every kind.');

router.get('/:id/usage', requireAuth, validate({ query: NO_QUERY }), async (req, res) => {
    try {
        const userId = req.session.user.id;
        const wp = await webpageStore.getWebpage(req.params.id, userId);
        if (!wp) return res.status(404).json({ error: 'Webpage not found' });

        const { rows, partial, sources, complete } = await webpageUsage.usageForWebpage(wp);
        res.json({
            usage: webpageUsage.redactForeign(rows, userId),
            unchecked: partial,
            sources,
            complete,
        });
    } catch (err) {
        // `usageForWebpage` vangt elke deelvraag apart op, dus hier belanden
        // betekent dat de opzoeking zelf omviel. Dan een 500 — nooit een leeg
        // `usage`, want dat is de ene zin die deze route niet per ongeluk mag
        // uitspreken.
        log.error('[Webpages] Usage error:', err.message);
        res.status(500).json({ error: 'Failed to load usage' });
    }
});

module.exports = router;
