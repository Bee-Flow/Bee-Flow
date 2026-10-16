import React from 'react';
import { Maximize2 } from 'lucide-react';

/**
 * The still a feature-demo block shows until a visitor asks for the live
 * demo. Three shapes share one look:
 *  - 'button': desktop. Pressing it (click, Enter, Space) boots the demo.
 *  - 'link':   phone. The product's desktop layout does not fit, so it opens
 *              the demo full screen in the same tab instead.
 *  - 'inert':  the CMS editor preview. Booting a second copy of the app inside
 *              the page being edited is heavy, so nothing happens here.
 * No request to /__demo__ is made by any of them.
 */
interface FeatureDemoPosterProps {
    mode: 'button' | 'link' | 'inert';
    image?: string;
    label: string;
    href?: string;
    onActivate?: () => void;
}

export default function FeatureDemoPoster({ mode, image, label, href, onActivate }: FeatureDemoPosterProps) {
    const content = (
        <>
            {image ? <img className="feature-demo-poster-img" src={image} alt="" loading="lazy" /> : null}
            <span className="feature-demo-poster-play">
                {mode === 'link' ? <Maximize2 aria-hidden="true" size={20} /> : '▶'}
            </span>
            <span className="feature-demo-poster-label">{label}</span>
        </>
    );
    if (mode === 'button') {
        return (
            <button type="button" className="feature-demo-poster" onClick={onActivate}>
                {content}
            </button>
        );
    }
    if (mode === 'link') {
        return <a className="feature-demo-poster" href={href}>{content}</a>;
    }
    return (
        <div className="feature-demo-poster" aria-hidden="true">
            {content}
            <span className="feature-demo-hint">Not booted here so the builder stays responsive.</span>
        </div>
    );
}
