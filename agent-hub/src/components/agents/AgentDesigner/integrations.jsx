import { INTEGRATION_CATALOG as CANONICAL_CATALOG, orderCategories } from '../../../config/integrationCatalog';
import { getIntegrationIcon } from '../../../config/integrationIcons';

/**
 * De app-catalogus van de agent-oppervlakken — AFGELEID, niet apart bijgehouden.
 *
 * ── DE VORK DIE HIER DICHTGING (A2 stap 4) ──────────────────────────
 * Dit bestand was een eigen `META`-lijst van 27 apps naast de canonieke lijst
 * in `config/integrationCatalog.js` (49). Twee handgeschreven catalogi voor
 * dezelfde vraag, en het verschil was geen detail: **geen enkele
 * Nextcloud-app stond erin**. Een zelfhostende klant kon Nextcloud Files,
 * Talk, Deck of Tables dus wél aan een automatisering hangen, maar niet aan een
 * agent — niet omdat dat verboden was, maar omdat de kiezer ze niet kende.
 * Hetzelfde gold voor GitHub, SignRequest, Maps, Withings, Browse Web,
 * Knowledge Base en Webpages.
 *
 * Zo'n vork dooft altijd dezelfde kant op: de lijst die het dichtst bij het
 * register staat groeit mee, de kopie verderop niet. De canonieke lijst zit
 * naast de org-admin- en integratieschermen die bij elke nieuwe integratie
 * worden aangeraakt; deze kopie werd alleen aangeraakt als iemand zich
 * herinnerde dat hij bestond.
 *
 * De naam en het pad blijven staan omdat vier oppervlakken hem zo importeren
 * (de wizard, de legacy AgentDesigner, PlanCard en de skill-editor). Wat dit
 * bestand nog toevoegt is de VORM die die oppervlakken nodig hebben en de
 * canonieke lijst niet draagt: een icoon-element en een `group`.
 *
 * ── `group` IS EEN POORT, GEEN RUBRIEK ──────────────────────────────
 * `filterAvailableIntegrations` (en twee kopieën ervan in de legacy designer)
 * doen `item.group === 'google'` en verbergen die apps voor wie niet met
 * Google inlogde. Die poort mag dus NIET uit de weergavecategorie komen:
 * "Google Maps" staat in de rubriek Google Workspace, maar draait op een
 * server-side API-sleutel (`google_maps_api_key`) en heeft niets aan een
 * Google-login. Afleiden uit de rubriek zou hem verbergen voor precies de
 * mensen die hem kunnen gebruiken.
 *
 * Daarom staat de OAuth-lijst hier expliciet, en is hij letterlijk de lijst
 * die vóór deze stage `group: 'google'` had. Wat de poort betreft verandert
 * er dus niets; alleen de apps die de poort niet aangaat, kwamen erbij.
 */

/**
 * De apps die de Google-login van de gebruiker lenen. Exact de negen die vóór
 * deze stage `group: 'google'` droegen — niet "alles in de rubriek Google".
 */
const GOOGLE_OAUTH_IDS = new Set([
    'gmail', 'google-calendar', 'google-drive', 'google-sheets', 'google-docs',
    'google-slides', 'google-contacts', 'google-keep', 'google-groups',
]);

/** Dezelfde vraag voor Microsoft: de vijf die de MS-login lenen. */
const MICROSOFT_OAUTH_IDS = new Set(['outlook', 'outlook-readonly', 'ms-calendar', 'onedrive', 'ms-contacts']);

/**
 * De `group` van een app: eerst de twee poorten, dan de rubriek als etiket.
 *
 * Alleen `'google'` heeft vandaag gedrag; de rest is een groepsnaam die
 * schermen gebruiken om te ordenen. Ze blijven bestaan omdat het oude bestand
 * ze had — maar niets hangt er een recht aan op.
 */
function groupOf(item) {
    if (GOOGLE_OAUTH_IDS.has(item.id)) return 'google';
    if (MICROSOFT_OAUTH_IDS.has(item.id)) return 'microsoft';
    if (item.category === 'Nextcloud') return 'nextcloud';
    if (item.category === 'AI & Media') return 'platform';
    return 'third-party';
}

// In rubriekvolgorde (dezelfde als de integratieschermen), zodat de kiezer
// niet met een willekeurige registervolgorde opent.
const CATEGORY_INDEX = new Map(
    orderCategories([...new Set(CANONICAL_CATALOG.map(i => i.category))]).map((c, i) => [c, i]),
);

export const INTEGRATION_CATALOG = [...CANONICAL_CATALOG]
    .sort((a, b) => {
        const byCategory = (CATEGORY_INDEX.get(a.category) ?? 99) - (CATEGORY_INDEX.get(b.category) ?? 99);
        if (byCategory !== 0) return byCategory;
        return String(a.label).localeCompare(String(b.label));
    })
    .map(item => ({
        id: item.id,
        label: item.label,
        description: item.description,
        category: item.category,
        group: groupOf(item),
        iconSvg: getIntegrationIcon(item.id),
    }));
