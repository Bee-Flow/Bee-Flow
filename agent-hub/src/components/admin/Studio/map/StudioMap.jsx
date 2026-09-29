import { ShieldCheck } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import {
    MAP_BLOCKS, MAP_EDGES, MAP_H, MAP_LANES, MAP_NODES, MAP_W, NO_EDGE_NODE_ID,
    TILE_H, TILE_W, VERB_LABEL, blockMeta, countState, edgeGeometries, edgeTouches,
    edgesOf, kindCardChrome, laneMeta, mapNode, scopeSentence, syntheticCardChrome,
} from './studioMap';
import { useStudioCounts } from '../../../../hooks/useStudioCounts';
import { useTranslation } from '../../../../hooks/useTranslation';
import { kindColorVar, kindIcon, kindTileStyle } from '../../../shared/kindColors';
import { nOf } from '../KnowledgeStudio/plural';
import { studioSectionLabel } from '../studioNav';

/**
 * "Hoe de stukken in elkaar passen" — de kaart onder aan het Startscherm.
 *
 * Het WAAROM (en waarom dit géén levende org-brede graph is) staat in
 * studioMap.js. Dit bestand tekent alleen, en houdt zich aan drie regels.
 *
 * ── 1. De plaat is niet de informatie ──────────────────────────────────────
 *
 * De SVG is `aria-hidden` en vangt geen muis: ze tekent de lanen, de randen en
 * de werkwoorden, en verder niets. Alles wat ze zegt staat er óók als tekst:
 * de tegels zijn echte <button>s (met hun teller erin), de elf verbindingen
 * staan als elf zinnen in een lijst eronder, en de uitleg bij een selectie is
 * gewone alinea-tekst. Wie de plaat niet ziet — met een schermlezer, met CSS
 * uit, of op een telefoon waar hij horizontaal weg scrollt — mist dus geen
 * enkel feit. Dat is de reden dat de tegels HTML zijn en geen <rect>: een
 * knop in een plaatje is geen knop.
 *
 * ── 2. Een teller die niet gelezen kon worden toont geen 0 ─────────────────
 *
 * De getallen komen uit GET /api/studio/counts, met de sleutel die het
 * register aan de sectie hangt (`countKey || id`) — dezelfde sleutel als de
 * rij op de rail, dus de kaart en de rail kunnen niet twee getallen voor
 * hetzelfde ding tonen. De vier toestanden en waaróm ze vier zijn staan bij
 * `countState` in studioMap.js; hier staat hoe ze eruitzien:
 *
 *   nog geen antwoord   niets op de tegel; "het getal is er nog niet"
 *   getal               het getal
 *   niet gelezen        een streepje, en in woorden dat dit GEEN nul is —
 *                       óók als de lezing MISLUKTE, want die komt niet meer
 *                       terug (de kaart draait zonder poller) en "nog niet
 *                       binnen" zou dan een belofte zijn die niemand inlost
 *   niet telbaar        een goedkeuring maakt niemand; er valt niets te tellen
 *
 * Nul is een geldig antwoord en ziet er dus uit als een 0. "Ik weet het niet"
 * mag daar nooit op lijken — dat is dezelfde regel die de rail bewaakt
 * (StudioRail.jsx:37-42).
 *
 * ── 3. De scope-strip bezit de scope, deze kaart volgt hem ─────────────────
 *
 * `counts` als prop = de ouder (de strip) bezit de getallen: hij herlaadt bij
 * elke scope-wissel en geeft nieuwe door, en deze kaart haalt zelf niets op.
 * Zonder die prop leest ze het endpoint zelf, via de HUISHOOK met
 * `poll: false` (useStudioCounts) — één keer bij openen, geen tweede poller
 * naast die van de rail. Niet een eigen fetch ernaast: dan zou dit scherm twee
 * plekken hebben die hetzelfde antwoord anders lezen.
 *
 * Wat de kaart NIET doet is een scope de leiding op sturen die het endpoint
 * niet kent: GET /api/studio/counts neemt vandaag geen scope-parameter en
 * cachet per (org, gebruiker) — een `?scope=`-parameter erbij verzinnen zou
 * die cache vergiftigen én een belofte doen die de server niet nakomt. `scope`
 * bepaalt hier dus alleen WELKE ZIN onder het getal staat, en een waarde die
 * we niet kennen versmalt naar de voorzichtigste zin, nooit naar "de hele
 * organisatie" (scopeSentence).
 */

