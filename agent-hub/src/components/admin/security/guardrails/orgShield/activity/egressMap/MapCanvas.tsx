/**
 * The map itself: measures the card, projects the world into it, and wires
 * d3-zoom, the overlays (kind pills, controls, legend, hint), the tooltip and
 * the bubble picker around the drawn layers. What goes where is mapModel.ts
 * (via useMapModel.ts); what it looks like is MapLayers.tsx and
 * PinLabels.tsx.
 */

import { X } from 'lucide-react';
import React, { useEffect, useId, useMemo, useRef, useState } from 'react';

import { useReducedMotion } from '../../../../../../../hooks/useReducedMotion';
import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import type { EgressMapFilters } from './egressMapContract';
import { MapControls } from './MapControls';
import { MapKindPills } from './MapKindPills';
import { CountryLayer, MapLayers, ORIGIN_KEY, type KindFocus } from './MapLayers';
import { MapLegend } from './MapLegend';
import { MapTooltip } from './MapTooltip';
import { applyZoom, boxOf, clusterPins, fitTransform, isSameSpot, type Pt, type ZoomState } from './mapGeometry';
import type { DestinationCluster, MapDestination, MapOrigin } from './mapModel';
import { PinLabels } from './PinLabels';
import { useElementSize, useMapModel, type MapGeo, type MapModel } from './useMapModel';
import { useMapZoom, type MapZoom } from './useMapZoom';
import type { Atlas } from './useWorldAtlas';

const ZOOM_STEP = 1.6;
const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.userAgent || '');
const ZOOM_KEY = IS_MAC ? '⌘' : 'Ctrl';
const NO_KINDS: KindFocus['hostKinds'] = {};
const idLabel = (id: string) => id;

interface Props {
    atlas: Atlas | null;
    dests: MapDestination[];
    origin: MapOrigin | null;
    selected: string | null;
    hovered: string | null;
    onHover: (host: string | null) => void;
    onSelect: (host: string) => void;
    filters?: EgressMapFilters;
    locale?: string;
    t: TranslateFn;
}

export function MapCanvas(props: Props) {
    const wrapRef = useRef<HTMLDivElement>(null);
    const size = useElementSize(wrapRef);
    const { geo, model } = useMapModel(props.atlas, size, props.dests, props.origin);
    return (
        <div
            ref={wrapRef}
            className="@container relative rounded-[10px] overflow-hidden border border-[var(--border-subtle)] bg-[var(--bg-secondary)] h-[clamp(280px,42vw,400px)]"
        >
            {geo && model ? <MapView {...props} geo={geo} model={model} /> : (
                <div className="absolute inset-0 grid place-items-center text-[11px] text-[var(--text-tertiary)]">
                    {props.t('admin.shield_map_loading', 'Drawing the map…')}
                </div>
            )}
        </div>
    );
}

/** A flag that switches itself off again, for the "hold Ctrl" hint. */
function useFlash(ms: number): [boolean, () => void] {
    const [on, setOn] = useState(false);
    const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
    const flash = () => {
        setOn(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setOn(false), ms);
    };
    return [on, flash];
}

/** What the tooltip is about and where it points: a pin, your server, or a local destination sitting on it. */
function tooltipTarget(model: MapModel, hovered: string | null, clusters: DestinationCluster[], transform: ZoomState) {
    if (!hovered) return null;
    const o = model.origin ? applyZoom(model.origin, transform) : null;
    if (o && hovered === ORIGIN_KEY) return { anchor: o, dest: null };
    if (o && model.localHosts.has(hovered)) return { anchor: o, dest: model.byHost.get(hovered) || null };
    const c = clusters.find(cl => cl.members.some(m => m.host === hovered));
    return c ? { anchor: c.at as Pt, dest: model.byHost.get(hovered) || null } : null;
}

