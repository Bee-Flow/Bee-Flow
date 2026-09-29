/**
 * Zoom in, zoom out, back to the traffic, the whole world: one stacked group
 * in the map's top-right corner. The two last ones are the way home after
 * exploring: "fit" re-frames everything data went to, "world" shows the
 * whole band the map covers.
 */

import { Globe2, Maximize2, Minus, Plus, type LucideIcon } from 'lucide-react';
import React from 'react';

import type { TranslateFn } from '../../../../../../../hooks/useTranslation';

interface Props {
    onZoomIn: () => void;
    onZoomOut: () => void;
    onFit: () => void;
    onWorld: () => void;
    t: TranslateFn;
}

function Control({ icon: Icon, label, onClick }: { icon: LucideIcon; label: string; onClick: () => void }) {
    return (
        <button
            type="button"
            onClick={onClick}
            aria-label={label}
            title={label}
            className="w-[30px] h-[30px] grid place-items-center bg-transparent text-[var(--text-secondary)] hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[var(--text-primary)]"
        >
            <Icon className="w-3.5 h-3.5" strokeWidth={2.25} aria-hidden="true" />
        </button>
    );
}

export function MapControls({ onZoomIn, onZoomOut, onFit, onWorld, t }: Props) {
    return (
        <div
            role="group"
            aria-label={t('egress_map.controls', 'Map controls')}
            className="absolute right-2.5 top-2.5 z-10 flex flex-col divide-y divide-[var(--border-subtle)] rounded-lg overflow-hidden bg-[var(--bg-card)] shadow-[var(--shadow-sm)] border border-[var(--border-subtle)]"
        >
            <Control icon={Plus} label={t('egress_map.zoom_in', 'Zoom in')} onClick={onZoomIn} />
            <Control icon={Minus} label={t('egress_map.zoom_out', 'Zoom out')} onClick={onZoomOut} />
            <Control icon={Maximize2} label={t('egress_map.fit', 'Fit to traffic')} onClick={onFit} />
            <Control icon={Globe2} label={t('egress_map.world', 'Whole world')} onClick={onWorld} />
        </div>
    );
}
