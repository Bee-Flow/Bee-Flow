import React from 'react';
import { TextField, Toggle, ImageField, RepeatableList, FieldRow } from '../fields';
import { InlineHint, BackgroundCard } from '../primitives';
import type { BlockEditorWithPagesProps } from './editorProps';
import { set, SectionHeaderFields, CtaButtonField } from './shared';
import type { SectionHeaderData, CtaButtonValue } from './shared';
import { useTranslation } from '@/hooks/useTranslation';
import { TABS_MIN, TABS_MAX } from './blockData.generated.mjs';

// ── Tabs ──────────────────────────────────────────────────────────────
//
// 2-6 tabs, each with a heading, text, an optional picture and an optional
// button. `tabId` is the key of the `?tab=` deep link; it is structural, so
// translations never touch it.

type TabMedia = { src?: string; srcDark?: string; alt?: string; frame?: string; kind?: string };
type Tab = {
    tabId?: string;
    label?: string;
    title?: string;
    body?: string;
    media?: TabMedia;
    /** `null` while the button is switched off. */
    cta?: CtaButtonValue | null;
};
type TabsData = SectionHeaderData & { items?: Tab[] };

/** Lowercase letters, digits and dashes: what a URL parameter can carry unescaped. */
export function cleanTabId(raw: string): string {
    return raw.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+/, '').slice(0, 40);
}

/** The first `tab-N` that no tab of the block uses yet. */
export function nextTabId(items: readonly Tab[]): string {
    const used = new Set(items.map((i) => i.tabId));
    let n = items.length + 1;
    while (used.has(`tab-${n}`)) n += 1;
    return `tab-${n}`;
}

export function TabsEditor({ data = {}, pages = [], onChange }: BlockEditorWithPagesProps<TabsData>) {
    const { t } = useTranslation();
    const items = data.items || [];
    return (
        <>
            <InlineHint>{t('cms_site.blocks.tabs.tabs_hint', 'One section for several audiences. Click a tab label, heading or text in the preview to edit it inline; use the list below for pictures, buttons and the link id.')}</InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="tabs" />
            {items.length < TABS_MIN ? (
                <InlineHint>{t('cms_site.blocks.tabs.min_tabs', 'Add at least two tabs: with one there is nothing to switch between.')}</InlineHint>
            ) : null}
            <RepeatableList
                label={t('cms_site.blocks.tabs.tabs', 'Tabs')}
                items={items}
                maxItems={TABS_MAX}
                onChange={v => onChange(set(data, 'items', v))}
                makeNew={() => ({
                    tabId: nextTabId(items), label: 'New tab', title: '', body: '',
                    media: { src: '', srcDark: '', alt: '', frame: 'hairline', kind: 'image' }, cta: null,
                })}
                itemLabel={(item) => item.label || t('cms_site.blocks.tabs.no_label', '(no label)')}
                renderItem={(item, update) => (
                    <>
                        <TextField
                            label={t('cms_site.blocks.tabs.label', 'Tab label')}
                            value={item.label || ''}
                            onChange={v => update({ ...item, label: v })}
                            placeholder={t('cms_site.blocks.tabs.label_placeholder', 'e.g. IT')}
                        />
                        <TextField
                            label={t('cms_site.blocks.tabs.title', 'Heading')}
                            value={item.title || ''}
                            onChange={v => update({ ...item, title: v })}
                        />
                        <TextField
                            label={t('cms_site.blocks.tabs.body', 'Text')}
                            value={item.body || ''}
                            onChange={v => update({ ...item, body: v })}
                            placeholder={t('cms_site.blocks.tabs.body_placeholder', 'Describe how this team uses the product.')}
                        />
                        <FieldRow label={t('cms_site.blocks.tabs.picture', 'Picture')}>
                            <ImageField
                                value={item.media?.src || ''}
                                onChange={v => update({ ...item, media: { ...(item.media || {}), src: v, frame: item.media?.frame || 'hairline', kind: 'image' } })}
                            />
                        </FieldRow>
                        <TextField
                            label={t('cms_site.blocks.tabs.picture_alt', 'Picture description (alt text)')}
                            value={item.media?.alt || ''}
                            onChange={v => update({ ...item, media: { ...(item.media || {}), alt: v } })}
                        />
                        <Toggle
                            label={t('cms_site.blocks.tabs.show_button', 'Show a button')}
                            value={!!item.cta}
                            onChange={v => update({ ...item, cta: v ? { label: 'Learn more', link: { kind: 'anchor', anchor: '' } } : null })}
                        />
                        {item.cta ? (
                            <CtaButtonField
                                value={item.cta}
                                pages={pages}
                                onChange={v => update({ ...item, cta: v })}
                                label={t('cms_site.blocks.tabs.button', 'Button')}
                            />
                        ) : null}
                        <TextField
                            label={t('cms_site.blocks.tabs.tab_id', 'Link id')}
                            value={item.tabId || ''}
                            onChange={v => update({ ...item, tabId: cleanTabId(v) })}
                            placeholder={t('cms_site.blocks.tabs.tab_id_placeholder', 'it')}
                        />
                        <InlineHint>{t('cms_site.blocks.tabs.tab_id_hint', 'Link to this tab with ?tab=<link id> on the page address. Keep it short and do not change it once shared.')}</InlineHint>
                    </>
                )}
                addLabel={t('cms_site.blocks.tabs.add_tab', 'Add tab')}
            />
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.tabs.background" />
        </>
    );
}
