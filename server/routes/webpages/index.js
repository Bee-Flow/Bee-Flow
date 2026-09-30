/**
 * Webpage Routes — CRUD for webpages + source management + versions.
 *
 * Endpoints:
 *   POST   /                    — create webpage ({ name?, prompt?, sources? })
 *   GET    /                    — list user's webpages
 *   GET    /:id                 — get webpage detail (metadata + html/css/js bytes)
 *   PUT    /:id                 — update webpage (metadata and/or file slots)
 *   POST   /:id/clone           — duplicate webpage (skips publishing scope + external shares)
 *   DELETE /:id                 — delete webpage (purges DB rows + RustFS objects);
 *                                 409 `in_use` unless `?confirm=1` — see the
 *                                 guard above the handler
 *   POST   /:id/sources/file    — upload file source (pdf, docx, xlsx, txt, …)
 *   POST   /:id/sources/url     — add URL source
 *   POST   /:id/sources/text    — paste text source
 *   POST   /:id/sources/drive   — import from Google Drive / OneDrive
 *   GET    /:id/sources         — list sources
 *   POST   /:id/sources/:sid/retry  — retry a failed/cancelled source
 *   POST   /:id/sources/:sid/cancel — cancel a stuck source
 *   DELETE /:id/sources/:sid    — remove source
 *   GET    /:id/versions        — list version snapshots (metadata only)
 *   GET    /:id/versions/:vid   — get a single version (full file trio)
 *   POST   /:id/versions        — create a manual snapshot
 *   POST   /:id/versions/:vid/restore — restore a previous snapshot
 *   DELETE /:id/versions/:vid   — delete a version
 *   GET    /:id/draft-document     — the draft as one HTML document, bridges baked in
 *
 * ── Deze map ────────────────────────────────────────────────────────
 *
 * Dit bestand is het aanknooppunt en niets meer: het maakt de router, hangt de
 * middleware en de drie eigen sub-routers erop, en laat daarna elke
 * bronnengroep zijn eigen routes registreren. IN DEZELFDE VOLGORDE als toen
 * alles in één bestand stond — Express matcht op volgorde van registratie, dus
 * die volgorde is gedrag, geen smaak. Sub-routers zijn het bewust NIET: die
 * zouden een eigen middlewarelaag toevoegen.
 *
 *   schemas.js           de zod-woordenschat waaruit elk verzoekschema is gebouwd
 *   crud.js              de pagina zelf: POST / · GET / · GET /:id · PUT /:id
 *   createBrief.js       wat de bouwbalk meestuurt, gewogen en tot brief gemaakt
 *   publishing.js        thumbnail + org/groep-publicatie
 *   publishedSnapshot.js welke bytes een niet-eigenaar leest, en hoe ze gepind worden
 *   publicShares.js      externe deel-links + het vernieuwen van hun momentopnames
 *   files.js             extra bestanden en binaire assets
 *   previewToken.js      het token voor de gesandboxte preview-iframe
 *   draftDocument.js     the draft as one ready-to-run document (the phone's preview)
 *   pageDatabase.js      de paginadatabank achter de sessie
 *   chat.js              de chatgeschiedenis van de bouw-AI
 *   lifecycle.js         klonen en verwijderen
 *   deleteGuard.js       de 409-poort die DELETE /:id eerst stelt
 *   sources.js           bestand/URL/tekst/Drive + retry, cancel, verwijderen
 *   versions.js          de versiegeschiedenis
 *   versionListing.js    hoe een versierij gelezen hoort te worden
 */

const express = require('express');
const router = express.Router();
const multer = require('multer');

const { requireActiveOrgForMutations } = require('../../auth');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// Wat de bronnengroepen van dit aanknooppunt meekrijgen. De multipart-poort is
// de enige gedeelde: twee groepen (assets, bronbestanden) uploaden, en dat moet
// dezelfde instantie met dezelfde limiet zijn.
const deps = { upload };

// Access control: the beta-feature gate at server/index.js (`requireBetaFeature('webpages')`)
// is the single source of truth. The previous `requirePermission('use_webpages')` here was
// redundant and blocked org members who had the beta enabled but not the legacy permission.

// Block writes when the caller's org is suspended/archived.
router.use(requireActiveOrgForMutations());

// Bridge-grant management for the IDE "Apps & data" panel — owner-only REST
// surface over the same integrations/webpageGrants module the studio AI uses.
router.use(require('../webpagesGrants'));
// "Wie ziet de pagina, en het adres" (W3 stap 4) — de vierde rij (Openbaar) en
// de Adres-kaart. Eigenaar-only, en bewust een eigen bestand: dit is de enige
// plek die de kolompoort `publicColumns` schrijft.
router.use(require('../webpagesAudience'));
// "Wie gebruikt deze pagina" (W5 deel B) — het Gebruikt-door-tabblad en de
// verwijderbevestiging. Eigen bestand om dezelfde reden als de twee hierboven:
// dit is de enige plek die per deelvraag mag zeggen dat zij NIET gecontroleerd
// is, en dat onderscheid overleeft geen plek tussen de CRUD-routes.
router.use(require('../webpagesUsage'));

require('./crud').register(router, deps);
require('./publishing').register(router, deps);
require('./publicShares').register(router, deps);
require('./files').register(router, deps);
require('./previewToken').register(router, deps);
require('./draftDocument').register(router, deps);
require('./pageDatabase').register(router, deps);
require('./chat').register(router, deps);
require('./lifecycle').register(router, deps);
require('./sources').register(router, deps);
require('./versions').register(router, deps);

module.exports = router;
