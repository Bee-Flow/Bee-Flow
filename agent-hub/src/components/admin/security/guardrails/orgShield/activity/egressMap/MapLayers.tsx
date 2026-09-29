/**
 * The drawn layers of the egress map, bottom to top: countries, lines, your
 * server, pins. Everything here is decided in mapModel.ts; this file only
 * turns it into SVG. The labels beside the pins are PinLabels.tsx.
 *
 * Countries live in base space under one <g transform>, with
 * `vector-effect="non-scaling-stroke"` so borders stay hairlines at 8x.
 * Lines and pins are in screen space (see mapModel's header), so a pin keeps
 * its size and a dash its length at every zoom.
 *
 * Keyboard: every pin and every bubble is a button in the tab order, with a
 * visible ring drawn as an extra circle (an SVG <g> has no outline to show).
 * Lines are mouse shortcuts only; the pin at their end is the keyboard path
 * to the same destination.
 */

import React, { memo } from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';
import { REGION_FILL } from '../../shieldPalette';
import { placeLabel } from './locationCopy';
import { kindCount, type HostKinds } from './mapLabels';
import { applyZoom, arcPath, type ZoomState } from './mapGeometry';
import {
    countryFill, lineStyle, lineWidth, MUTED_FILL, ORIGIN_FILL, pinRadius,
    type CountryShape, type DestinationCluster, type LineStyle,
} from './mapModel';
import type { MapModel } from './useMapModel';

export const ORIGIN_KEY = '__origin__';

/** 177 paths that only change on a resize, not on every zoom tick. */
export const CountryLayer = memo(function CountryLayer({ shapes, received }: {
    shapes: CountryShape[];
    received: Map<string, 'eu' | 'outside'>;
}) {
    return (
        <>
            {shapes.map(s => (
                <path
                    key={s.key}
                    d={s.d}
                    fill={countryFill(s.code, s.code ? received.get(s.code) : undefined)}
                    stroke="var(--bg-card)"
                    strokeWidth={0.6}
                    vectorEffect="non-scaling-stroke"
                />
            ))}
        </>
    );
});

/** The kind filter as the map needs it: which kind is on, and what each host got. */
export interface KindFocus { kind: string | null; hostKinds: Record<string, HostKinds> }

/** A destination that got none of the kind being filtered on: grey pin, no line. */
export const isMuted = (host: string, focus: KindFocus) => !!focus.kind && kindCount(focus.hostKinds[host], focus.kind) === 0;

interface Handlers {
    hover: (host: string | null) => void;
    focusKey: (key: string | null) => void;
    select: (host: string) => void;
    cluster: (cluster: DestinationCluster) => void;
}

export interface LayerProps {
    model: Pick<MapModel, 'arcs' | 'byHost' | 'origin' | 'maxTotal'>;
    transform: ZoomState;
    clusters: DestinationCluster[];
    /** The filtered destination, if any. */
    selected: string | null;
    /** Hovered or focused host (or ORIGIN_KEY). */
    active: string | null;
    focusKey: string | null;
    originActive: boolean;
    reducedMotion: boolean;
    focus: KindFocus;
    tooltipId: string;
    on: Handlers;
    t: TranslateFn;
}

/** Dotted (round dots one line-width wide) or dashed, or nothing for a solid line. */
function dashOf(style: LineStyle, width: number): string | undefined {
    if (style.dash === 'dashed') return '5 5';
    if (style.dash === 'dotted') return `0 ${(width * 2 + 2).toFixed(1)}`;
    return undefined;
}

function Line({ host, path, width, style, opacity, animate, on }: {
    host: string; path: string; width: number; style: LineStyle; opacity: number; animate: boolean; on: Handlers;
}) {
    return (
        <g>
            <path
                d={path}
                fill="none"
                stroke={style.colour}
                strokeWidth={width}
                strokeLinecap="round"
                strokeDasharray={dashOf(style, width)}
                strokeOpacity={opacity}
            >
                {/* Outside Europe moves, from your server outward. SMIL, so the
                    dash period (10) and the loop agree without a keyframe. */}
                {animate && <animate attributeName="stroke-dashoffset" values="10;0" dur="1.2s" repeatCount="indefinite" />}
            </path>
            {/* A wide invisible stroke: a 1.5px line is not a click target. */}
            <path
                d={path}
                fill="none"
                stroke="transparent"
                strokeWidth={12}
                data-map-hit=""
                className="cursor-pointer"
                onMouseEnter={() => on.hover(host)}
                onMouseLeave={() => on.hover(null)}
                onClick={() => on.select(host)}
            />
        </g>
    );
}

function Lines({ model, transform, selected, active, reducedMotion, focus, on }: LayerProps) {
    const { byHost, maxTotal } = model;
    return (
        <g>
            {model.arcs.map(arc => {
                const d = byHost.get(arc.host);
                if (!d || isMuted(arc.host, focus)) return null;
                const lit = active === arc.host || selected === arc.host;
                const style = lineStyle(d);
                const width = lineWidth(d.total, maxTotal) + (lit ? 1 : 0);
                const opacity = selected && selected !== arc.host ? 0.15 : lit ? 0.9 : 0.55;
                return (
                    <Line
                        key={arc.host}
                        host={arc.host}
                        path={arcPath(arc, transform)}
                        width={width}
                        style={style}
                        opacity={opacity}
                        animate={style.animated && !reducedMotion}
                        on={on}
                    />
                );
            })}
        </g>
    );
}

