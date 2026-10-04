import { countFor } from '../../../../hooks/useStudioCounts';
import { cardChrome } from '../../../automation/Builder/flow/nodeTypeColors';
import { cardRadius as kindCardRadius, kindColorVar } from '../../../shared/kindColors';
import { STUDIO_CATEGORIES } from '../studioApps';
import { studioAppForKind } from '../studioNav';

/**
 * De kaart op het Startscherm van Studio: de twaalf bouwstenen en de twaalf
 * manieren waarop ze aan elkaar hangen. Dit bestand is het MODEL — de
 * handgelegde coördinaten, de randen en de meetkunde. StudioMap.jsx tekent.
 *
 * ── DIT IS BEWUST GEEN LIVE ORG-BREDE GRAPH ────────────────────────────────
 *
 * Niet uit gemak, en niet omdat de data ontbreekt: het argument staat
 * uitgeschreven in components/admin/Studio/Solutions/ProjectFlowTab.jsx (regel 1-18) en het
 * blijft staan. Wat een bouwer uit zo'n plaat wil weten is "wat hangt van wat
 * af, en wat is stuk", en een handgelegde knopentekening beantwoordt dat op
 * deze schaal slechter dan proza — terwijl ze een layout-engine kost en veel
 * manieren om op een smal scherm fout te lijken. Daarom is de LEVENDE graph
 * per oplossing gebouwd (server/projects/graph.js + Track O), waar de knopen
 * geteld zijn, de eigenaren bekend en een kapotte rand een zin krijgt.
 *
 * Wat hier staat is dus een LEGENDA, geen inventaris. Ze tekent de SOORTEN en
 * de SOORTEN RANDEN die het product kent — nooit iemands eigen objecten. De
 * getallen op de tegels komen los daarvan uit GET /api/studio/counts.
 *
 * Wie dit later alsnog tot een levende org-brede graph wil promoveren: lees
 * eerst ProjectFlowTab.jsx:1-18 en graph.js:1-64. Beide leggen uit waarom een
 * org-brede knopentekening precies de vraag níet beantwoordt.
 *
 * ── Handgelegd betekent: dit veroudert ─────────────────────────────────────
 *
 * De coördinaten hieronder zijn met de hand gekozen. Komt er een elfde
 * bouwsteen bij, dan heeft die geen plek op deze kaart en zou de plaat er
 * stilletjes onvolledig bij liggen. Daartegen is één verdediging, en die
 * staat in studioMap.test.js: de soorten in MAP_BLOCKS worden vergeleken met
 * KIND_KEYS uit shared/kindColors.js (het register), en de test wordt rood
 * zodra ze uiteenlopen — in beide richtingen. Herleg de kaart, dan.
 */

/* ── Meetkunde ────────────────────────────────────────────────────────────── */

export const TILE_W = 160;
export const TILE_H = 46;
export const MAP_W = 700;
export const MAP_H = 534;

/**
 * De drie lanen zijn de categorieën van het register (STUDIO_CATEGORIES), in
 * dezelfde volgorde als de rail ze toont: Bouwen · AI · Bundelen. Het LABEL
 * komt straks uit dat register, zodat de laan op de kaart niet anders kan
 * heten dan de kop op de rail. Alleen de band-coördinaten staan hier.
 */
export const MAP_LANES = Object.freeze([
    Object.freeze({ id: 'build', y: 8, h: 236 }),
    Object.freeze({ id: 'ai', y: 260, h: 158 }),
    Object.freeze({ id: 'bundle', y: 434, h: 92 }),
]);

/**
 * Soorten die shared/kindColors.js WEL een kleur geeft, maar die hier niet
 * horen: ze zijn geen bouwsteen die je in de Studio maakt. De drifttest legt
 * de kaart tegen KIND_KEYS MIN deze lijst — een nieuwe soort moet dus of op
 * de plaat, of hier met een reden. Stilzwijgend weglaten kan niet.
 *
 *   compliance — een gebied dat je BEHEERT, geen ding dat je maakt. Het woont
 *                in organisatie-instellingen (Compliance Center, sep 2026) en
 *                staat in kindColors alleen zodat de header, de tegel in de
 *                instellingennav en de eigen rail één token delen.
 */
export const KINDS_OFF_MAP = Object.freeze(['compliance']);

