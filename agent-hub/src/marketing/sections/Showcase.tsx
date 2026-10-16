import React from 'react';
import EditableText from '../components/EditableText';
import FramedMedia from '../components/FramedMedia';
import SectionFrame from '../components/SectionFrame';
import SectionHeader from '../components/SectionHeader';
import { sectionBgClass } from './sectionBg';
import type { MediaSlot, SectionDataBase } from './sectionData.types';

// True inside the CMS editor's preview iframe (?preview) — an empty media slot
// keeps its placeholder frame there, but never on the published site.
const isEditable = () =>
    typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('preview');

const hasSrc = (m?: MediaSlot) => typeof m?.src === 'string' && m.src.trim() !== '';

interface ShowcaseData extends SectionDataBase {
    variant?: string;
    media?: MediaSlot;
    mediaSecondary?: MediaSlot;
    code?: { language?: string; snippet?: string };
}

export default function Showcase({ data }: { data?: ShowcaseData }) {
    if (!data?.enabled) return null;
    // 'single' is the default/fallback (no legacy layout): one full-container
    // framed shot with glow + fade-mask. 'pair' = two frames side by side;
    // 'code-ui' = mono code panel (no syntax highlighting) + frame, 5/7.
    const variant = (['pair', 'code-ui'] as readonly (string | undefined)[]).includes(data.variant) ? data.variant : 'single';
    const code = data.code || {};
    // Published site: an empty slot collapses instead of a grey skeleton pane.
    const showMedia = hasSrc(data.media) || isEditable();
    const showSecondary = hasSrc(data.mediaSecondary) || isEditable();

    return (
        <SectionFrame id="showcase" name="Showcase" enabled={data.enabled}>
            <section id="showcase" className={sectionBgClass(data)}>
                <div className="container">
                    <SectionHeader
                        pathPrefix="showcase"
                        eyebrow={data.eyebrow} title={data.title} lead={data.lead}
                        eyebrowStyle={data.eyebrowStyle} titleStyle={data.titleStyle} leadStyle={data.leadStyle}
                        eyebrowAlign={data.eyebrowAlign} titleAlign={data.titleAlign} leadAlign={data.leadAlign} align={data.align}
                    />
                    {variant === 'pair' ? (
                        <div className="showcase-pair reveal">
                            {showMedia ? <FramedMedia media={data.media} glow={false} /> : null}
                            {showSecondary ? <FramedMedia media={data.mediaSecondary} glow={false} /> : null}
                        </div>
                    ) : variant === 'code-ui' ? (
                        <div className="showcase-code-ui reveal">
                            {/* Mono code panel — deliberately NO syntax highlighting
                                (tokens only, quiet institutional register). */}
                            <div className="showcase-code">
                                <EditableText
                                    as="span"
                                    path="showcase.code.language"
                                    placeholder="bash"
                                    className="showcase-code-lang eyebrow-mono"
                                >
                                    {code.language || ''}
                                </EditableText>
                                <EditableText
                                    as="pre"
                                    path="showcase.code.snippet"
                                    multiline
                                    placeholder="$ …"
                                    className="showcase-code-snippet"
                                >
                                    {code.snippet || ''}
                                </EditableText>
                            </div>
                            {showMedia ? <FramedMedia media={data.media} /> : null}
                        </div>
                    ) : showMedia ? (
                        <div className="showcase-single reveal">
                            <FramedMedia media={data.media} fadeMask />
                        </div>
                    ) : null}
                </div>
            </section>
        </SectionFrame>
    );
}
