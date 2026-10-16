import React, { useState } from 'react';
import SectionHeader from '../components/SectionHeader';
import EditableText from '../components/EditableText';
import FramedMedia from '../components/FramedMedia';
import SectionFrame from '../components/SectionFrame';
import { sectionBgClass } from './sectionBg';
import './tour.css';
import type { MediaSlot, SectionDataBase } from './sectionData.types';

/**
 * Click-through product tour: one screenshot per step with numbered hotspots.
 * A hotspot opens its explanation under the image; previous / next walk the
 * steps. Content shape (BLOCK_DEFAULTS 'tour' in server/i18n/defaults/cmsDefaults.js):
 *
 *   { eyebrow, title, lead, labels: { previous, next, stepOf, hotspot },
 *     steps: [{ title, body, media, hotspots: [{ x, y, label, body }] }] }
 *
 * `x` and `y` are percentages of the image. Everything is a real <button>, so
 * the tour works from the keyboard; the explanation sits in a polite live
 * region. Motion (the pulse on a hotspot) is off under reduced motion.
 */

interface Hotspot { x?: number; y?: number; label?: string; body?: string }
interface TourStep { title?: string; body?: string; media?: MediaSlot; hotspots?: Hotspot[] }
interface TourLabels { previous?: string; next?: string; stepOf?: string; hotspot?: string }
interface TourData extends SectionDataBase { steps?: TourStep[]; labels?: TourLabels }

const isEditable = () =>
    typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('preview');

const hasText = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const pct = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(100, Math.max(0, v)) : 50);
const fill = (tpl: string, vars: Record<string, number>) =>
    tpl.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));

/** Positions a hotspot from its percentages without an inline style object. */
const place = (h: Hotspot) => (el: HTMLButtonElement | null) => {
    if (!el) return;
    el.style.setProperty('--tour-x', `${pct(h.x)}%`);
    el.style.setProperty('--tour-y', `${pct(h.y)}%`);
};

export default function Tour({ data }: { data?: TourData }) {
    const editing = isEditable();
    const [stepAt, setStepAt] = useState(0);
    const [openSpot, setOpenSpot] = useState<number | null>(null);

    const entries = (Array.isArray(data?.steps) ? data.steps : [])
        .map((step, idx) => ({ step: step || {}, idx }))
        .filter(({ step }) => editing || hasText(step.title) || hasText(step.body) || hasText(step.media?.src));
    if (!data?.enabled || entries.length === 0) return null;

    const labels = data.labels || {};
    const pos = Math.min(stepAt, entries.length - 1);
    const { step, idx } = entries[pos];
    const spots = Array.isArray(step.hotspots) ? step.hotspots : [];
    const spot = openSpot !== null ? spots[openSpot] : undefined;
    const go = (to: number) => { setStepAt(to); setOpenSpot(null); };
    const panelId = `tour-panel-${idx}`;

    return (
        <SectionFrame id="tour" name="Product tour" enabled={data.enabled}>
            <section id="tour" className={`tour ${sectionBgClass(data)}`.trim()}>
                <div className="container">
                    <SectionHeader pathPrefix="tour" {...data} />
                    <div className="tour__stage">
                        <div className="tour__figure">
                            <FramedMedia media={step.media} />
                            {spots.map((h, n) => (
                                <button
                                    key={n}
                                    type="button"
                                    ref={place(h)}
                                    className={`tour__hotspot${openSpot === n ? ' is-open' : ''}`}
                                    aria-expanded={openSpot === n}
                                    aria-controls={panelId}
                                    aria-label={h.label || fill(labels.hotspot || 'Hotspot {n}', { n: n + 1 })}
                                    onClick={() => setOpenSpot(openSpot === n ? null : n)}
                                    onKeyDown={(e) => { if (e.key === 'Escape') setOpenSpot(null); }}
                                >
                                    {n + 1}
                                </button>
                            ))}
                        </div>
                        <div className="tour__panel" id={panelId} role="region" aria-live="polite" aria-label={step.title || undefined}>
                            {spot ? (
                                <>
                                    <EditableText as="h3" path={`tour.steps.${idx}.hotspots.${openSpot}.label`} placeholder="Hotspot label" className="headline-md">
                                        {spot.label || ''}
                                    </EditableText>
                                    <EditableText as="p" path={`tour.steps.${idx}.hotspots.${openSpot}.body`} multiline placeholder="Hotspot description" className="body-md">
                                        {spot.body || ''}
                                    </EditableText>
                                </>
                            ) : (
                                <>
                                    <EditableText as="h3" path={`tour.steps.${idx}.title`} placeholder="Step title" className="headline-md">
                                        {step.title || ''}
                                    </EditableText>
                                    <EditableText as="p" path={`tour.steps.${idx}.body`} multiline placeholder="Step description" className="body-md">
                                        {step.body || ''}
                                    </EditableText>
                                </>
                            )}
                        </div>
                        <nav className="tour__nav" aria-label={fill(labels.stepOf || 'Step {n} of {total}', { n: pos + 1, total: entries.length })}>
                            <button type="button" className="btn btn-secondary" disabled={pos === 0} onClick={() => go(pos - 1)}>
                                {labels.previous || 'Previous step'}
                            </button>
                            <span className="tour__count">{fill(labels.stepOf || 'Step {n} of {total}', { n: pos + 1, total: entries.length })}</span>
                            <button type="button" className="btn btn-primary" disabled={pos === entries.length - 1} onClick={() => go(pos + 1)}>
                                {labels.next || 'Next step'}
                            </button>
                        </nav>
                    </div>
                </div>
            </section>
        </SectionFrame>
    );
}
