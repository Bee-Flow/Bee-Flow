import React, { useEffect, useRef, useState } from 'react';
import SectionHeader from '../components/SectionHeader';
import EditableText from '../components/EditableText';
import FramedMedia from '../components/FramedMedia';
import SectionFrame from '../components/SectionFrame';
import { sectionBgClass } from './sectionBg';
import './scrollStory.css';
import type { MediaSlot, SectionDataBase } from './sectionData.types';

/**
 * Scroll story: steps run down the left, one sticky media panel on the right
 * shows the media of the step in view. Content shape (BLOCK_DEFAULTS
 * 'scrollStory' in server/i18n/defaults/cmsDefaults.js):
 *
 *   { eyebrow, title, lead, steps: [{ title, body, media }] }
 *
 * Reading order and accessibility come first, the scroll link is an extra:
 *  - Every step carries its own media inline. On phones, with reduced motion,
 *    in the editor and without script the story is a plain stack of steps.
 *  - Only on a wide screen without a reduced-motion preference is the inline
 *    media visually hidden (still read by a screen reader) and the sticky
 *    panel shown. The panel is aria-hidden: it only repeats what the steps say, and is inert so
 *    nothing in it takes focus. Media is limited to images (see hasMedia).
 *  - Each step is focusable, and focusing it makes it the active one, so a
 *    keyboard user moves the panel by tabbing through the steps.
 */

interface StoryStep {
    title?: string;
    body?: string;
    media?: MediaSlot;
}

interface ScrollStoryData extends SectionDataBase {
    steps?: StoryStep[];
}

const isEditable = () =>
    typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).has('preview');

const hasText = (v: unknown) => typeof v === 'string' && v.trim() !== '';
// Images only: the panel is inert and hidden from assistive technology, so a
// clip or video (native controls, autoplay) would be unreachable or play twice.
const hasMedia = (m?: MediaSlot) => hasText(m?.src) && (!m?.kind || m.kind === 'image');

export default function ScrollStory({ data }: { data?: ScrollStoryData }) {
    const editing = isEditable();
    const [active, setActive] = useState(0);
    const stepRefs = useRef<Array<HTMLLIElement | null>>([]);

    const entries = (Array.isArray(data?.steps) ? data.steps : [])
        .map((step, idx) => ({ step: step || {}, idx }))
        .filter(({ step }) => editing || hasText(step.title) || hasText(step.body) || hasMedia(step.media));
    const count = entries.length;

    // The step crossing the middle band of the viewport is the active one.
    useEffect(() => {
        if (count === 0 || typeof IntersectionObserver === 'undefined') return undefined;
        const observer = new IntersectionObserver((hits) => {
            for (const hit of hits) {
                if (!hit.isIntersecting) continue;
                const at = Number((hit.target as HTMLElement).dataset.pos);
                if (Number.isFinite(at)) setActive(at);
            }
        }, { rootMargin: '-45% 0px -45% 0px' });
        for (const el of stepRefs.current) if (el) observer.observe(el);
        return () => observer.disconnect();
    }, [count]);

    if (!data?.enabled || count === 0) return null;
    const current = Math.min(active, count - 1);

    return (
        <SectionFrame id="scroll-story" name="Scroll story" enabled={data.enabled}>
            <section id="scroll-story" className={`scroll-story ${editing ? 'scroll-story--editing' : ''} ${sectionBgClass(data)}`.trim()}>
                <div className="container">
                    <SectionHeader pathPrefix="scrollStory" {...data} />
                    <div className="scroll-story__grid">
                        <ol className="scroll-story__steps">
                            {entries.map(({ step, idx }, pos) => (
                                <li
                                    key={idx}
                                    ref={(el) => { stepRefs.current[pos] = el; }}
                                    data-pos={pos}
                                    className={`scroll-story__step${pos === current ? ' is-active' : ''}`}
                                    tabIndex={0}
                                    aria-current={pos === current ? 'step' : undefined}
                                    onFocus={() => setActive(pos)}
                                >
                                    <EditableText as="h3" path={`scrollStory.steps.${idx}.title`} placeholder="Step title" className="headline-md">
                                        {step.title || ''}
                                    </EditableText>
                                    <EditableText as="p" path={`scrollStory.steps.${idx}.body`} multiline placeholder="Step description" className="body-md">
                                        {step.body || ''}
                                    </EditableText>
                                    {hasMedia(step.media) ? (
                                        <div className="scroll-story__inline-media">
                                            <FramedMedia media={step.media} />
                                        </div>
                                    ) : null}
                                </li>
                            ))}
                        </ol>
                        <div className="scroll-story__panel" aria-hidden="true" inert>
                            {entries.map(({ step, idx }, pos) => (
                                <div key={idx} className={`scroll-story__slide${pos === current ? ' is-active' : ''}`}>
                                    {hasMedia(step.media) ? <FramedMedia media={step.media} /> : null}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>
            </section>
        </SectionFrame>
    );
}