/**
 * De twaalf bouwstenen. `kind` is de sleutel uit shared/kindColors.js; kleur,
 * glyph en tegelvorm komen daarvandaan, het label en de teller uit het
 * Studio-register (zie blockMeta). x/y zijn handgelegd: kolom a=28, b=262,
 * c=496 en de rij-hoogtes per laan.
 */
export const MAP_BLOCKS = Object.freeze([
    Object.freeze({ id: 'form', kind: 'form', lane: 'build', x: 28, y: 38 }),
    Object.freeze({ id: 'webpage', kind: 'webpage', lane: 'build', x: 28, y: 100 }),
    Object.freeze({ id: 'app', kind: 'app', lane: 'build', x: 28, y: 162 }),
    Object.freeze({ id: 'automation', kind: 'automation', lane: 'build', x: 262, y: 100 }),
    Object.freeze({ id: 'datatable', kind: 'datatable', lane: 'build', x: 496, y: 38 }),
    // Kolom c, middelste rij: de automatisering in het midden waaiert naar rechts
    // uit naar tabel (boven), document (recht) en goedkeuring (onder). De
    // vrije plek in kolom b lag in het pad van app→goedkeuring — de
    // meetkundetest in studioMap.test.js ving dat.
    Object.freeze({ id: 'document', kind: 'document', lane: 'build', x: 496, y: 100 }),
    Object.freeze({ id: 'meeting', kind: 'meeting', lane: 'ai', x: 28, y: 282 }),
    Object.freeze({ id: 'kb', kind: 'kb', lane: 'ai', x: 262, y: 282 }),
    Object.freeze({ id: 'agent', kind: 'agent', lane: 'ai', x: 28, y: 356 }),
    Object.freeze({ id: 'skill', kind: 'skill', lane: 'ai', x: 496, y: 356 }),
    Object.freeze({ id: 'playbook', kind: 'playbook', lane: 'bundle', x: 262, y: 464 }),
    Object.freeze({ id: 'solution', kind: 'solution', lane: 'bundle', x: 28, y: 464 }),
]);

/**
 * De laatste doos, en de enige die géén bouwsteen is.
 *
 * Twee van de twaalf randen wijzen naar een goedkeuring, en een goedkeuring is
 * niets wat je MAAKT: ze bestaat pas op het moment dat een app of een automatisering
 * erom vraagt. server/projects/graph.js tekent haar om dezelfde reden als een
 * SYNTHETISCHE knoop (graph.js:32-40). Weglaten zou de kaart twee randen
 * armer maken en de belangrijkste eigenschap van beide verzwijgen: dat er een
 * mens tussen staat. Ze krijgt dus een gestippelde doos zonder kind-kleur, en
 * nooit een teller — goedkeuringen worden niet geteld.
 */
export const MAP_SYNTHETIC = Object.freeze([
    Object.freeze({
        id: 'approval', kind: null, synthetic: true, lane: 'build', x: 496, y: 162,
        labelKey: 'studio.map.approval', labelFallback: 'Approval',
    }),
]);

/** Elke getekende doos, bouwsteen of niet. */
export const MAP_NODES = Object.freeze([...MAP_BLOCKS, ...MAP_SYNTHETIC]);

const NODE_BY_ID = new Map(MAP_NODES.map((n) => [n.id, n]));

/** De doos met dit id, of null. */
export function mapNode(id) {
    return NODE_BY_ID.get(id) || null;
}

/* ── De twaalf randen ───────────────────────────────────────────────────────── */

/**
 * De negen werkwoorden die over de twaalf randen lopen. Eén rand draagt er twee
 * (een automatisering LEEST en SCHRIJFT een tabel): dat zijn twee verschillende
 * risico's op dezelfde verbinding, en graph.js houdt ze om die reden ook
 * apart binnen één paar.
 */
export const VERB_LABEL = Object.freeze({
    runs: Object.freeze({ labelKey: 'studio.map.verb_runs', labelFallback: 'runs' }),
    asks: Object.freeze({ labelKey: 'studio.map.verb_asks', labelFallback: 'asks' }),
    calls: Object.freeze({ labelKey: 'studio.map.verb_calls', labelFallback: 'calls' }),
    reads: Object.freeze({ labelKey: 'studio.map.verb_reads', labelFallback: 'reads' }),
    writes: Object.freeze({ labelKey: 'studio.map.verb_writes', labelFallback: 'writes' }),
    uses: Object.freeze({ labelKey: 'studio.map.verb_uses', labelFallback: 'uses' }),
    grounds: Object.freeze({ labelKey: 'studio.map.verb_grounds', labelFallback: 'grounds' }),
    feeds: Object.freeze({ labelKey: 'studio.map.verb_feeds', labelFallback: 'feeds' }),
    triggers: Object.freeze({ labelKey: 'studio.map.verb_triggers', labelFallback: 'triggers' }),
});

