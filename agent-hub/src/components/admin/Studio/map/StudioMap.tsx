import { ShieldCheck } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import { MAP_EDGES, blockMeta, countState, edgeGeometries, edgeTouches, edgesOf, kindCardChrome, laneMeta, mapNode, scopeSentence, syntheticCardChrome } from './studioMap';
import { MAP_BLOCKS, MAP_H, MAP_LANES, MAP_NODES, MAP_W, NO_EDGE_NODE_ID, TILE_H, TILE_W, VERB_LABEL } from './studioMap.constants';
import { useStudioCounts } from '../../../../hooks/useStudioCounts';
import { useTranslation } from '../../../../hooks/useTranslation';
import { kindColorVar, kindIcon, kindTileStyle } from '../../../shared/kindColors';
import { nOf } from '../KnowledgeStudio/plural';
import { studioSectionLabel } from '../studioNav';
import type { EdgeGeometry, MapNode, LaneBandsProps, EdgeProps, MapTileProps, CountLineProps, DetailPanelProps, EdgeSentencesProps, StudioMapProps } from './studioMap.types';

/**
 * “How the pieces fit together” — the card at the bottom of the Start screen.
 *
 * The WHY (and why this is NOT a live org-wide graph) is in studioMap.js. This file
 * only draws, and keeps to three rules.
 *
 * ── 1. The plate is not the information ──────────────────────────────────
 *
 * The SVG is `aria-hidden` and catches no mouse: it draws the lanes, the edges and
 * the verbs, and nothing else. Everything it says is also present as text: the tiles
 * are real <button>s (with their counter inside), the eleven connections stand as
 * eleven sentences in a list beneath it, and the explanation for a selection is
 * ordinary paragraph text. Whoever does not see the plate — with a screen reader,
 * with CSS off, or on a phone where it scrolls away horizontally — therefore misses
 * no single fact. That is why the tiles are HTML and not <rect>: a button inside a
 * picture is not a button.
 *
 * ── 2. A counter that could not be read shows no 0 ─────────────────────────
 *
 * The numbers come from GET /api/studio/counts, with the key that the register
 * attaches to the section (`countKey || id`) — the same key as the row on the rail,
 * so the card and the rail cannot show two numbers for the same thing. The four
 * states, and why they are four, are at `countState` in studioMap.js; here is how
 * they look:
 *
 *   no answer yet       nothing on the tile; “the number is not there yet”
 *   number              the number
 *   could not be read   a dash, and in words that this is NOT a zero — also when the
 *                       read FAILED, because that does not come back (the card runs
 *                       without a poller) and “not in yet” would then be a promise
 *                       nobody keeps
 *   not countable       an approval is nobody's; there is nothing to count
 *
 * Zero is a valid answer and therefore looks like a 0. “I don't know” must never look
 * like that — it is the same rule that the rail guards (StudioRail.jsx:37-42).
 *
 * ── 3. The scope strip owns the scope, this card follows it ───────────────
 *
 * `counts` as a prop = the parent (the strip) owns the numbers: it reloads at every
 * scope switch and passes new ones on, and this card fetches nothing itself. Without
 * that prop it reads the endpoint itself, via the HOUSE HOOK with `poll: false`
 * (useStudioCounts) — once on opening, with no second poller next to that of the
 * rail. Not a separate fetch alongside: then this screen would have two places
 * reading the same answer differently.
 *
 * What the card does NOT do is steer a scope value that the endpoint does not know:
 * GET /api/studio/counts today takes no scope parameter and caches per (org, user) —
 * inventing a `?scope=` parameter would poison that cache and make a promise that the
 * server does not keep. `scope` therefore determines here only WHICH SENTENCE stands
 * under the number, and a value that we do not know narrows to the most cautious
 * sentence, never to “the whole organisation” (scopeSentence).
 */