/** The pane's kind filter as the layers need it; without the pane, no filter and ids as labels. */
function useKindFocus(filters: EgressMapFilters | undefined) {
    const kind = filters?.selectedKind || null;
    const hostKinds = filters?.hostKinds || NO_KINDS;
    const focus = useMemo<KindFocus>(() => ({ kind, hostKinds }), [kind, hostKinds]);
    return { focus, catLabel: filters?.catLabel || idLabel };
}

/** Your server lights up for itself and for any destination that sits on it. */
const originLit = (model: MapModel, hovered: string | null, selected: string | null) =>
    hovered === ORIGIN_KEY || [hovered, selected].some(h => !!h && model.localHosts.has(h));

function MapView({ geo, model, origin, selected, hovered, onHover, onSelect, filters, locale, t }: Props & { geo: MapGeo; model: MapModel }) {
    const svgRef = useRef<SVGSVGElement>(null);
    const reducedMotion = useReducedMotion();
    const tooltipId = useId();
    const [focusKey, setFocusKey] = useState<string | null>(null);
    const [picker, setPicker] = useState<string[] | null>(null);
    const [hint, flashHint] = useFlash(1600);
    const zoom = useMapZoom(svgRef, {
        size: geo.size, extent: model.extent, home: model.home, homeKey: model.homeKey, reducedMotion, onPlainWheel: flashHint,
    });
    const clusters = useMemo(() => clusterPins(model.placement.placed, zoom.transform), [model, zoom.transform]);
    const { focus, catLabel } = useKindFocus(filters);

    const openCluster = (cluster: DestinationCluster) => {
        if (isSameSpot(cluster)) { setPicker(cluster.members.map(m => m.host)); return; }
        zoom.zoomTo(fitTransform(boxOf(cluster.members.map(m => m.xy)), geo.size, { extent: model.extent, padding: 56 }));
    };
    const tip = tooltipTarget(model, hovered, clusters, zoom.transform);

    return (
        <div
            className="contents"
            onKeyDown={(e) => {
                // An open picker takes the first Escape; the next one clears the filter.
                if (e.key === 'Escape' && picker) { setPicker(null); e.stopPropagation(); }
            }}
        >
            <svg
                ref={svgRef}
                width={geo.size.w}
                height={geo.size.h}
                role="group"
                aria-label={t('egress_map.alt', 'World map of where your data went: your server, and a line to each place data was sent to.')}
                className="block touch-pan-y cursor-grab active:cursor-grabbing select-none"
            >
                <g transform={`translate(${zoom.transform.x},${zoom.transform.y}) scale(${zoom.transform.k})`}>
                    <CountryLayer shapes={geo.shapes} received={model.received} />
                </g>
                <MapLayers
                    model={model}
                    transform={zoom.transform}
                    clusters={clusters}
                    selected={selected}
                    active={hovered}
                    focusKey={focusKey}
                    originActive={originLit(model, hovered, selected)}
                    reducedMotion={reducedMotion}
                    focus={focus}
                    tooltipId={tooltipId}
                    on={{ hover: onHover, focusKey: setFocusKey, select: onSelect, cluster: openCluster }}
                    t={t}
                />
                <PinLabels
                    model={model}
                    clusters={clusters}
                    transform={zoom.transform}
                    size={geo.size}
                    selected={selected}
                    focus={focus}
                    catLabel={catLabel}
                    t={t}
                />
            </svg>
            <MapOverlays filters={filters} zoom={zoom} showOrigin={!!model.origin} hint={hint} t={t} />
            {tip && (
                <MapTooltip
                    id={tooltipId}
                    anchor={tip.anchor}
                    box={geo.size}
                    dest={tip.dest}
                    kinds={tip.dest ? focus.hostKinds[tip.dest.host] : null}
                    catLabel={catLabel}
                    originLabel={origin?.label || origin?.country_name}
                    localCalls={model.localCalls}
                    locale={locale}
                    t={t}
                />
            )}
            {picker && <ClusterPicker hosts={picker} selected={selected} onHover={onHover} onSelect={onSelect} onClose={() => setPicker(null)} t={t} />}
        </div>
    );
}

