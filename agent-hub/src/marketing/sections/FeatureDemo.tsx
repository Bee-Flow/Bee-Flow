import React, { useEffect, useState } from 'react';
import { Maximize2 } from 'lucide-react';
import FeatureDemoPoster from './FeatureDemoPoster';
import SectionFrame from '../components/SectionFrame';
import SectionHeader from '../components/SectionHeader';
import { sectionBgClass } from './sectionBg';
import { DEMO_FEATURE_IDS } from '../../demo/registry';
import { LOCALE_PREFIXES } from '../../utils/cmsPublicRouting';
import type { SectionDataBase } from './sectionData.types';

interface FeatureDemoData extends SectionDataBase {
    feature?: string;
    height?: number;
    theme?: string;
    note?: string;
    caption?: string;
    poster?: string;
    cta?: { label?: string; href?: string; link?: { href?: string; path?: string } };
}

/**
 * Live feature demo — the real product UI, framed inside a marketing page.
 *
 * The iframe points at /__demo__/<feature>, which mounts the actual Studio
 * component against an in-memory fixture backend. Same components, same CSS,
 * so what a visitor plays with looks exactly like what they would get.
 *
 * WHY THE SRC IS BUILT HERE AND NOT AUTHORED
 * `content.feature` is an ID validated against the demo registry. An editor —
 * or an AI builder turn — therefore cannot turn this block into an embed of
 * an arbitrary origin, which is the failure mode a free-text `src` field
 * would have. An unknown id renders a placeholder, never an iframe.
 *
 * SANDBOX
 * `allow-scripts allow-same-origin` is the minimum the SPA needs to boot (an
 * opaque origin makes localStorage throw, and the app components use it).
 * Everything else is withheld on purpose: no allow-forms, no allow-popups,
 * no allow-modals, no allow-top-navigation, and an empty `allow` so the frame
 * gets no camera, microphone, geolocation or payment permission. The real
 * containment is that the framed page cannot reach the network at all
 * (agent-hub/src/demo/demoTransport.js).
 *
 * LOADING
 * The block starts as a poster (the authored still image, or a plain panel)
 * and creates the iframe only after a click or keypress on it. A visitor who
 * scrolls past therefore costs no /__demo__ request at all; the frame has a
 * fixed aspect ratio, so activating it shifts nothing. The CMS editor shows an
 * inert poster, so the builder never boots a second copy of the application.
 *
 * MOBILE (≤768px — the same boundary this block's stylesheet rules flip at)
 * The Studio components are desktop layouts and a tap on a scaled-down 14px
 * button is a lottery, so a phone never gets an iframe: the poster is a link —
 * same tab, so leaving and returning is ordinary browser history — to
 * /__demo__/<feature>?vw=1280, where DemoHost widens the viewport meta and the
 * phone renders the desktop layout natively, pinch-zoomable, with a floating
 * close button that comes back here. Both links live out here on purpose: the
 * sandbox has no allow-top-navigation, so nothing inside the frame could
 * navigate this page anywhere.
 */

// Past the app's 1279 isCompact boundary, so lg: styles apply and the demo
// lays out exactly as it would on a laptop.
const DEMO_LOGICAL_WIDTH = 1280;
// Must match the block's rules in marketing.css exactly — at 768 wide, JS
// and CSS have to agree on which branch owns the frame. (hooks/useViewport
// flips at 767, which is why it is not used here.)
const PHONE_QUERY = '(max-width: 768px)';

