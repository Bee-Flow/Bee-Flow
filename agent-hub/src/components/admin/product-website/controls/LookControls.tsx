import { FieldRow } from '../fields';
import { SegmentedControl } from '../primitives';
import { useTranslation } from '@/hooks/useTranslation';

/** The look keys of block.style (a missing key = the default look). */
interface BlockLook {
    decor?: string;
    cardFill?: string;
    labelStyle?: string;
}

export interface LookControlsProps {
    value: BlockLook;
    onChange: (patch: BlockLook) => void;
}

/**
 * LookControls: three closed choices that change how a block looks without
 * any free CSS: the hero's blur blobs, the fill of the cards in the block and
 * the style of the trust-band chip labels. The identity value of each is
 * stored as the key being absent from the render (the renderer ignores it).
 */
export default function LookControls({ value, onChange }: LookControlsProps) {
    const { t } = useTranslation();
    return (
        <>
            <FieldRow label={t('cms_site.site.controls.hero_decor', 'Hero background blobs')} hint={t('cms_site.site.controls.hero_decor_hint', 'The soft blurred colour circles behind a hero. Switch them off for a clean, flat background.')}>
                <SegmentedControl
                    value={value.decor === 'none' ? 'none' : 'default'}
                    onChange={(v: string) => onChange({ decor: v })}
                    options={[
                        { value: 'default', label: t('cms_site.site.controls.decor_default', 'Show') },
                        { value: 'none', label: t('cms_site.site.controls.decor_none', 'Off') },
                    ]}
                />
            </FieldRow>
            <FieldRow label={t('cms_site.site.controls.card_fill', 'Card fill')} hint={t('cms_site.site.controls.card_fill_hint', 'White cards stand out on a tinted band.')}>
                <SegmentedControl
                    value={value.cardFill === 'white' || value.cardFill === 'none' ? value.cardFill : 'tint'}
                    onChange={(v: string) => onChange({ cardFill: v })}
                    options={[
                        { value: 'tint', label: t('cms_site.site.controls.card_fill_tint', 'Tint') },
                        { value: 'white', label: t('cms_site.site.controls.card_fill_white', 'White') },
                        { value: 'none', label: t('cms_site.site.controls.card_fill_none', 'None') },
                    ]}
                />
            </FieldRow>
            <FieldRow label={t('cms_site.site.controls.label_style', 'Trust label style')} hint={t('cms_site.site.controls.label_style_hint', 'The labels on a trust band: monospace capitals, or plain text in the body font.')}>
                <SegmentedControl
                    value={value.labelStyle === 'plain' ? 'plain' : 'mono'}
                    onChange={(v: string) => onChange({ labelStyle: v })}
                    options={[
                        { value: 'mono', label: t('cms_site.site.controls.label_style_mono', 'Capitals') },
                        { value: 'plain', label: t('cms_site.site.controls.label_style_plain', 'Plain') },
                    ]}
                />
            </FieldRow>
        </>
    );
}
