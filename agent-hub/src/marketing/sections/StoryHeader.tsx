import React from 'react';
import EditableText from '../components/EditableText';
import FramedMedia from '../components/FramedMedia';
import SectionFrame from '../components/SectionFrame';
import { sectionBgClass } from './sectionBg';
import type { MediaSlot, SectionDataBase } from './sectionData.types';
import './stories.css';

interface StoryHeaderData extends SectionDataBase {
    customer?: string;
    sector?: string;
    title?: string;
    lead?: string;
    logo?: MediaSlot;
    quote?: string;
    quoteBy?: string;
    metrics?: { stat?: string; label?: string }[];
}

const hasText = (v: unknown) => typeof v === 'string' && v.trim() !== '';
const isEditable = () => typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('preview');

function StoryMetrics({ metrics, editing }: { metrics: StoryHeaderData['metrics']; editing: boolean }) {
    const shown = (metrics || []).map((m, i) => ({ m, i })).filter(({ m }) => editing || hasText(m.stat) || hasText(m.label));
    if (!shown.length) return null;
    return (
        <dl className="story-metrics reveal">
            {shown.map(({ m, i }) => (
                <div key={i} className="story-metric">
                    <dt className="story-metric-label">
                        <EditableText path={`story-header.metrics.${i}.label`} placeholder="What it measures">{m.label || ''}</EditableText>
                    </dt>
                    <dd className="story-metric-stat tnum">
                        <EditableText path={`story-header.metrics.${i}.stat`} placeholder="60%">{m.stat || ''}</EditableText>
                    </dd>
                </div>
            ))}
        </dl>
    );
}

function StoryQuote({ data, editing }: { data: StoryHeaderData; editing: boolean }) {
    if (!hasText(data.quote) && !editing) return null;
    return (
        <figure className="story-quote reveal">
            <blockquote>
                <EditableText as="p" path="story-header.quote" multiline placeholder="A sentence from the customer">{data.quote || ''}</EditableText>
            </blockquote>
            {(hasText(data.quoteBy) || editing) ? (
                <figcaption>
                    <EditableText path="story-header.quoteBy" placeholder="Name, role">{data.quoteBy || ''}</EditableText>
                </figcaption>
            ) : null}
        </figure>
    );
}

function StoryTop({ data, editing }: { data: StoryHeaderData; editing: boolean }) {
    const showSep = editing || (hasText(data.customer) && hasText(data.sector));
    return (
        <div className="story-header-top">
            {hasText(data.logo?.src) ? (
                <div className="story-header-logo">
                    <FramedMedia media={{ ...data.logo, frame: 'none', kind: 'image', alt: data.logo?.alt || data.customer || '' }} glow={false} sizes="240px" />
                </div>
            ) : null}
            <p className="story-header-meta">
                <EditableText path="story-header.customer" placeholder="Customer">{data.customer || ''}</EditableText>
                {showSep ? <span className="story-header-sep" aria-hidden="true">·</span> : null}
                <EditableText path="story-header.sector" placeholder="Sector">{data.sector || ''}</EditableText>
            </p>
        </div>
    );
}

/**
 * Customer-story header: the top of a case-study page. Logo, sector, the
 * story's headline (the page's h1), a summary, 2-4 headline figures and the
 * customer's quote. The "Customer stories" grid reads the same fields from
 * the published page, so they are written once.
 *
 * EditableText paths: story-header.{customer,sector,title,lead,quote,quoteBy}
 * and story-header.metrics.{i}.{stat,label}. An empty field renders nothing
 * on the published site (no nameless headings, no empty quote marks); the
 * editor keeps every placeholder.
 */
export default function StoryHeader({ data }: { data?: StoryHeaderData }) {
    if (!data?.enabled) return null;
    const editing = isEditable();
    return (
        <SectionFrame id="story-header" name="Customer story" enabled={data.enabled}>
            <section id="story-header" className={`story-header ${sectionBgClass(data)}`.trim()}>
                <div className="container">
                    <StoryTop data={data} editing={editing} />
                    {(hasText(data.title) || editing) ? (
                        <EditableText as="h1" path="story-header.title" multiline placeholder="Story headline" className="headline-lg story-header-title">
                            {data.title || ''}
                        </EditableText>
                    ) : null}
                    {(hasText(data.lead) || editing) ? (
                        <EditableText as="p" path="story-header.lead" multiline placeholder="Summary" className="story-header-lead">
                            {data.lead || ''}
                        </EditableText>
                    ) : null}
                    <StoryMetrics metrics={data.metrics} editing={editing} />
                    <StoryQuote data={data} editing={editing} />
                </div>
            </section>
        </SectionFrame>
    );
}
