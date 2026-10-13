# Kwaliteitsronde Bee Flow — overdracht naar een lokale sessie

Deze map (`.quality-round/`) bevat alles wat een Claude Code-sessie nodig heeft om de
kwaliteitsronde op de branch `ccr-8c0edf67-243f59` af te maken. De map is werkmateriaal:
verwijder hem (of verplaats hem naar de interne repo) vóór de merge naar `main`.

Rapport (artifact, bijgewerkt per fase): https://claude.ai/artifact/8SEnJ2yyJKiYrRRhM89Ww5
Lokale kopie: `kwaliteitsronde.html` (gegenereerd door `build_quality.py`).

## Stand bij overdracht

| Fase | Status | Commit |
|---|---|---|
| 1. Kritiek en urgent dichten (21 items) | klaar | `babb0d35` |
| 2. Structuurgrenzen (auth-router, laag-guard, SCC-ratchet, moves, Studio, desktop IPC) | klaar | `9f1b34cc` |
| 3. Golf 1-splitsingen (15 bestanden) + per-bestand-groottebudget | klaar | zie `git log` |
| 4. Hergebruik (generator-manifest, mirrors, gedeelde helpers, data-laag, testkits) | **hier beginnen** | `phase4.workflow.js` |
| 5. Golf 2 en 3-splitsingen (35 bestanden, eerst karakteriseringstests) | daarna | `phase5.workflow.js` |
| 6. Best practices en ratchets | daarna | `phase6.workflow.js` |

Los van het plan: `4ddd5770` (PII-token is het antwoord als de gebruiker om de waarde vraagt).

Rapportcijfers (start → na fase 2): structuur 6 → 7, modulariteit 4 → 4, duplicatie 4 → 4,
best practices 5 → 6, tests 7 → 7. Verwachting na fase 6: 8 / 6-7 / 7 / 7-8 / 8.

## Bestanden in deze map

- `synthesis.json`: het volledige geverifieerde auditresultaat (41 bevindingen, structuur,
  50 splitsvoorstellen, 43 hergebruikitems, best practices, ratchets, plan, niet-nu).
  De workflow-agents lezen hun item hieruit.
- `progress.json`: status per item en per fase, plus de "nu"-cijfers en hermetingen; voedt
  het rapport. Bijwerken na elke fase (zie onder).
- `phase1-results.json` … `phase3-results.json`: de gestructureerde resultaten van de
  uitgevoerde agents (gedragsnotities en open vragen per item; lees de open vragen vóór fase 4).
- `phase4.workflow.js`, `phase5.workflow.js`, `phase6.workflow.js`: de Workflow-scripts.
- `build_quality.py` + `old_template.html`: genereren `kwaliteitsronde.html` uit
  `synthesis.json` en `progress.json`.
- `areas/`: de meetdata van de start (lange bestanden, clones, import-grafen) ter referentie.

## Zo ga je verder (per fase)

1. **Voorbereiding (eenmalig op de laptop)**
   - Node volgens `.nvmrc`; `npm ci` in `server`, `agent-hub`, `mobile`, `desktop`
     (`ELECTRON_SKIP_BINARY_DOWNLOAD=1`), `hub-module-sdk`, `nextcloud-connector`, root.
   - Python: `guard-service` en `classify-service` via `uv` of een venv met
     `requirements-dev.txt` (alleen nodig voor fase 6).
   - Postgres is niet nodig: de server-tests draaien op PGlite.
   - Handig: de `ci-local` MCP uit Bee-Flow-AI-internal (`ci_run {fast:true}` = dezelfde
     gates als GitHub).
2. **Workflow starten** (Claude Code, Workflow-tool), vanuit de repo-root:
   ```
   Workflow({ scriptPath: ".quality-round/phase4.workflow.js",
              args: { scratch: "<absolute pad naar>/.quality-round" } })
   ```
   `args.model` (standaard `opus`) overschrijft het model; op een 16-core-machine draaien
   tot 14 agents tegelijk, de scripts hebben 4-8 lanes dus dat past. Let op het geheugen
   bij agent-hub `vitest related` (149 workers voor één bestand): laat maximaal twee
   agent-hub-lanes tegelijk lopen of zet `--maxWorkers`.
