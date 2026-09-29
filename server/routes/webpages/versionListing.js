/**
 * Een versierij zoals de geschiedenislijst hem mag lezen: met een maker, met
 * de gepubliceerde rij aangewezen, en met de eerlijke mededeling WAT een
 * momentopname op deze pagina wel en niet dekt.
 *
 * De routes (./versions.js) halen de rijen op; het duiden ervan gebeurt hier.
 */

const webpageStore = require('../../stores/webpageStore');
const userStore = require('../../stores/userStore');
const versionFacts = require('../../core/webpages/versionFacts');
const log = require('../../telemetry/log');

/**
 * Namen bij de `actor_user_id`'s van een lijst versierijen (W4).
 *
 * DE REGEL: een id dat niet te lezen is, is niet "jij" en niet leeg. Wat hier
 * niet opgelost raakt, blijft afwezig in de map, en versionFacts.actorOf maakt
 * daar een maker van die ONBEKEND is.
 *
 * De sessie gaat vóór de store, en dat scheelt in de praktijk élke query: een
 * webpagina is eigenaar-gescoped (elke schrijfweg loopt via getWebpage(id,
 * userId)), dus de maker van vrijwel elke rij ÍS de lezer. Pas als er een
 * ander id in de lijst staat — een pagina waarvan het eigendom ooit is
 * overgedragen — wordt de store één keer gebatcht bevraagd.
 *
 * `req.session.user` heeft geen vaste vorm (establishSession bewaart hem
 * verbatim: volledige gebruikersrij, OCS-object of een minimale
 * aanmeldvorm), dus alle drie de gebruikelijke naamvelden worden geprobeerd
 * en anders valt hij door naar de store.
 */
async function versionActorNames(rows, sessionUser) {
    const names = new Map();
    const self = sessionUser?.id || null;
    const selfName = sessionUser?.displayName || sessionUser?.name || sessionUser?.username || null;
    if (self && selfName) names.set(self, selfName);

    const missing = [...new Set(rows.map(r => r.actorUserId).filter(id => id && !names.has(id)))];
    if (missing.length === 0) return names;
    try {
        const found = await userStore.getUserAvatarsByIds(missing);
        for (const u of found || []) {
            const label = u.displayName || u.username || null;
            if (label) names.set(u.id, label);
        }
    } catch (e) {
        // Een mislukte naamopzoeking mag de geschiedenis niet kosten — de
        // rijen komen dan terug met een onbekende maker, wat waar is.
        log.warn('[Webpages] Version actor lookup failed:', e.message);
    }
    return names;
}

/** Eén rij zoals de geschiedenislijst hem mag lezen: id-loos, met een maker. */
/**
 * WAT een momentopname van deze pagina wél en niet vastlegt.
 *
 * Dit is geen sierveld. Een momentopname draagt alleen de drie primaire slots
 * plus de paginadatabank (stores/webpage/shared.js: VERSIONED_SLOTS), en op een
 * react-mui-pagina — het STANDAARDTYPE van elke nieuwe pagina — woont de app in
 * `src/*`, dus in EXTRA bestanden. De systeemprompt verbiedt het model zelfs om
 * de drie slots te schrijven (integrations/webpageFramework.js). Gevolg: op zo'n
 * pagina ontstaat er nooit een 'ai'- of 'manual'-rij, blijft de lijst leeg, en
 * las de auteur daar "je hebt nog niet genoeg bewerkt" — een verklaring die daar
 * niet waar is. Hij hoort te lezen dat de functie deze bestanden niet dekt.
 *
 * @returns {{slots:string[], extraFiles:boolean, framework:string, coversProject:boolean}}
 */
function versionCoverage(wp) {
    // Lokaal geladen, net als de andere webpageFramework-lezing in dit bestand:
    // de module trekt de hele frameworkcatalogus mee en dat hoeft niet op elke
    // route te drukken.
    const { resolveFramework } = require('../../integrations/webpageFramework');
    const framework = resolveFramework(wp);
    return {
        // De slots die daadwerkelijk in een momentopname belanden.
        slots: [...webpageStore.VERSIONED_SLOTS],
        // Extra bestanden zitten in GEEN enkele momentopname — niet op een
        // vanilla-pagina met `modules/state.js`, en niet op een react-pagina.
        extraFiles: false,
        framework,
        // Dekt de geschiedenis het project waar de auteur aan werkt? Op
        // react-mui is dat NEE: daar staat alles in extra bestanden.
        coversProject: framework !== 'react-mui',
    };
}

function decorateVersionRow(row, { viewerId, names, publishedVersionId }) {
    const { actorUserId, ...rest } = row;
    return {
        ...rest,
        actor: versionFacts.actorOf(actorUserId, { viewerId, names }),
        // De lijst hoeft de wijzer niet zelf te vergelijken; hier staat al vast
        // welke rij de gepubliceerde is.
        isPublished: !!publishedVersionId && row.id === publishedVersionId,
    };
}

module.exports = { versionActorNames, versionCoverage, decorateVersionRow };