const LABEL_STYLE = {
    fontSize: 9.5,
    fill: 'var(--text-tertiary)',
    // De halo: de tekst krijgt eerst een dikke streek in de achtergrondkleur,
    // daarna de vulling. Zo blijft een werkwoord leesbaar waar het over een
    // rand heen valt, zonder een rechthoekje eronder te tekenen.
    stroke: 'var(--bg-card)',
    strokeWidth: 3,
    paintOrder: 'stroke',
    strokeLinejoin: 'round',
};

/** De 22px tegel van de synthetische doos: neutraal, want ze heeft geen soort. */
const SYNTHETIC_TILE = {
    tile: {
        width: 22, height: 22, flexShrink: 0, borderRadius: 8,
        display: 'grid', placeItems: 'center',
        background: 'color-mix(in srgb, var(--text-tertiary) 16%, transparent)',
        color: 'var(--text-tertiary)',
    },
    glyph: { width: 12, height: 12 },
};

function LaneBands({ t }) {
    return MAP_LANES.map((lane) => {
        const meta = laneMeta(lane.id);
        return (
            <g key={lane.id}>
                <rect
                    x={8} y={lane.y} width={MAP_W - 16} height={lane.h} rx={12}
                    fill="var(--bg-secondary)" stroke="var(--border-subtle)" strokeWidth={1}
                />
                <text
                    x={20} y={lane.y + 15}
                    style={{ fontSize: 9.5, fontWeight: 600, letterSpacing: '0.05em', fill: 'var(--text-tertiary)' }}
                >
                    {(meta ? t(meta.labelKey, meta.labelFallback) : lane.id).toUpperCase()}
                </text>
            </g>
        );
    });
}

/** Het lijntje van één rand, met zijn pijlpunt en zijn werkwoord(en). */
function Edge({ edge, geometry, t, selected }) {
    const on = !!selected && edgeTouches(edge, selected);
    const dimmed = !!selected && !on;
    const node = selected ? mapNode(selected) : null;
    const stroke = on
        ? (node && node.kind ? kindColorVar(node.kind) : 'var(--text-primary)')
        : 'var(--border-default)';
    const verbs = edge.verbs
        .map((v) => t(VERB_LABEL[v]?.labelKey || v, VERB_LABEL[v]?.labelFallback || v))
        .join(' · ');
    return (
        <g data-testid={`studio-map-edge-${edge.id}`} data-on={on ? 'true' : undefined} opacity={dimmed ? 0.2 : 1}>
            <path d={geometry.d} fill="none" stroke={stroke} strokeWidth={on ? 2 : 1.25} strokeLinecap="round" />
            <path d={geometry.arrow} fill={stroke} />
            <text x={geometry.mid.x} y={geometry.mid.y} textAnchor="middle" style={LABEL_STYLE}>{verbs}</text>
        </g>
    );
}

/** Eén doos: een echte knop, op zijn handgelegde plek. */
function MapTile({ node, label, count, selected, dimmed, onToggle, Icon, t }) {
    const chrome = node.synthetic
        ? syntheticCardChrome({ selected, dimmed })
        : kindCardChrome(node.kind, { selected, dimmed });
    const tileStyle = node.synthetic ? SYNTHETIC_TILE : kindTileStyle(node.kind, { size: 22, pct: 18 });
    return (
        <button
            type="button"
            onClick={onToggle}
            aria-pressed={selected}
            data-testid={`studio-map-tile-${node.id}`}
            data-dimmed={dimmed ? 'true' : undefined}
            className="absolute flex items-center gap-2 px-2 text-left transition-opacity"
            style={{
                left: node.x, top: node.y, width: TILE_W, height: TILE_H,
                background: 'var(--bg-card)', ...chrome,
            }}
        >
            <span style={tileStyle.tile}>
                {Icon && <Icon style={tileStyle.glyph} strokeWidth={1.75} aria-hidden="true" />}
            </span>
            <span className="flex-1 min-w-0 truncate text-[12px] font-medium text-[var(--text-primary)]">
                {label}
            </span>
            {count.state === 'known' && (
                <span
                    className="flex-shrink-0 text-[12px] tabular-nums text-[var(--text-tertiary)]"
                    data-testid={`studio-map-count-${node.id}`}
                >
                    {count.value}
                </span>
            )}
            {count.state === 'unknown' && (
                <span
                    className="flex-shrink-0 text-[12px] text-[var(--text-tertiary)]"
                    data-testid={`studio-map-count-${node.id}-unknown`}
                    title={t('studio.map.count_unknown', 'No number for this one: either it is not yours to see, or it could not be read. That is not the same as none.')}
                >
                    <span aria-hidden="true">—</span>
                    {/* Het streepje is het enige verschil tussen "geen getal" en
                        "nog geen getal", en een `title` spreekt niet elke
                        schermlezer uit. De zin staat er dus echt, onzichtbaar. */}
                    <span className="sr-only">
                        {t('studio.map.count_unknown', 'No number for this one: either it is not yours to see, or it could not be read. That is not the same as none.')}
                    </span>
                </span>
            )}
        </button>
    );
}