3. **Valideren na de fase** (de agents draaien bewust geen volledige suites):
   - `npm run check:fast` (root), `npm run test:scripts`, `npm run lint:checks`,
     `npm run lint:workflows` als scripts/ of workflows geraakt zijn;
   - `cd server && npm test` (28k tests, ~15 min op 4 cores; `csv.test.js` faalt al vóór
     deze ronde, zie `scripts/test-exclusions.json` niet aanpassen);
   - `cd agent-hub && npx vitest related --run <gewijzigde bronbestanden>` +
     `npm run typecheck`; bij veel wijzigingen `npm run test:run`;
   - `cd desktop && npm run verify`; mobile: `./node_modules/.bin/jest --findRelatedTests`
     + `npm run typecheck` + `npm run lint` als mobile geraakt is (fase 4: H18).
   - Valkuil uit fase 2: `lint:source-text` en `lint:duplication` lezen `git ls-files`;
     stage (`git add -A`) vóór je ze draait, anders tellen nieuwe tests niet mee of
     struikelt de scanner over verplaatste tests.
4. **Committen per fase** op `ccr-8c0edf67-243f59` (één commit per fase, zie de eerdere
   commit-berichten voor de vorm; geen AI-attributie in de interne repo, wel de
   Co-Authored-By/Claude-Session-regels in deze repo). Geen deploy zonder expliciete vraag.
5. **Rapport bijwerken**: zet in `progress.json` de fase op `done` met een korte noot, de
   item-statussen (uit het workflow-resultaat), `scores_now` (met toelichting) en
   `metrics_now` (hermeet: `node scripts/scc-ratchet.mjs --list`, `node
   scripts/duplication-ratchet.mjs --list`, `node scripts/file-budget.mjs --list`); daarna
   `python3 .quality-round/build_quality.py` en publiceer `kwaliteitsronde.html` met de
   Artifact-tool naar de URL hierboven (`url` meegeven; eerst `read`).

## Regels die in elke fase gelden

- **Gedrag blijft gelijk.** Alleen pure moves, re-exports/shims, generatoren en gates.
  Toegestane uitzonderingen staan per item in de workflow-tekst (fase 4: H15 kiest het
  webgedrag voor `scheduleNextRun`; H16 toont een foutmelding in plaats van vals succes).
- Agents werken in lanes met disjuncte bestanden en committen niet; de orchestrator
  valideert en commit.
- Ratchets alleen omlaag; een nieuwe `lint:*` in de root `package.json` zodat
  `check:fast` hem oppakt; CLAUDE.md één regel per nieuwe gate.
- Gegenereerde bestanden (shared mirror) nooit met de hand bewerken.

## Open beslissingen voor de eigenaar (niet door agents te nemen)

- K5 deel 1: `component_designer` uit de standaard org-grant en `/ai/create-component`
  alleen voor admins (verandert wat leden kunnen). Deel 2: componentcode in een
  wegwerpcontainer/aparte uid zonder docker.sock.
- H1: replay-bescherming ook op `/api/automation/events/nextcloud` (vereist een
  connector-nonce, anders dubbele events binnen één seconde geweigerd).
- H2: pending-rijen kunnen nog gecycled worden (±600 pogingen per 15 min per org).
- Fase 4 CMS: `setProject` (volledige site-save) wint nog van gelijktijdige pagina-edits.
- `googleapis` → losse `@googleapis/*`-pakketten en OTel gericht instrumenteren
  (imagegrootte), als aparte fase na 6.

## Niet doen

- `scripts/test-exclusions.json` uitbreiden om een rode test te verbergen.
- Templates, fixtures, catalogi en `server/core/dataEngine/queryCompiler.js` splitsen
  (zie `not_now` in `synthesis.json`).
- Een prd- of dev-deploy starten.
