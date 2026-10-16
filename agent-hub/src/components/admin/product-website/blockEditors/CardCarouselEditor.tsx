import { LinkField, RepeatableList, TextArea, TextField, Toggle } from '../fields';
import type { CmsLink } from '../fields';
import { BackgroundCard, FieldSelect, InlineHint } from '../primitives';
import type { BlockEditorWithPagesProps } from './editorProps';
import { set, SectionHeaderFields } from './shared';
import type { SectionHeaderData } from './shared';
import { useTranslation } from '../../../../hooks/useTranslation';

// ── Card carousel ─────────────────────────────────────────────────────
//
// Large gradient cards in a horizontal snap-scrolling row (arrows and arrow
// keys included). The gradients are made from the theme colours.

type CarouselCard = { title?: string; body?: string; numeral?: string; gradient?: string; linkLabel?: string; link?: CmsLink | null };
type CardCarouselData = SectionHeaderData & {
    animated?: boolean;
    showNumerals?: boolean;
    prevLabel?: string;
    nextLabel?: string;
    cards?: CarouselCard[];
};

export function CardCarouselEditor({ data = {}, pages = [], onChange }: BlockEditorWithPagesProps<CardCarouselData>) {
    const { t } = useTranslation();
    return (
        <>
            <InlineHint>{t('cms_site.blocks.card_carousel.hint', 'Large cards with soft gradients in a row that scrolls sideways and snaps card by card.')}</InlineHint>
            <SectionHeaderFields data={data} onChange={onChange} persistScope="card-carousel" />
            <Toggle
                label={t('cms_site.blocks.card_carousel.animated', 'Animate the gradients')}
                value={data.animated !== false}
                onChange={(v: boolean) => onChange(set(data, 'animated', v))}
            />
            <Toggle
                label={t('cms_site.blocks.card_carousel.numerals', 'Show the big numbers')}
                value={data.showNumerals !== false}
                onChange={(v: boolean) => onChange(set(data, 'showNumerals', v))}
            />
            <TextField
                label={t('cms_site.blocks.card_carousel.prev_label', 'Previous button (screen readers)')}
                value={data.prevLabel || ''}
                onChange={(v: string) => onChange(set(data, 'prevLabel', v))}
            />
            <TextField
                label={t('cms_site.blocks.card_carousel.next_label', 'Next button (screen readers)')}
                value={data.nextLabel || ''}
                onChange={(v: string) => onChange(set(data, 'nextLabel', v))}
            />
            <RepeatableList
                label={t('cms_site.blocks.card_carousel.cards', 'Cards')}
                items={data.cards || []}
                onChange={(v: CarouselCard[]) => onChange(set(data, 'cards', v))}
                makeNew={(): CarouselCard => ({ title: 'New card', body: '', gradient: 'primary', numeral: '', linkLabel: '' })}
                itemLabel={(c: CarouselCard) => c.title || t('cms_site.blocks.card_carousel.no_title', '(no title)')}
                collapsible
                renderItem={(item: CarouselCard, update: (next: CarouselCard) => void) => (
                    <>
                        <TextField
                            label={t('cms_site.blocks.card_carousel.card_title', 'Title')}
                            value={item.title || ''}
                            onChange={(v: string) => update({ ...item, title: v })}
                        />
                        <TextArea
                            label={t('cms_site.blocks.card_carousel.card_body', 'Text')}
                            value={item.body || ''}
                            onChange={(v: string) => update({ ...item, body: v })}
                            rows={3}
                        />
                        <FieldSelect
                            label={t('cms_site.blocks.card_carousel.gradient', 'Gradient')}
                            value={item.gradient || 'primary'}
                            options={[
                                { value: 'primary', label: t('cms_site.blocks.card_carousel.gradient_primary', 'Primary to accent') },
                                { value: 'accent', label: t('cms_site.blocks.card_carousel.gradient_accent', 'Accent to primary') },
                                { value: 'mix', label: t('cms_site.blocks.card_carousel.gradient_mix', 'Soft glow (both colours on dark)') },
                                { value: 'dark', label: t('cms_site.blocks.card_carousel.gradient_dark', 'Dark with a primary edge') },
                            ]}
                            onChange={(v: string) => update({ ...item, gradient: v })}
                        />
                        <TextField
                            label={t('cms_site.blocks.card_carousel.numeral', 'Big number (empty = card number)')}
                            value={item.numeral || ''}
                            onChange={(v: string) => update({ ...item, numeral: v })}
                        />
                        <TextField
                            label={t('cms_site.blocks.card_carousel.link_label', 'Link text (optional)')}
                            value={item.linkLabel || ''}
                            onChange={(v: string) => update({ ...item, linkLabel: v })}
                        />
                        {item.linkLabel ? (
                            <LinkField
                                label={t('cms_site.blocks.card_carousel.link', 'Link')}
                                value={item.link}
                                pages={pages}
                                onChange={(v: CmsLink | null) => update({ ...item, link: v })}
                            />
                        ) : null}
                    </>
                )}
                addLabel={t('cms_site.blocks.card_carousel.add_card', 'Add card')}
            />
            <BackgroundCard data={data} onChange={onChange} persistKey="blk.card-carousel.background" />
        </>
    );
}