const LABEL_STYLE: React.CSSProperties = {
    fontSize: 9.5,
    fill: 'var(--text-tertiary)',
    // The halo: the text first gets a thick stroke in the background colour, then the
    // fill. This keeps a verb legible where it falls over an edge, without drawing a
    // little box beneath it.
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

function LaneBands({ t }: LaneBandsProps) {
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
                    className="[font-size:9.5px] [font-weight:600] [letter-spacing:0.05em] [fill:var(--text-tertiary)]"
                >
                    {(meta ? t(meta.labelKey, meta.labelFallback) : lane.id).toUpperCase()}
                </text>
            </g>
        );
    });
}

function Edge({ edge, geometry, t, selected }: EdgeProps) {
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
            <path d={(geometry as EdgeGeometry).d} fill="none" stroke={stroke} strokeWidth={on ? 2 : 1.25} strokeLinecap="round" />
            <path d={(geometry as EdgeGeometry).arrow} fill={stroke} />
            <text x={(geometry as EdgeGeometry).mid.x} y={(geometry as EdgeGeometry).mid.y} textAnchor="middle" style={LABEL_STYLE}>{verbs}</text>
        </g>
    );
}

function MapTile({ node, label, count, selected, dimmed, onToggle, Icon, t }: MapTileProps) {
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
                    {/* The dash is the only difference between “no number” and “no number yet”, and a
                        `title` is not spoken by every screen reader. So the sentence is really
                        there, invisibly. */}
                    <span className="sr-only">
                        {t('studio.map.count_unknown', 'No number for this one: either it is not yours to see, or it could not be read. That is not the same as none.')}
                    </span>
                </span>
            )}
        </button>
    );
}

function CountLine({ count, scope, countKey, t }: CountLineProps) {
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

function DetailPanel({ node, label, count, countKey, scope, edgeCount, t }: DetailPanelProps) {
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
                        // This sentence was written for ONE box and therefore hangs on that box. An eleventh
                        // kind without edges would otherwise be told that it is a solution.
                        ? t('studio.map.no_edges', 'Nothing points at this one and it points at nothing: a solution is the box the others travel in.')
                        : t('studio.map.no_edges_generic', 'Nothing on this map points at this one, and it points at nothing.'))}
            </p>
        </div>
    );
}

function EdgeSentences({ selected, t }: EdgeSentencesProps) {
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
                            {/* One edge exists as a KIND but is nowhere recorded; whoever goes looking for it
                                in the Flow tab finds nothing. That is stated here. */}
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

export default function StudioMap({ counts: countsProp, countsFailed = false, scope = null, locale = undefined }: StudioMapProps) {
    const { t, locale: uiLocale } = useTranslation();
    const [selected, setSelected] = useState<string | null>(null);

    // `undefined` = the parent does not own the numbers; `null` from the parent is an
    // answer (“I do not have them”), and that is something other than no prop.
    const ownsCounts = countsProp === undefined;
    // Disabled, the hook returns EMPTY (counts: null, failed: false) — precisely the
    // state “no answer yet”, so nothing draws a number. A FAILED read ends at the same
    // null but with `failed` true, and the screen must catch that difference: without
    // a poller that number does not come back, so “not in yet” would be a promise.
    const { counts: fetched, failed: fetchFailed } = useStudioCounts({ enabled: ownsCounts, poll: false });

    const counts = ownsCounts ? fetched : countsProp;
    const failed = ownsCounts ? fetchFailed : countsFailed;
    const geometries = useMemo(() => edgeGeometries(), []);
    const selectedNode = selected ? mapNode(selected) : null;
    const selectedEdges = selected ? edgesOf(selected) : [];
    const selectedMeta = selectedNode ? blockMeta(selectedNode.kind) : null;

    // The name of a section comes from studioNav.js, not from a fourth copy of the same
    // three lines — that copy lacked the runtime-module branch, and then a tile was
    // named differently from the same section on the rail.
    const labelOf = (node: MapNode | null) => {
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
                        className="absolute inset-0 [pointer-events:none]"
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