/**
 * De elf randen, in de volgorde waarin server/projects/graph.js ze in zijn
 * eigen docblock opsomt (graph.js:22-31, plus de app→tabel-rand die de code
 * kent en de docblock niet noemt). Zo is deze lijst met de hand tegen die
 * ene te leggen. Elke rand is een SOORT verbinding die op schijf al bestaat,
 * geen bedachte relatie.
 *
 * De app→tabel-rand is de enige die vandaag nul exemplaren oplevert, en
 * graph.js NOEMT haar in zijn eigen docblock (graph.js:50-55) juist om te
 * zeggen dat ze niet getekend wordt zolang `SAVE_PATHS.app` in
 * automation/usageSync leeg is. Dat is een FEIT over het product, geen stub:
 * als SOORT verbinding bestaat ze, dus op een legenda hoort ze thuis — met
 * erbij, op de tegel, dat het product haar nog nergens vastlegt
 * (studio.map.edge_app_uses_datatable_note).
 */
export const MAP_EDGES = Object.freeze([
    Object.freeze({
        id: 'app-runs-automation', from: 'app', to: 'automation', verbs: ['runs'],
        labelKey: 'studio.map.edge_app_runs_automation',
        labelFallback: 'An app runs an automation.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left', fromOff: -8 }),
    }),
    Object.freeze({
        id: 'app-asks-approval', from: 'app', to: 'approval', verbs: ['asks'],
        labelKey: 'studio.map.edge_app_asks_approval',
        labelFallback: 'An app asks a person to approve.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left', fromOff: 8 }),
    }),
    Object.freeze({
        id: 'automation-asks-approval', from: 'automation', to: 'approval', verbs: ['asks'],
        labelKey: 'studio.map.edge_automation_asks_approval',
        labelFallback: 'An automation asks a person to approve.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left', fromOff: 8 }),
    }),
    Object.freeze({
        id: 'automation-calls-automation', from: 'automation', to: 'automation', verbs: ['calls'],
        labelKey: 'studio.map.edge_automation_calls_automation',
        labelFallback: 'An automation calls another automation.',
        route: Object.freeze({ type: 'self' }),
        labelAt: Object.freeze({ x: 342, y: 60 }),
    }),
    Object.freeze({
        id: 'webpage-runs-automation', from: 'webpage', to: 'automation', verbs: ['runs'],
        labelKey: 'studio.map.edge_webpage_runs_automation',
        labelFallback: 'A web page runs an automation.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left' }),
    }),
    Object.freeze({
        // Eén paar, twee werkwoorden — lezen en schrijven zijn niet hetzelfde
        // risico, en de kaart mag ze niet tot "gebruikt" samenvatten.
        id: 'automation-datatable', from: 'automation', to: 'datatable', verbs: ['reads', 'writes'],
        labelKey: 'studio.map.edge_automation_datatable',
        labelFallback: 'An automation reads and writes a table.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left', fromOff: -8 }),
    }),
    Object.freeze({
        id: 'automation-writes-document', from: 'automation', to: 'document', verbs: ['writes'],
        labelKey: 'studio.map.edge_automation_writes_document',
        labelFallback: 'An automation writes a document.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left' }),
    }),
    Object.freeze({
        id: 'app-uses-datatable', from: 'app', to: 'datatable', verbs: ['uses'],
        labelKey: 'studio.map.edge_app_uses_datatable',
        labelFallback: 'An app uses a table.',
        // De enige rand met een voetnoot: ze bestaat als soort, maar niets in
        // het product legt haar vandaag vast, en iemand die haar in het
        // Flow-tabblad gaat terugzoeken vindt daar niets.
        noteKey: 'studio.map.edge_app_uses_datatable_note',
        noteFallback: 'Not recorded anywhere yet, so no solution shows it.',
        // Om de automatisering heen: onderlangs en dan door de kolomgang omhoog.
        route: Object.freeze({
            type: 'elbow', fromSide: 'bottom', toSide: 'left',
            via: Object.freeze([Object.freeze({ y: 224 }), Object.freeze({ x: 459 })]),
        }),
        labelAt: Object.freeze({ x: 290, y: 219 }),
    }),
    Object.freeze({
        id: 'agent-grounds-kb', from: 'agent', to: 'kb', verbs: ['grounds'],
        labelKey: 'studio.map.edge_agent_grounds_kb',
        labelFallback: 'An agent is grounded in a knowledge base.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left', fromOff: -10 }),
    }),
    Object.freeze({
        id: 'agent-uses-skill', from: 'agent', to: 'skill', verbs: ['uses'],
        labelKey: 'studio.map.edge_agent_uses_skill',
        labelFallback: 'An agent uses a skill.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left', fromOff: 8 }),
    }),
    Object.freeze({
        id: 'meeting-feeds-kb', from: 'meeting', to: 'kb', verbs: ['feeds'],
        labelKey: 'studio.map.edge_meeting_feeds_kb',
        labelFallback: 'A meeting note feeds a knowledge base.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left' }),
    }),
    Object.freeze({
        id: 'form-triggers-automation', from: 'form', to: 'automation', verbs: ['triggers'],
        labelKey: 'studio.map.edge_form_triggers_automation',
        labelFallback: 'A form triggers an automation.',
        route: Object.freeze({ type: 'curve', fromSide: 'right', toSide: 'left' }),
    }),
]);