function pinLabel(cluster: DestinationCluster, t: TranslateFn): string {
    if (cluster.members.length > 1) {
        return t('egress_map.cluster_label', '{n} destinations close together. Show them.', { n: cluster.members.length });
    }
    const [d] = cluster.members;
    return t('egress_map.pin_label', '{host}, {place}: {n} calls', { host: d.host, place: placeLabel(d, t) || '?', n: cluster.total });
}

interface MarkProps { r: number; colour: string; via: boolean; lit: boolean; isSelected: boolean; muted: boolean }

/** One destination: a dot in a halo, sized by its calls. A muted one is a pale dot without a halo. */
function SingleMark({ r, colour, via, lit, isSelected, muted }: MarkProps) {
    return (
        <>
            {!muted && <circle r={r + 5} fill={colour} fillOpacity={isSelected ? 0.35 : lit ? 0.25 : 0.15} />}
            {/* An edge, not the service: a dashed ring says so on the pin too. */}
            {via && !muted && <circle r={r + 5} fill="none" stroke={colour} strokeWidth={1} strokeDasharray="2 2" />}
            <circle
                r={r}
                fill={colour}
                fillOpacity={muted ? 0.5 : 1}
                stroke={isSelected ? 'var(--text-primary)' : 'var(--bg-card)'}
                strokeWidth={2}
            />
        </>
    );
}

/** Several destinations that would overlap: one bubble with the count. */
function BubbleMark({ count, colour }: { count: number; colour: string }) {
    return (
        <>
            <circle r={11} fill={colour} fillOpacity={0.9} stroke="var(--bg-card)" strokeWidth={2} />
            <text textAnchor="middle" dy="0.35em" fontSize={10} fontWeight={700} fill="var(--bg-card)">{count}</text>
        </>
    );
}

/** The radius a cluster is drawn at: a single pin by its calls, a bubble fixed. */
export const clusterRadius = (cluster: DestinationCluster, maxTotal: number) =>
    (cluster.members.length === 1 ? pinRadius(cluster.total, maxTotal) : 11);

function Pin({ cluster, props }: { cluster: DestinationCluster; props: LayerProps }) {
    const { selected, active, focusKey, tooltipId, focus, on, t } = props;
    const single = cluster.members.length === 1;
    const first = cluster.members[0];
    const hosts = cluster.members.map(m => m.host);
    const isSelected = !!selected && hosts.includes(selected);
    const isActive = !!active && hosts.includes(active);
    const muted = hosts.every(h => isMuted(h, focus));
    const colour = muted ? MUTED_FILL : REGION_FILL[first.state];
    const r = clusterRadius(cluster, props.model.maxTotal);
    const act = () => (single ? on.select(first.host) : on.cluster(cluster));

    return (
        <g
            transform={`translate(${cluster.at[0].toFixed(1)},${cluster.at[1].toFixed(1)})`}
            opacity={selected && !isSelected ? 0.45 : 1}
            role="button"
            tabIndex={0}
            aria-pressed={single ? isSelected : undefined}
            aria-label={pinLabel(cluster, t)}
            aria-describedby={isActive ? tooltipId : undefined}
            data-map-hit=""
            className="cursor-pointer outline-none"
            onClick={act}
            onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); act(); }
            }}
            onMouseEnter={() => on.hover(first.host)}
            onMouseLeave={() => on.hover(null)}
            onFocus={() => { on.focusKey(cluster.key); on.hover(first.host); }}
            onBlur={() => { on.focusKey(null); on.hover(null); }}
        >
            {single
                ? <SingleMark r={r} colour={colour} via={first.state === 'via_network'} lit={isActive} isSelected={isSelected} muted={muted} />
                : <BubbleMark count={cluster.members.length} colour={colour} />}
            {focusKey === cluster.key && (
                <circle r={r + 8} fill="none" stroke="var(--text-primary)" strokeWidth={2} strokeDasharray="3 2" />
            )}
            <circle r={Math.max(15, r + 4)} fill="transparent" />
        </g>
    );
}

export function MapLayers(props: LayerProps) {
    const { model, transform, clusters, originActive, on, t } = props;
    const o = model.origin ? applyZoom(model.origin, transform) : null;
    return (
        <>
            {/* Lines first, so neither your server nor a pin is ever hidden by one. */}
            <Lines {...props} />
            {/* Your server above the lines but under the pins: an edge in your
                own city sits right on top of it and must stay reachable. */}
            {o && (
                <g
                    transform={`translate(${o[0].toFixed(1)},${o[1].toFixed(1)})`}
                    data-map-hit=""
                    onMouseEnter={() => on.hover(ORIGIN_KEY)}
                    onMouseLeave={() => on.hover(null)}
                >
                    <title>{t('egress_map.place_local', 'Your server')}</title>
                    <circle r={originActive ? 13 : 11} fill={ORIGIN_FILL} fillOpacity={originActive ? 0.3 : 0.15} />
                    <circle r={6} fill={ORIGIN_FILL} stroke="var(--bg-card)" strokeWidth={2} />
                    <circle r={2} fill="var(--bg-card)" />
                </g>
            )}
            <g>
                {clusters.map(c => <Pin key={c.key} cluster={c} props={props} />)}
            </g>
        </>
    );
}