export default function FeatureDemo({ data }: { data?: FeatureDemoData }) {
    const feature = typeof data?.feature === 'string' ? data.feature : '';
    const known = DEMO_FEATURE_IDS.includes(feature);
    const editing = isPreviewMode();
    const isPhone = useIsPhone();
    const [activated, setActivated] = useState(false);

    if (!data?.enabled) return null;

    const height = Number.isFinite(data.height)
        ? Math.min(Math.max(data.height as number, 320), 1200)
        : 720;
    const theme = data.theme === 'dark' ? 'dark' : 'light';

    // The "open the real thing" link lives out here rather than inside the
    // frame, where a banner ate vertical space from the product itself.
    // resolveLinksInTree has already turned the stored Link union into
    // { href } by the time the public site renders; the editor preview still
    // sees the raw shape.
    const ctaLabel = data.cta?.label || '';
    const ctaHref = data.cta?.href || data.cta?.link?.href || data.cta?.link?.path || '/app';

    // The demo is a separate document: tell it which language the page around
    // it is in, so a Dutch page does not frame an English product.
    const frameSrc = `/__demo__/${encodeURIComponent(feature)}?theme=${theme}&lang=${pageLocale()}`;
    const demoUrl = `${frameSrc}&vw=${DEMO_LOGICAL_WIDTH}`;
    const posterImage = typeof data.poster === 'string' ? data.poster.trim() : '';
    const showsFullScreenLink = isPhone && known && !editing;
    const frameStyle = { aspectRatio: `${DEMO_LOGICAL_WIDTH} / ${height}` };
    const title = data.title || `${feature} demo`;

    return (
        <SectionFrame id="feature-demo" name="Live feature demo" enabled={data.enabled}>
            <section id="feature-demo" className={sectionBgClass(data)}>
                <div className="container">
                    <SectionHeader
                        pathPrefix="feature-demo"
                        eyebrow={data.eyebrow} title={data.title} lead={data.lead}
                        eyebrowStyle={data.eyebrowStyle} titleStyle={data.titleStyle} leadStyle={data.leadStyle}
                        eyebrowAlign={data.eyebrowAlign} titleAlign={data.titleAlign} leadAlign={data.leadAlign} align={data.align}
                    />

                    {data.caption ? <p className="feature-demo-caption">{data.caption}</p> : null}

                    <div className="feature-demo-frame reveal" style={frameStyle}>
                        {!known ? (
                            <div className="feature-demo-placeholder">
                                <p>
                                    {feature
                                        ? `No demo is registered for “${feature}”.`
                                        : 'Pick a feature in the panel to embed its live demo.'}
                                </p>
                                <p className="feature-demo-hint">Available: {DEMO_FEATURE_IDS.join(', ')}</p>
                            </div>
                        ) : editing ? (
                            <FeatureDemoPoster mode="inert" image={posterImage} label="Live demo — runs on the published site" />
                        ) : isPhone ? (
                            <FeatureDemoPoster mode="link" image={posterImage} label="Open full screen" href={demoUrl} />
                        ) : activated ? (
                            <iframe
                                src={frameSrc}
                                title={title}
                                className="feature-demo-iframe"
                                loading="lazy"
                                sandbox="allow-scripts allow-same-origin"
                                allow=""
                                referrerPolicy="no-referrer"
                            />
                        ) : (
                            <FeatureDemoPoster mode="button" image={posterImage} label="Try it" onActivate={() => setActivated(true)} />
                        )}
                    </div>

                    <div className="feature-demo-footer">
                        {showsFullScreenLink ? (
                            <a className="btn btn-secondary feature-demo-open-btn" href={demoUrl}>
                                <Maximize2 aria-hidden="true" size={16} />
                                Open full screen
                            </a>
                        ) : null}
                        {data.note ? <p className="feature-demo-note">{data.note}</p> : null}
                        {ctaLabel ? (
                            <a className="btn btn-primary feature-demo-cta" href={ctaHref}>
                                {ctaLabel}
                            </a>
                        ) : null}
                    </div>
                </div>
            </section>
        </SectionFrame>
    );
}

// The language of the page the block sits on, by the rule the cookie banner
// follows (resolveCookieLang): the path prefix (/nl/...) first, then ?locale=.
// Anything else is English. Only members of LOCALE_PREFIXES come out.
function pageLocale(): string {
    if (typeof window === 'undefined') return 'en';
    const seg = (window.location.pathname.split('/')[1] || '').toLowerCase();
    if (LOCALE_PREFIXES.has(seg)) return seg;
    const param = (new URLSearchParams(window.location.search).get('locale') || '').toLowerCase().split('-')[0];
    return LOCALE_PREFIXES.has(param) ? param : 'en';
}

function isPreviewMode() {
    if (typeof window === 'undefined') return false;
    return new URLSearchParams(window.location.search).has('preview');
}

// Local rather than hooks/useViewport: that hook's boundary is 767px while
// this block's stylesheet rules flip at 768 — at exactly 768 wide, JS and
// CSS would disagree about which branch owns the frame. The change listener
// covers portrait/landscape rotation across the boundary.
function useIsPhone() {
    const [isPhone, setIsPhone] = useState(() => (
        typeof window !== 'undefined' && typeof window.matchMedia === 'function'
            ? window.matchMedia(PHONE_QUERY).matches
            : false
    ));
    useEffect(() => {
        if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
        const mql = window.matchMedia(PHONE_QUERY);
        const update = () => setIsPhone(mql.matches);
        update();
        mql.addEventListener('change', update);
        return () => mql.removeEventListener('change', update);
    }, []);
    return isPhone;
}