/**
 * De doos zonder randen. Vandaag precies één ('solution'), en de zin daaronder
 * is voor die ene geschreven ("de doos waar de anderen in reizen"). Een elfde
 * soort die zonder randen op de kaart belandt zou anders te horen krijgen dat
 * hij een oplossing is, dus de zin hangt aan de knoop en niet aan het getal 0.
 */
export const NO_EDGE_NODE_ID = 'solution';

/** De randen die deze doos raken — uit of in. Een zelflus telt één keer. */
export function edgesOf(nodeId) {
    if (!nodeId) return [];
    return MAP_EDGES.filter((e) => e.from === nodeId || e.to === nodeId);
}

/** Raakt deze rand deze doos? De zelflus raakt haar eigen doos. */
export function edgeTouches(edge, nodeId) {
    return !!edge && !!nodeId && (edge.from === nodeId || edge.to === nodeId);
}

/* ── Het register: label, teller en laan komen NIET uit dit bestand ───────── */

/**
 * Wat het register over deze bouwsteen weet: hoe hij heet, welke teller bij
 * hem hoort en onder welke laan hij valt. Alles afgeleid, niets overgeschreven
 * — anders heet een tabel op de kaart iets anders dan op de rail.
 *
 * `countKey` volgt de regel van de rail (`countKey || id`), zodat de tegel
 * dezelfde sleutel uit GET /api/studio/counts leest als de rij ernaast.
 * null voor een soort die het register niet (meer) kent — de drifttest maakt
 * daar herrie over voordat iemand het op het scherm ziet.
 */
export function blockMeta(kind) {
    const app = studioAppForKind(kind);
    if (!app) return null;
    return {
        // Het HELE registerrecord reist mee, zodat de tekening de naam via
        // studioSectionLabel kan opvragen in plaats van labelKey/labelFallback
        // zelf te herbouwen — die derde kopie miste al de runtime-module-tak.
        app,
        id: app.id,
        labelKey: app.labelKey,
        labelFallback: app.labelFallback || null,
        countKey: app.countKey || app.id,
        urlSegment: app.urlSegment || null,
        category: app.category || null,
    };
}

/** De laan (categorie) uit het register, voor het label boven de band. */
export function laneMeta(laneId) {
    return STUDIO_CATEGORIES.find((c) => c.id === laneId) || null;
}

/* ── Tegel-chrome: het bestaande recept, met kindColors ───────────────────── */

/**
 * De omlijning van een tegel.
 *
 * HET RECEPT IS NIET NIEUW: `cardChrome` uit de bouwer-canvas
 * (automation/Builder/flow/nodeTypeColors.js:183) levert rand, schaduw en de
 * selectiering, mét de volgorde waarin die elkaar overrulen. Wat cardChrome
 * niet kan weten is dat een Studio-SOORT geen stapfamilie is: zijn 4px-balk
 * en zijn hoekradius komen uit het stap-vocabulaire. Die twee — en alleen
 * die twee — komen hier uit kindColors, zodat een tabel op deze kaart
 * dezelfde kleur en dezelfde vorm heeft als op de rail en in de bouwer.
 *
 * De eerste boxShadow-laag ÍS die familiebalk (nodeTypeColors.js:195:
 * `inset 4px 0 0 <balk>`); die wordt vervangen, de rest blijft staan.
 * studioMap.test.js pint dat vast, zodat een verbouwing van cardChrome hier
 * niet stil de verkeerde laag overschrijft.
 */