/** Everything drawn over the map's corners: kind pills, zoom controls, legend and hint. */
function MapOverlays({ filters, zoom, showOrigin, hint, t }: {
    filters?: EgressMapFilters; zoom: MapZoom; showOrigin: boolean; hint: boolean; t: TranslateFn;
}) {
    return (
        <>
            {filters && <MapKindPills filters={filters} t={t} />}
            <MapControls
                onZoomIn={() => zoom.zoomBy(ZOOM_STEP)}
                onZoomOut={() => zoom.zoomBy(1 / ZOOM_STEP)}
                onFit={zoom.fit}
                onWorld={zoom.world}
                t={t}
            />
            <MapLegend t={t} showOrigin={showOrigin} />
            <ZoomHint flash={hint} t={t} />
        </>
    );
}

/** Destinations on one spot, which no zoom can pull apart: pick one from a list. */
function ClusterPicker({ hosts, selected, onHover, onSelect, onClose, t }: {
    hosts: string[];
    selected: string | null;
    onHover: (host: string | null) => void;
    onSelect: (host: string) => void;
    onClose: () => void;
    t: TranslateFn;
}) {
    return (
        <div className="absolute left-2.5 bottom-2.5 z-20 w-[260px] max-w-[calc(100%-20px)] rounded-lg border border-[var(--border-default)] bg-[var(--bg-card)] shadow-[var(--shadow-md)] p-2">
            <div className="flex items-center gap-2 pb-1">
                <span className="text-[11px] font-semibold text-[var(--text-primary)]">
                    {t('egress_map.cluster_pick', '{n} destinations at this spot', { n: hosts.length })}
                </span>
                <button
                    type="button"
                    onClick={onClose}
                    aria-label={t('egress_map.cluster_close', 'Close')}
                    className="ml-auto p-0.5 rounded text-[var(--text-tertiary)] hover:text-[var(--text-primary)]"
                >
                    <X className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
            </div>
            {hosts.map(host => (
                <button
                    key={host}
                    type="button"
                    aria-pressed={selected === host}
                    onClick={() => { onSelect(host); onClose(); }}
                    onMouseEnter={() => onHover(host)}
                    onMouseLeave={() => onHover(null)}
                    className="block w-full text-left truncate font-mono text-[11px] px-1.5 py-1 rounded text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] aria-pressed:bg-[color-mix(in_srgb,var(--info)_12%,transparent)]"
                >
                    {host}
                </button>
            ))}
        </div>
    );
}

/**
 * How to move the map, in its bottom-right corner. A plain wheel scrolls
 * the page on purpose (see useMapZoom.ts), so the hint names the key; when
 * someone tries a plain wheel anyway, a darker "hold Ctrl" flashes in its
 * place and is read out.
 */
function ZoomHint({ flash, t }: { flash: boolean; t: TranslateFn }) {
    return (
        <div aria-live="polite" className="pointer-events-none absolute right-2.5 bottom-2.5 z-10">
            {flash ? (
                <span className="block rounded-[7px] bg-[var(--text-primary)] text-[rgb(from_var(--bg-card)_r_g_b_/_1)] text-[11px] font-medium px-[9px] py-1 shadow-[var(--shadow-md)]">
                    {t('egress_map.zoom_hint', 'Hold {key} and scroll to zoom', { key: ZOOM_KEY })}
                </span>
            ) : (
                <span aria-hidden="true" className="hidden @3xl:block rounded-[7px] bg-[color-mix(in_srgb,var(--bg-card)_92%,transparent)] text-[11px] text-[var(--text-tertiary)] px-[9px] py-1">
                    {t('egress_map.hint', 'Drag to move · {key} + scroll or +/− to zoom', { key: ZOOM_KEY })}
                </span>
            )}
        </div>
    );
}
