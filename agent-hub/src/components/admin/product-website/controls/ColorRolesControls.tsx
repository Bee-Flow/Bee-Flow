import { FieldRow } from '../fields';
import { ColorRow, SectionDivider, SegmentedControl } from '../primitives';
import { useTranslation } from '../../../../hooks/useTranslation';
import type { DesignColors, DesignComponents } from '../../../../marketing/ProductWebsite.types';

type RoleKey = 'cta' | 'link' | 'highlight' | 'tile';

/**
 * Colour roles: where the brand colour is used. An empty role follows the
 * Primary colour, so using it sparingly means setting only the roles that
 * should differ (for example a navy tile and a honey button).
 */
export default function ColorRolesControls({ colors, components, onColor, onComponent }: {
    colors: DesignColors;
    components: DesignComponents;
    onColor: (key: RoleKey, value: string) => void;
    onComponent: (key: 'labelStyle', value: string) => void;
}) {
    const { t } = useTranslation();
    const follow = t('cms_site.site.design.role_follow', 'Leave empty to follow the Primary color.');
    return (
        <>
            <SectionDivider label={t('cms_site.site.design.roles_title', 'Color roles')} />
            <p className="text-[11px] text-[var(--text-muted)] mb-2">
                {t('cms_site.site.design.roles_help', 'Use the brand color sparingly: give each role its own color, or leave it empty to follow Primary.')}
            </p>
            <ColorRow label={t('cms_site.site.design.role_cta', 'Buttons')} value={colors.cta || ''} onChange={v => onColor('cta', v)} hint={t('cms_site.site.design.role_cta_hint', 'Primary buttons and the keyboard focus ring. {follow}', { follow })} />
            <ColorRow label={t('cms_site.site.design.role_link', 'Links')} value={colors.link || ''} onChange={v => onColor('link', v)} hint={t('cms_site.site.design.role_link_hint', 'Text links. {follow}', { follow })} />
            <ColorRow label={t('cms_site.site.design.role_highlight', 'Highlights')} value={colors.highlight || ''} onChange={v => onColor('highlight', v)} hint={t('cms_site.site.design.role_highlight_hint', 'Eyebrows, labels and card hover borders. {follow}', { follow })} />
            <ColorRow label={t('cms_site.site.design.role_tile', 'Icon tiles')} value={colors.tile || ''} onChange={v => onColor('tile', v)} hint={t('cms_site.site.design.role_tile_hint', 'Tile fill and icon color. {follow}', { follow })} />
            <FieldRow label={t('cms_site.site.design.label_style', 'Label style')} hint={t('cms_site.site.design.label_style_hint', 'Eyebrows and chip labels: mono capitals, or plain text in the body font. A Look setting on a block overrides it.')}>
                <SegmentedControl
                    value={components.labelStyle === 'plain' ? 'plain' : 'mono'}
                    onChange={v => onComponent('labelStyle', v)}
                    options={[
                        { value: 'mono', label: t('cms_site.site.design.label_style_mono', 'Mono caps') },
                        { value: 'plain', label: t('cms_site.site.design.label_style_plain', 'Plain') },
                    ]}
                />
            </FieldRow>
        </>
    );
}