export function kindCardChrome(kind, { selected = false, dimmed = false } = {}) {
    const { style } = cardChrome({ group: null, selected });
    const layers = String(style.boxShadow).split(', ');
    layers[0] = `inset 4px 0 0 ${kindColorVar(kind)}`;
    return {
        ...style,
        borderRadius: kindCardRadius(kind),
        boxShadow: layers.join(', '),
        opacity: dimmed ? 0.4 : style.opacity,
    };
}

/**
 * De omlijning van de synthetische doos.
 *
 * `disabled` uit hetzelfde recept: gestippeld en gedempt is precies hoe de
 * canvas "dit is geen gewone kaart" zegt. Bij selectie gaat de demping eraf —
 * een geselecteerde doos die je niet kunt lezen is geen selectie.
 */
export function syntheticCardChrome({ selected = false, dimmed = false } = {}) {
    const { style } = cardChrome({ group: null, disabled: true, selected });
    return {
        ...style,
        borderRadius: '8px',
        opacity: dimmed ? 0.3 : (selected ? 1 : style.opacity),
    };
}

/* ── Paden ────────────────────────────────────────────────────────────────── */

const SIDE_NORMAL = Object.freeze({
    left: Object.freeze({ x: -1, y: 0 }),
    right: Object.freeze({ x: 1, y: 0 }),
    top: Object.freeze({ x: 0, y: -1 }),
    bottom: Object.freeze({ x: 0, y: 1 }),
});

/**
 * Het punt op de rand van een doos. `off` schuift LANGS die rand: twee randen
 * die dezelfde doos aan dezelfde kant verlaten mogen niet op elkaar liggen.
 */
export function anchorOf(node, side, off = 0) {
    const cx = node.x + TILE_W / 2;
    const cy = node.y + TILE_H / 2;
    if (side === 'left') return { x: node.x, y: cy + off };
    if (side === 'right') return { x: node.x + TILE_W, y: cy + off };
    if (side === 'top') return { x: cx + off, y: node.y };
    if (side === 'bottom') return { x: cx + off, y: node.y + TILE_H };
    return { x: cx, y: cy };
}

const round1 = (n) => Math.round(n * 10) / 10;

/** De richting waarin de pijlpunt wijst, uit de laatste twee punten. */
function direction(from, to) {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx, dy) || 1;
    return { x: dx / len, y: dy / len };
}

/**
 * De pijlpunt: een driehoek met zijn punt OP het eindpunt. Bewust geen
 * SVG-marker — een marker erft de streekkleur niet overal, en op deze kaart
 * verandert die kleur bij elke selectie.
 */
export function arrowPath(point, dir, size = 6) {
    const bx = point.x - dir.x * size;
    const by = point.y - dir.y * size;
    const px = -dir.y * size * 0.55;
    const py = dir.x * size * 0.55;
    return `M ${round1(point.x)} ${round1(point.y)} L ${round1(bx + px)} ${round1(by + py)} L ${round1(bx - px)} ${round1(by - py)} Z`;
}

/** Een orthogonale polylijn met afgeronde hoeken. */
function roundedPolyline(points, r = 8) {
    if (points.length < 2) return '';
    let d = `M ${round1(points[0].x)} ${round1(points[0].y)}`;
    for (let i = 1; i < points.length - 1; i += 1) {
        const prev = points[i - 1];
        const cur = points[i];
        const next = points[i + 1];
        const inDir = direction(prev, cur);
        const outDir = direction(cur, next);
        const rIn = Math.min(r, Math.hypot(cur.x - prev.x, cur.y - prev.y) / 2);
        const rOut = Math.min(r, Math.hypot(next.x - cur.x, next.y - cur.y) / 2);
        const a = { x: cur.x - inDir.x * rIn, y: cur.y - inDir.y * rIn };
        const b = { x: cur.x + outDir.x * rOut, y: cur.y + outDir.y * rOut };
        d += ` L ${round1(a.x)} ${round1(a.y)} Q ${round1(cur.x)} ${round1(cur.y)} ${round1(b.x)} ${round1(b.y)}`;
    }
    const end = points[points.length - 1];
    d += ` L ${round1(end.x)} ${round1(end.y)}`;
    return d;
}