/** De teller van de gekozen doos, in woorden. Precies één van de vier. */
function CountLine({ count, scope, countKey, t }) {
    if (count.state === 'known') {
        return (
            <p className="mt-1 text-[var(--text-secondary)]" data-testid="studio-map-detail-count">
                <span className="tabular-nums font-medium text-[var(--text-primary)]">{count.value}</span>
                {' · '}
                {scopeSentence(t, scope, countKey)}
            </p>
        );
    }
    if (count.state === 'unknown') {
        return (
            <p className="mt-1 text-[var(--text-secondary)]" data-testid="studio-map-detail-unknown">
                {t('studio.map.count_unknown', 'No number for this one: either it is not yours to see, or it could not be read. That is not the same as none.')}
            </p>
        );
    }
    if (count.state === 'pending') {
        return (
            <p className="mt-1 text-[var(--text-tertiary)]" data-testid="studio-map-detail-pending">
                {t('studio.map.count_pending', 'The number is not in yet.')}
            </p>
        );
    }
    return (
        <p className="mt-1 text-[var(--text-tertiary)]" data-testid="studio-map-detail-not-counted">
            {t('studio.map.count_not_counted', 'An approval is not something you make, so there is nothing to count.')}
        </p>
    );
}

/** De uitleg onder de plaat: naam, laan, teller, en hoeveel eraan hangt. */
function DetailPanel({ node, label, count, countKey, scope, edgeCount, t }) {
    if (!node) {
        return (
            <p className="text-[var(--text-tertiary)]">
                {t('studio.map.pick', 'Pick a building block to see what it connects to.')}
            </p>
        );
    }
    const lane = laneMeta(node.lane);
    return (
        <div className="rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] px-3.5 py-3">
            <p className="font-medium text-[var(--text-primary)]">
                {label}
                <span className="ml-2 font-normal text-[var(--text-tertiary)]">
                    {lane ? t(lane.labelKey, lane.labelFallback) : node.lane}
                </span>
            </p>
            <CountLine count={count} scope={scope} countKey={countKey} t={t} />
            <p className="mt-1 text-[var(--text-tertiary)]">
                {edgeCount > 0
                    ? nOf(t, 'studio.map.edges', edgeCount, '{count} connection', '{count} connections')
                    : (node.id === NO_EDGE_NODE_ID
                        // Deze zin is voor ÉÉN doos geschreven en hangt dus aan
                        // die doos. Een elfde soort zonder randen zou anders te
                        // horen krijgen dat hij een oplossing is.
                        ? t('studio.map.no_edges', 'Nothing points at this one and it points at nothing: a solution is the box the others travel in.')
                        : t('studio.map.no_edges_generic', 'Nothing on this map points at this one, and it points at nothing.'))}
            </p>
        </div>
    );
}

/**
 * De elf verbindingen in woorden. Altijd zichtbaar: dit is de plaat zonder
 * plaat, en tegelijk de legenda ernaast.
 */
function EdgeSentences({ selected, t }) {
    return (
        <ul className="mt-3 space-y-1" data-testid="studio-map-edge-list">
            {MAP_EDGES.map((edge) => {
                const on = !!selected && edgeTouches(edge, selected);
                return (
                    <li
                        key={edge.id}
                        data-testid={`studio-map-sentence-${edge.id}`}
                        data-on={on ? 'true' : undefined}
                        className={`flex items-start gap-2 text-[12px] ${!on && selected ? 'opacity-45' : ''}`}
                    >
                        <span
                            aria-hidden="true"
                            className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full"
                            style={{ background: kindColorVar(mapNode(edge.from)?.kind) }}
                        />
                        <span className={on ? 'text-[var(--text-primary)]' : 'text-[var(--text-secondary)]'}>
                            {t(edge.labelKey, edge.labelFallback)}
                            {/* Eén rand bestaat als SOORT maar wordt nergens
                                vastgelegd; wie haar in het Flow-tabblad gaat
                                terugzoeken vindt niets. Dat staat erbij. */}
                            {edge.noteKey && (
                                <span className="ml-1.5 text-[var(--text-tertiary)]" data-testid={`studio-map-note-${edge.id}`}>
                                    {t(edge.noteKey, edge.noteFallback)}
                                </span>
                            )}
                        </span>
                    </li>
                );
            })}
        </ul>
    );
}

