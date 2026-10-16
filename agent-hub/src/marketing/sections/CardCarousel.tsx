import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { ArrowLeft, ArrowRight } from 'lucide-react';
import EditableText from '../components/EditableText';
import SectionFrame from '../components/SectionFrame';
import SectionHeader from '../components/SectionHeader';
import { sectionBgClass } from './sectionBg';
import type { CmsHref, SectionDataBase } from './sectionData.types';
import './cardCarousel.css';

/**
 * Card carousel: large cards with soft animated gradients and a big ghost
 * numeral, in a horizontally scrolling row that snaps (CSS scroll-snap).
 * Previous/next buttons and the arrow keys scroll one card; the row itself is
 * a focusable region, and every card is plain text and links, so it reads and
 * tabs the same with the gradients switched off.
 *
 *   { eyebrow, title, lead, animated, showNumerals, prevLabel, nextLabel,
 *     cards: [{ title, body, numeral?, gradient: 'primary'|'accent'|'mix'|'dark',
 *               linkLabel?, link? }] }
 *
 * The gradients use the theme colours (--brand-primary / --brand-accent) and
 * only animate when `animated` is on and motion is welcome.
 */

interface CarouselCard {
    title?: string;
    body?: string;
    numeral?: string;
    gradient?: string;
    linkLabel?: string;
    link?: CmsHref;
    href?: string;
}

interface CardCarouselData extends SectionDataBase {
    cards?: CarouselCard[];
    animated?: boolean;
    showNumerals?: boolean;
    prevLabel?: string;
    nextLabel?: string;
}

const GRADIENTS = ['primary', 'accent', 'mix', 'dark'] as const;

function gradientOf(card: CarouselCard, index: number): (typeof GRADIENTS)[number] {
    return GRADIENTS.find((g) => g === card.gradient) ?? GRADIENTS[index % 3];
}

function CarouselCardView({ card, index, numerals }: { card: CarouselCard; index: number; numerals: boolean }) {
    const href = card.link?.href || card.href || '';
    const numeral = card.numeral?.trim() || String(index + 1).padStart(2, '0');
    return (
        <article className={`card-carousel-card card-carousel-card--${gradientOf(card, index)}`}>
            {numerals ? <span className="card-carousel-numeral" aria-hidden="true">{numeral}</span> : null}
            <div className="card-carousel-copy">
                <EditableText path={`card-carousel.cards.${index}.title`} as="h3" placeholder="Card title" className="card-carousel-title">
                    {card.title || ''}
                </EditableText>
                <EditableText path={`card-carousel.cards.${index}.body`} as="p" multiline placeholder="Card text" className="card-carousel-body">
                    {card.body || ''}
                </EditableText>
                {href && card.linkLabel ? <a className="card-carousel-link" href={href}>{card.linkLabel}</a> : null}
            </div>
        </article>
    );
}

export default function CardCarousel({ data }: { data?: CardCarouselData }) {
    const track = useRef<HTMLDivElement>(null);
    const [edges, setEdges] = useState({ start: true, end: false });

    const measure = useCallback(() => {
        const el = track.current;
        if (!el) return;
        setEdges({ start: el.scrollLeft <= 4, end: el.scrollLeft + el.clientWidth >= el.scrollWidth - 4 });
    }, []);

    useEffect(() => {
        measure();
        window.addEventListener('resize', measure);
        return () => window.removeEventListener('resize', measure);
    }, [measure, data?.cards]);

    if (!data?.enabled) return null;
    const cards = Array.isArray(data.cards) ? data.cards : [];

    const scrollByCard = (direction: 1 | -1) => {
        const el = track.current;
        if (!el) return;
        const card = el.querySelector<HTMLElement>('.card-carousel-card');
        const step = (card?.offsetWidth ?? el.clientWidth * 0.8) + 16;
        const smooth = !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        el.scrollBy({ left: direction * step, behavior: smooth ? 'smooth' : 'auto' });
    };

    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'ArrowRight') { e.preventDefault(); scrollByCard(1); }
        if (e.key === 'ArrowLeft') { e.preventDefault(); scrollByCard(-1); }
    };

    const sectionClass = [
        'card-carousel-block',
        data.animated !== false ? 'card-carousel-block--animated' : '',
        sectionBgClass(data),
    ].filter(Boolean).join(' ');

    return (
        <SectionFrame id="card-carousel" name="Card carousel" enabled={data.enabled}>
            <section id="card-carousel" className={sectionClass}>
                <div className="container">
                    <SectionHeader
                        pathPrefix="card-carousel"
                        eyebrow={data.eyebrow} title={data.title} lead={data.lead}
                        eyebrowStyle={data.eyebrowStyle} titleStyle={data.titleStyle} leadStyle={data.leadStyle}
                        eyebrowAlign={data.eyebrowAlign} titleAlign={data.titleAlign} leadAlign={data.leadAlign} align={data.align}
                    />
                    <div className="card-carousel-controls">
                        <button type="button" className="card-carousel-arrow" onClick={() => scrollByCard(-1)} disabled={edges.start} aria-label={data.prevLabel || 'Previous'}>
                            <ArrowLeft aria-hidden="true" />
                        </button>
                        <button type="button" className="card-carousel-arrow" onClick={() => scrollByCard(1)} disabled={edges.end} aria-label={data.nextLabel || 'Next'}>
                            <ArrowRight aria-hidden="true" />
                        </button>
                    </div>
                </div>
                <div
                    ref={track}
                    className="card-carousel-track"
                    role="region"
                    aria-roledescription="carousel"
                    aria-label={data.title || 'Cards'}
                    tabIndex={0}
                    onScroll={measure}
                    onKeyDown={onKeyDown}
                >
                    {cards.map((card, i) => (
                        <CarouselCardView key={i} card={card} index={i} numerals={data.showNumerals !== false} />
                    ))}
                </div>
            </section>
        </SectionFrame>
    );
}
