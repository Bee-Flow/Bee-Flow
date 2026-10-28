import { FieldRow } from '../fields';
import { SectionDivider, SegmentedControl } from '../primitives';
import { useTranslation } from '@/hooks/useTranslation';
import type { DesignComponents } from '@/marketing/ProductWebsite.types';

type TileKey = 'tileShape' | 'tileFill' | 'tileSize' | 'tileIconColor';

/**
 * Icon tiles of the feature, security and integration blocks: shape, fill,
 * size and glyph colour. Every setting is an enum; 'Default' keeps today's look.
 */
export default function IconTileControls({ components, onChange }: {
    components: DesignComponents;
    onChange: (key: TileKey, value: string) => void;
}) {
    const { t } = useTranslation();
    const def = t('cms_site.site.design.tile_default', 'Default');
    return (
        <>
            <SectionDivider label={t('cms_site.site.design.tiles_title', 'Icon tiles')} />
            <FieldRow label={t('cms_site.site.design.tile_shape', 'Shape')} hint={t('cms_site.site.design.tile_shape_hint', 'A hexagon drops the tile ring; the other shapes keep it.')}>
                <SegmentedControl
                    value={components.tileShape || 'default'}
                    onChange={v => onChange('tileShape', v)}
                    options={[
                        { value: 'default', label: def },
                        { value: 'square', label: t('cms_site.site.design.tile_shape_square', 'Square') },
                        { value: 'rounded', label: t('cms_site.site.design.tile_shape_rounded', 'Rounded') },
                        { value: 'circle', label: t('cms_site.site.design.tile_shape_circle', 'Circle') },
                        { value: 'hexagon', label: t('cms_site.site.design.tile_shape_hexagon', 'Hexagon') },
                    ]}
                />
            </FieldRow>
            <FieldRow label={t('cms_site.site.design.tile_fill', 'Fill')}>
                <SegmentedControl
                    value={components.tileFill || 'default'}
                    onChange={v => onChange('tileFill', v)}
                    options={[
                        { value: 'default', label: def },
                        { value: 'tint', label: t('cms_site.site.design.tile_fill_tint', 'Tint') },
                        { value: 'solid', label: t('cms_site.site.design.tile_fill_solid', 'Solid') },
                        { value: 'none', label: t('cms_site.site.design.tile_fill_none', 'None') },
                    ]}
                />
            </FieldRow>
            <FieldRow label={t('cms_site.site.design.tile_size', 'Size')}>
                <SegmentedControl
                    value={components.tileSize || 'default'}
                    onChange={v => onChange('tileSize', v)}
                    options={[
                        { value: 'sm', label: t('cms_site.site.design.tile_size_sm', 'Small') },
                        { value: 'default', label: def },
                        { value: 'lg', label: t('cms_site.site.design.tile_size_lg', 'Large') },
                    ]}
                />
            </FieldRow>
            <FieldRow label={t('cms_site.site.design.tile_icon_color', 'Icon color')} hint={t('cms_site.site.design.tile_icon_color_hint', 'A solid fill picks white or black by itself unless you choose one.')}>
                <SegmentedControl
                    value={components.tileIconColor || 'default'}
                    onChange={v => onChange('tileIconColor', v)}
                    options={[
                        { value: 'default', label: def },
                        { value: 'light', label: t('cms_site.site.design.tile_icon_light', 'White') },
                        { value: 'dark', label: t('cms_site.site.design.tile_icon_dark', 'Black') },
                    ]}
                />
            </FieldRow>
        </>
    );
}