export default function StudioMap({ counts: countsProp, countsFailed = false, scope = null, locale = undefined }) {
    const { t, locale: uiLocale } = useTranslation();
    const [selected, setSelected] = useState(null);

    // `undefined` = de ouder bezit de getallen niet; `null` van de ouder is een
    // antwoord ("ik heb ze niet"), en dat is iets anders dan geen prop.
    const ownsCounts = countsProp === undefined;
    // Uitgeschakeld levert de hook EMPTY (counts: null, failed: false) —
    // precies de toestand "nog geen antwoord", en dus tekent er niets een
    // getal. Een MISLUKTE lezing eindigt op dezelfde null maar met `failed`
    // true, en dat verschil moet het scherm halen: zonder poller komt dat
    // getal niet meer, dus "nog niet binnen" zou een belofte zijn.
    const { counts: fetched, failed: fetchFailed } = useStudioCounts({ enabled: ownsCounts, poll: false });

    const counts = ownsCounts ? fetched : countsProp;
    const failed = ownsCounts ? fetchFailed : countsFailed;
    const geometries = useMemo(() => edgeGeometries(), []);
    const selectedNode = selected ? mapNode(selected) : null;
    const selectedEdges = selected ? edgesOf(selected) : [];
    const selectedMeta = selectedNode ? blockMeta(selectedNode.kind) : null;

    // De naam van een sectie komt uit studioNav.js, niet uit een vierde kopie
    // van dezelfde drie regels — die miste de runtime-module-tak, en dan heet
    // een tegel iets anders dan dezelfde sectie op de rail.
    const labelOf = (node) => {
        if (!node) return '';
        if (node.synthetic) return t(node.labelKey, node.labelFallback);
        const meta = blockMeta(node.kind);
        if (!meta) return node.kind;
        return studioSectionLabel(meta.app, t, locale ?? uiLocale);
    };

    return (
        <section className="mt-8" data-testid="studio-map">
            <h2 className="text-[11px] font-semibold uppercase tracking-[0.05em] text-[var(--text-tertiary)]">
                {t('studio.map.title', 'How the pieces fit together')}
            </h2>
            <p className="mt-1 text-[12px] text-[var(--text-tertiary)]" data-testid="studio-map-counts">
                {nOf(t, 'studio.map.blocks', MAP_BLOCKS.length, '{count} building block', '{count} building blocks')}
                {' · '}
                {nOf(t, 'studio.map.edges', MAP_EDGES.length, '{count} connection', '{count} connections')}
            </p>

            {/* De plaat. Vaste maat en horizontaal scrollend: krimpen zou de
                tegels onleesbaar maken, en de lijst eronder draagt hetzelfde
                verhaal al in tekst voor wie een smal scherm heeft. */}
            <div className="mt-3 overflow-x-auto custom-scrollbar rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-card)] p-2">
                <div className="relative" style={{ width: MAP_W, height: MAP_H }}>
                    <svg
                        width={MAP_W} height={MAP_H} viewBox={`0 0 ${MAP_W} ${MAP_H}`}
                        className="absolute inset-0" style={{ pointerEvents: 'none' }}
                        aria-hidden="true" focusable="false" data-testid="studio-map-svg"
                    >
                        <LaneBands t={t} />
                        {geometries.map(({ edge, geometry }) => (
                            <Edge key={edge.id} edge={edge} geometry={geometry} t={t} selected={selected} />
                        ))}
                    </svg>

                    {MAP_NODES.map((node) => (
                        <MapTile
                            key={node.id}
                            node={node}
                            label={labelOf(node)}
                            count={countState(node, counts, { failed })}
                            selected={selected === node.id}
                            dimmed={!!selected && selected !== node.id
                                && !selectedEdges.some((e) => edgeTouches(e, node.id))}
                            onToggle={() => setSelected((cur) => (cur === node.id ? null : node.id))}
                            Icon={node.synthetic ? ShieldCheck : kindIcon(node.kind)}
                            t={t}
                        />
                    ))}
                </div>
            </div>

            {/* De uitleg bij de selectie. Live, want de knop die haar verandert
                staat erboven en de tekst eronder. */}
            <div className="mt-3 text-[12px]" aria-live="polite" data-testid="studio-map-detail">
                <DetailPanel
                    node={selectedNode}
                    label={labelOf(selectedNode)}
                    count={countState(selectedNode, counts, { failed })}
                    countKey={selectedMeta ? selectedMeta.countKey : null}
                    scope={scope}
                    edgeCount={selectedEdges.length}
                    t={t}
                />
            </div>

            <EdgeSentences selected={selected} t={t} />
        </section>
    );
}
