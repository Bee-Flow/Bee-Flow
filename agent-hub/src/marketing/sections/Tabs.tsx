import React, { useEffect, useId, useRef, useState } from 'react';
import Button from '../components/Button';
import EditableText from '../components/EditableText';
import FramedMedia from '../components/FramedMedia';
import { columnSizes } from '../assetUrl';
import SectionFrame from '../components/SectionFrame';
import SectionHeader from '../components/SectionHeader';
import { sectionBgClass } from './sectionBg';
import { TAB_PARAM, indexForTabParam, nextTabIndex, tabKey } from './tabsKeys';
import type { MediaSlot, SectionDataBase } from './sectionData.types';
import './tabs.css';

interface TabCta {
    label?: string;
    href?: string;
    style?: string;
    link?: { href?: string };
}

interface TabItem {
    tabId?: string;
    label?: string;
    title?: string;
    body?: string;
    media?: MediaSlot;
    cta?: TabCta | null;
}

interface TabsData extends SectionDataBase {
    items?: TabItem[];
}

// True when the event comes from an inline-editable text node: clicking to
// edit a tab label in the CMS preview must not be swallowed by the tab switch.
function onEditable(e: React.SyntheticEvent) {
    const target = e.target as Element;
    return !!(target.closest && target.closest('.cms-editable'));
}

const hasText = (v: unknown) => typeof v === 'string' && v.trim() !== '';

/**
 * Tabs / switcher section ("for IT / Legal / DPO"). A WAI-ARIA tablist:
 * roving tabindex, arrow keys / Home / End, `?tab=<tabId>` deep link.
 *
 * EVERY panel is mounted and only hidden with the `hidden` attribute, so the
 * text of all tabs stays in the DOM (search, translation, inline editing) just
 * as it is in the server-rendered HTML (core/seo/renderBlocks.js emits every
 * tab). EditableText paths:
 *   tabs.items.{i}.label / .title / .body / .cta.label
 */
export default function Tabs({ data }: { data?: TabsData }) {
    const baseId = useId();
    const [active, setActive] = useState(0);
    const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
    const items = data?.items;

    // Deep link: applied after mount so the first client render matches the
    // server markup. Another block on the page with the same id is harmless:
    // an id this block does not have selects nothing.
    useEffect(() => {
        if (!items?.length) return;
        const idx = indexForTabParam(items, new URLSearchParams(window.location.search).get(TAB_PARAM));
        if (idx >= 0) setActive(idx);
    }, [items]);

    if (!data?.enabled) return null;
    const list = items || [];
    if (list.length === 0) return null;
    const current = Math.min(active, list.length - 1);

    const select = (i: number, focus = false) => {
        setActive(i);
        // Keep the address bar shareable; replaceState leaves every other
        // parameter (notably ?preview in the editor) untouched.
        const url = new URL(window.location.href);
        url.searchParams.set(TAB_PARAM, tabKey(list[i], i));
        window.history.replaceState(window.history.state, '', url);
        if (focus) tabRefs.current[i]?.focus();
    };

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (onEditable(e)) return;
        const next = nextTabIndex(e.key, current, list.length);
        if (next === null) return;
        e.preventDefault();
        select(next, true);
    };

    return (
        <SectionFrame id="tabs" name="Tabs" enabled={data.enabled}>
            <section id="tabs" className={`tabs-block ${sectionBgClass(data)}`.trim()}>
                <div className="container">
                    <SectionHeader
                        pathPrefix="tabs"
                        eyebrow={data.eyebrow} title={data.title} lead={data.lead}
                        eyebrowStyle={data.eyebrowStyle} titleStyle={data.titleStyle} leadStyle={data.leadStyle}
                        eyebrowAlign={data.eyebrowAlign} titleAlign={data.titleAlign} leadAlign={data.leadAlign} align={data.align}
                    />
                    <div className="tabs-list reveal" role="tablist" onKeyDown={onKeyDown}>
                        {list.map((item, i) => (
                            <button
                                key={i}
                                type="button"
                                role="tab"
                                id={`${baseId}-tab-${i}`}
                                aria-selected={i === current}
                                aria-controls={`${baseId}-panel-${i}`}
                                tabIndex={i === current ? 0 : -1}
                                ref={(el) => { tabRefs.current[i] = el; }}
                                className={`tabs-tab${i === current ? ' tabs-tab--active' : ''}`}
                                onClick={(e) => { if (!onEditable(e)) select(i); }}
                            >
                                <EditableText path={`tabs.items.${i}.label`} placeholder="Tab label">
                                    {item.label || ''}
                                </EditableText>
                            </button>
                        ))}
                    </div>
                    {list.map((item, i) => (
                        <TabPanel key={i} item={item} index={i} baseId={baseId} selected={i === current} />
                    ))}
                </div>
            </section>
        </SectionFrame>
    );
}

/** One tab's content. Always mounted; `hidden` while another tab is selected. */
function TabPanel({ item, index: i, baseId, selected }: { item: TabItem; index: number; baseId: string; selected: boolean }) {
    const hasMedia = hasText(item.media?.src);
    const cta = item.cta;
    const ctaHref = cta?.href || cta?.link?.href || '#';
    return (
        <div
            role="tabpanel"
            id={`${baseId}-panel-${i}`}
            aria-labelledby={`${baseId}-tab-${i}`}
            hidden={!selected}
            // A panel without a focusable child stays reachable by keyboard (WAI-ARIA tabs).
            tabIndex={cta ? undefined : 0}
            className={`tabs-panel${hasMedia ? '' : ' tabs-panel--text'}`}
        >
            <div className="tabs-panel-copy">
                <EditableText as="h3" path={`tabs.items.${i}.title`} multiline placeholder="Heading" className="headline-md">
                    {item.title || ''}
                </EditableText>
                <EditableText as="p" path={`tabs.items.${i}.body`} multiline placeholder="Text" className="body-md">
                    {item.body || ''}
                </EditableText>
                {cta ? (
                    <div className="tabs-panel-cta">
                        <Button variant={cta.style || 'primary'} href={ctaHref}>
                            <EditableText path={`tabs.items.${i}.cta.label`} placeholder="Button label">
                                {cta.label || ''}
                            </EditableText>
                        </Button>
                    </div>
                ) : null}
            </div>
            {hasMedia ? (
                <div className="tabs-panel-media">
                    <FramedMedia media={item.media} glow={false} sizes={columnSizes(2)} />
                </div>
            ) : null}
        </div>
    );
}