/** De zelflus: een boog over de eigen tegel heen. */
function selfGeometry(node) {
    const left = { x: node.x + 40, y: node.y };
    const right = { x: node.x + TILE_W - 40, y: node.y };
    const top = node.y - 42;
    const d = `M ${left.x} ${left.y} C ${left.x} ${top}, ${right.x} ${top}, ${right.x} ${right.y}`;
    return {
        d,
        mid: { x: (left.x + 3 * left.x + 3 * right.x + right.x) / 8, y: (left.y + 3 * top + 3 * top + right.y) / 8 },
        tip: right,
        dir: { x: 0, y: 1 },
    };
}

/** De omweg: een orthogonale route langs handgelegde knikken. */
function elbowGeometry(a, b, route, edge) {
    const pts = [a];
    for (const via of route.via || []) {
        const last = pts[pts.length - 1];
        pts.push({ x: via.x ?? last.x, y: via.y ?? last.y });
    }
    // De laatste hoek volgt de kant waar de rand BINNENKOMT: bij links of
    // rechts nadert hij horizontaal, bij boven of onder verticaal.
    const last = pts[pts.length - 1];
    const horizontalApproach = route.toSide === 'left' || route.toSide === 'right';
    pts.push(horizontalApproach ? { x: last.x, y: b.y } : { x: b.x, y: last.y });
    pts.push(b);
    const dir = direction(pts[pts.length - 2], b);
    return {
        d: roundedPolyline(pts),
        arrow: arrowPath(b, dir),
        mid: edge.labelAt || pts[Math.floor(pts.length / 2)],
    };
}

/**
 * De bocht: een cubic bezier met raaklijnen loodrecht op de twee randen. De
 * lengte van die raaklijn schaalt mee met de afstand, en is begrensd: op een
 * korte rand duwt een lange raaklijn de bocht terug door zichzelf heen.
 */
function curveGeometry(a, b, route, edge) {
    const span = Math.hypot(b.x - a.x, b.y - a.y);
    const bow = route.bow ?? Math.max(20, Math.min(80, span * 0.4));
    const n1 = SIDE_NORMAL[route.fromSide] || SIDE_NORMAL.right;
    const n2 = SIDE_NORMAL[route.toSide] || SIDE_NORMAL.left;
    const c1 = { x: a.x + n1.x * bow, y: a.y + n1.y * bow };
    const c2 = { x: b.x + n2.x * bow, y: b.y + n2.y * bow };
    const mid = {
        x: round1((a.x + 3 * c1.x + 3 * c2.x + b.x) / 8),
        y: round1((a.y + 3 * c1.y + 3 * c2.y + b.y) / 8),
    };
    return {
        d: `M ${round1(a.x)} ${round1(a.y)} C ${round1(c1.x)} ${round1(c1.y)}, ${round1(c2.x)} ${round1(c2.y)}, ${round1(b.x)} ${round1(b.y)}`,
        arrow: arrowPath(b, direction(c2, b)),
        mid: edge.labelAt || mid,
    };
}

/**
 * Het pad van één rand: `{ d, arrow, mid }`.
 *
 * Pure meetkunde op de handgelegde coördinaten — geen layout-engine, geen
 * meting in de DOM. Daardoor is elk pad in een test na te rekenen, en tekent
 * de kaart in een test hetzelfde als in een browser.
 */
export function edgeGeometry(edge) {
    const from = mapNode(edge?.from);
    const to = mapNode(edge?.to);
    if (!from || !to) return null;
    const route = edge.route || { type: 'curve', fromSide: 'right', toSide: 'left' };
    if (route.type === 'self') {
        const g = selfGeometry(from);
        return { d: g.d, arrow: arrowPath(g.tip, g.dir), mid: edge.labelAt || g.mid };
    }
    const a = anchorOf(from, route.fromSide, route.fromOff || 0);
    const b = anchorOf(to, route.toSide, route.toOff || 0);
    return route.type === 'elbow'
        ? elbowGeometry(a, b, route, edge)
        : curveGeometry(a, b, route, edge);
}

