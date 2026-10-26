import React, { useState } from 'react';
import EditableText from '../components/EditableText';
import FramedMedia from '../components/FramedMedia';
import SectionFrame from '../components/SectionFrame';
import SectionHeader from '../components/SectionHeader';
import { sectionBgClass } from './sectionBg';
import { resolveGrid, useStories, type SectorChip, type StoryCard } from './storyCards';
import type { SectionDataBase } from './sectionData.types';
// Styles: stories.css, imported by extraSections.ts. This block loads lazily and
// the stylesheet is shared with the eager StoryHeader, so a second import here
// would split it into its own render-blocking file.

interface CustomerStoriesData extends SectionDataBase {
    limit?: number;
    sectorId?: string;
    showFilter?: boolean;
    allLabel?: string;
    linkLabel?: string;
    emptyText?: string;
    /** Filled by the server for the rendered HTML (stores/cms/stories.js); absent in the editor and after a client-side navigation. */
    items?: unknown;
}

const isEditable = () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('preview');

function StoryCardView({ card, linkLabel, index }: { card: StoryCard; linkLabel: string; index: number }) {
    const metrics = card.metrics.slice(0, 2);
    return (
        <article className="story-card">
            <div className="story-card-top">
                {card.logo.src ? (
                    <div className="story-card-logo">
                        <FramedMedia media={{ ...card.logo, frame: 'none', kind: 'image', alt: card.logo.alt || card.customer }} glow={false} sizes="160px" />
                    </div>
                ) : null}
                {card.sector ? <span className="story-card-sector">{card.sector}</span> : null}
            </div>
            <h3 className="story-card-title">
                <a className="story-card-link" href={card.href} aria-label={card.customer ? `${card.customer}: ${card.title}` : undefined}>
                    {card.title || card.customer}
                </a>
            </h3>
            {card.lead ? <p className="story-card-lead">{card.lead}</p> : null}
            {metrics.length ? (
                <ul className="story-card-metrics">
                    {metrics.map((m, i) => (
                        <li key={i}><strong className="tnum">{m.stat}</strong> <span>{m.label}</span></li>
                    ))}
                </ul>
            ) : null}
            <p className="story-card-more" aria-hidden="true">
                {/* One editable label (the first card) drives them all. */}
                {index === 0
                    ? <EditableText path="customer-stories.linkLabel" placeholder="Read the story">{linkLabel}</EditableText>
                    : <span>{linkLabel}</span>}
                <span> →</span>
            </p>
        </article>
    );
}

interface SectorFilterProps {
    chips: SectorChip[];
    active: string;
    title?: string;
    allLabel?: string;
    onPick: (id: string) => void;
}

function SectorFilter({ chips, active, title, allLabel, onPick }: SectorFilterProps) {
    if (chips.length < 2) return null;
    return (
        <div className="story-filter" role="group" aria-label={title || 'Sector'}>
            <button type="button" className="story-chip" aria-pressed={active === ''} onClick={() => onPick('')}>
                <EditableText path="customer-stories.allLabel" placeholder="All">{allLabel || 'All'}</EditableText>
            </button>
            {chips.map((chip) => (
                <button key={chip.id} type="button" className="story-chip" aria-pressed={active === chip.id} onClick={() => onPick(chip.id)}>
                    {chip.label}
                </button>
            ))}
        </div>
    );
}

/**
 * "Customer stories" grid with a sector filter. Stores no stories: they are
 * the pages of the live site that carry a story-header block, as last
 * published (GET /api/cms/stories). The server also puts the cards into the
 * rendered HTML (`data.items`), so crawlers get the links and a visitor gets
 * the grid without a second request; the filter is progressive (without
 * JavaScript every card is shown).
 *
 * EditableText paths: customer-stories.{allLabel,linkLabel,emptyText}.
 */
export default function CustomerStories({ data }: { data?: CustomerStoriesData }) {
    const [sector, setSector] = useState('');
    const limit = Math.min(24, Math.max(1, Math.floor(Number(data?.limit) || 6)));
    const fixedSector = data?.sectorId || '';
    const inlined = Array.isArray(data?.items);
    const fetched = useStories(limit, fixedSector, inlined);
    if (!data?.enabled) return null;

    const editing = isEditable();
    const { cards, chips, active, shown } = resolveGrid(data, fetched, sector);
    if (!cards.length && !editing) return null;
    const linkLabel = data.linkLabel || 'Read the story';
    return (
        <SectionFrame id="customer-stories" name="Customer stories" enabled={data.enabled}>
            <section id="customer-stories" className={`customer-stories ${sectionBgClass(data)}`.trim()}>
                <div className="container">
                    <SectionHeader
                        pathPrefix="customer-stories"
                        eyebrow={data.eyebrow} title={data.title} lead={data.lead}
                        eyebrowStyle={data.eyebrowStyle} titleStyle={data.titleStyle} leadStyle={data.leadStyle}
                        eyebrowAlign={data.eyebrowAlign} titleAlign={data.titleAlign} leadAlign={data.leadAlign} align={data.align}
                    />
                    <SectorFilter chips={chips} active={active} title={data.title} allLabel={data.allLabel} onPick={setSector} />
                    {shown.length ? (
                        <div className="story-grid reveal">
                            {shown.map((card, i) => <StoryCardView key={card.id} card={card} linkLabel={linkLabel} index={i} />)}
                        </div>
                    ) : (
                        <p className="story-empty">
                            <EditableText path="customer-stories.emptyText" placeholder="Published customer stories appear here">{data.emptyText || ''}</EditableText>
                        </p>
                    )}
                </div>
            </section>
        </SectionFrame>
    );
}
