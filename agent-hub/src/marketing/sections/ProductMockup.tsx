import { useCallback, useEffect, useState } from 'react';
import EditableText from '../components/EditableText';
import SectionFrame from '../components/SectionFrame';
import SectionHeader from '../components/SectionHeader';
import { sectionBgClass } from './sectionBg';
import type { SectionDataBase } from './sectionData.types';
import useInViewOnce from '../motion/useInViewOnce';
import useTypewriter from '../motion/useTypewriter';
import './productMockup.css';

/**
 * Animated product mockup: the app drawn as a tilted panel in which a prompt
 * types itself and the answer builds up step by step. It is content, not
 * video: the prompt, the chat bubbles and the cards are text the editor
 * writes (and the translator can translate), and it costs no media bytes.
 *
 *   { eyebrow, title, lead, tilt: 'right' | 'left' | 'none', scrollTilt,
 *     windowTitle, prompt, steps: [{ role: 'user' | 'assistant' | 'card', title?, text }] }
 *
 * Every step and the whole prompt are in the markup from the first render, so
 * the panel has its final size at once (no layout shift) and screen readers
 * get all the text; the animation only changes what is visible.
 *
 * Reduced motion and the editor preview show the finished state at once. The
 * tilt eases flat as the panel scrolls to the middle of the screen (CSS scroll
 * timeline, `scrollTilt`), where the browser supports it.
 *
 * Inline-edit paths: product-mockup.eyebrow / .title / .lead / .prompt
 */

interface MockupStep {
    role?: string;
    title?: string;
    text?: string;
}

interface ProductMockupData extends SectionDataBase {
    tilt?: string;
    scrollTilt?: boolean;
    windowTitle?: string;
    prompt?: string;
    steps?: MockupStep[];
}

const STEP_DELAY_MS = 700;

const isPreview = () =>
    typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('preview');

const reducedMotion = () =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function stepRole(step: MockupStep): 'user' | 'assistant' | 'card' {
    return step.role === 'user' || step.role === 'card' ? step.role : 'assistant';
}

/** The animation: type the prompt once the panel is seen, then reveal the steps one by one. */
function useMockupSequence(prompt: string, stepCount: number) {
    const [ref, seen] = useInViewOnce<HTMLDivElement>();
    const [typed, setTyped] = useState(false);
    const [shown, setShown] = useState(0);
    const instant = isPreview() || reducedMotion();
    const ready = !instant && typed;
    const onTyped = useCallback(() => setTyped(true), []);
    const text = useTypewriter(prompt, seen, instant, onTyped);

    useEffect(() => {
        if (!ready || shown >= stepCount) return undefined;
        const id = window.setTimeout(() => setShown((n) => n + 1), STEP_DELAY_MS);
        return () => window.clearTimeout(id);
    }, [ready, shown, stepCount]);

    return {
        ref,
        text,
        visibleSteps: instant ? stepCount : shown,
        done: instant || (typed && shown >= stepCount),
    };
}

export default function ProductMockup({ data }: { data?: ProductMockupData }) {
    const prompt = data?.prompt || '';
    const rawSteps = data?.steps;
    const steps = Array.isArray(rawSteps) ? rawSteps : [];
    const { ref, text, visibleSteps, done } = useMockupSequence(prompt, steps.length);

    if (!data?.enabled) return null;
    const tilt = data.tilt === 'left' || data.tilt === 'none' ? data.tilt : 'right';
    const stageClass = `product-mockup-stage product-mockup-stage--tilt-${tilt}${data.scrollTilt ? ' product-mockup-stage--scroll' : ''}`;

    return (
        <SectionFrame id="product-mockup" name="Product mockup" enabled={data.enabled}>
            <section id="product-mockup" className={`product-mockup-block ${sectionBgClass(data)}`.trim()}>
                <div className="container">
                    <SectionHeader
                        pathPrefix="product-mockup"
                        eyebrow={data.eyebrow} title={data.title} lead={data.lead}
                        eyebrowStyle={data.eyebrowStyle} titleStyle={data.titleStyle} leadStyle={data.leadStyle}
                        eyebrowAlign={data.eyebrowAlign} titleAlign={data.titleAlign} leadAlign={data.leadAlign} align={data.align}
                    />
                    <div ref={ref} className={stageClass}>
                        <div className="product-mockup-window reveal">
                            <div className="product-mockup-chrome" aria-hidden="true">
                                <span className="product-mockup-dot" /><span className="product-mockup-dot" /><span className="product-mockup-dot" />
                                <span className="product-mockup-wtitle">{data.windowTitle || ''}</span>
                            </div>
                            <div className="product-mockup-body">
                                <div className="product-mockup-prompt">
                                    <span className="product-mockup-sr">{prompt}</span>
                                    <span aria-hidden="true">
                                        <EditableText path="product-mockup.prompt" placeholder="Describe what the assistant should do" multiline>
                                            {text}
                                        </EditableText>
                                        {!done ? <span className="product-mockup-caret" /> : null}
                                        {/* The part not typed yet, invisible: the box has its final size from the start. */}
                                        {text.length < prompt.length
                                            ? <span className="product-mockup-untyped">{prompt.slice(text.length)}</span>
                                            : null}
                                    </span>
                                </div>
                                <div className="product-mockup-steps" aria-live="off">
                                    {/* Every step is in the markup from the start (text for screen
                                        readers and crawlers, final size reserved); the ones not shown
                                        yet are only transparent. */}
                                    {steps.map((step, i) => (
                                        <div
                                            key={i}
                                            className={`product-mockup-step product-mockup-step--${stepRole(step)}`}
                                            data-shown={i < visibleSteps ? 'true' : 'false'}
                                        >
                                            {step.title ? <strong className="product-mockup-step-title">{step.title}</strong> : null}
                                            <span>{step.text || ''}</span>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </section>
        </SectionFrame>
    );
}