/** Alle randen met hun pad, in tekenvolgorde. Randen zonder doos vallen weg. */
export function edgeGeometries() {
    return MAP_EDGES.map((edge) => ({ edge, geometry: edgeGeometry(edge) })).filter((e) => e.geometry);
}

/** De soorten die de kaart tekent — waar de drifttest tegenaan legt. */
export const MAP_KINDS = Object.freeze(MAP_BLOCKS.map((b) => b.kind));

/* ── Tellers ──────────────────────────────────────────────────────────────── */

/**
 * De toestand van de teller van één doos, in vier waarden.
 *
 * `counts` null heeft TWEE onverenigbare oorzaken en dit bestand mag ze niet
 * op één hoop gooien: het antwoord is nog onderweg ('pending'), of het is er
 * nooit gekomen ('unknown'). De hook levert dat onderscheid als `failed` —
 * zonder dat zou een 500 op het scherm verschijnen als "The number is not in
 * yet", een belofte die nooit wordt ingelost, want de kaart draait bewust
 * zonder poller. Onbekend versmalt: bij twijfel het streepje en de zin die
 * zegt dat het er niet is, nooit de geruststelling dat het nog komt.
 *
 * GET /api/studio/counts LAAT EEN SLEUTEL WEG als de beller hem niet mag zien
 * én als de store eronder omviel, en het strípt zijn eigen `partial`-vlag — de
 * client kan die twee dus niet uit elkaar houden, en beide zijn ze geen nul.
 * `countFor` is de afleider van de rail, niet een tweede: rommel in het
 * antwoord blijft "onbekend".
 *
 * Een soort die het register NIET (meer) kent is óók 'unknown', niet
 * 'not_counted': "er valt hier niets te tellen" is een vastgesteld feit en
 * hoort alleen bij de synthetische doos, die per constructie niet geteld wordt.
 */
export function countState(node, counts, { failed = false } = {}) {
    if (!node) return { state: 'unknown' };
    if (node.synthetic) return { state: 'not_counted' };
    const meta = blockMeta(node.kind);
    if (!meta || !meta.countKey) return { state: 'unknown' };
    if (!counts) return { state: failed ? 'unknown' : 'pending' };
    const value = countFor(counts, meta.countKey);
    return typeof value === 'number' ? { state: 'known', value } : { state: 'unknown' };
}

/**
 * De sleutels die GET /api/studio/counts ECHT org-breed telt.
 *
 * Eén, vandaag. De rest telt per gebruiker met de scoping van zijn eigen
 * lijstroute: `automations` is `WHERE user_id = $1`, `runs` zijn de eigen runs
 * van de beller (met een commentaar erbij dat org-breed tellen daar fout zou
 * zijn), `solutions` is listUserProjects. Het endpoint kent bovendien HELEMAAL
 * geen scope-parameter — een strip die 'org' doorgeeft verandert de getallen
 * dus niet, alleen de zin eronder. Zonder deze lijst zou die zin omklappen
 * naar een org-brede bewering over een getal dat de bron niet kan dragen: "9 ·
 * Counting everything in the organisation" onder de eigen negen automatiseringen van
 * één bouwer.
 */
export const ORG_WIDE_COUNT_KEYS = Object.freeze(['agents']);

/**
 * De zin die zegt waar het getal over gaat.
 *
 * Onbekend versmalt (runScope.js:20-25 houdt dezelfde regel aan de kant van
 * de filters): alleen de letterlijke waarde 'org' levert de org-brede zin op.
 * Alles wat we niet herkennen valt terug op wat sowieso waar is — dat het
 * endpoint telt wat déze beller mag zien. En 'org' versmalt óók, per sleutel:
 * een teller die de server niet org-breed telt krijgt de zichtbare zin, hoe
 * breed de strip erboven ook staat.
 */
export function scopeSentence(t, scope, countKey = null) {
    const visible = () => t('studio.map.scope_visible', 'Counting what you can see.');
    if (scope === 'org') {
        return ORG_WIDE_COUNT_KEYS.includes(countKey)
            ? t('studio.map.scope_org', 'Counting everything in the organisation.')
            : visible();
    }
    if (scope === 'mine') return t('studio.map.scope_mine', 'Counting only what you made.');
    if (scope === 'solution') return t('studio.map.scope_solution', 'Counting what is in the chosen solution.');
    return visible();
}
