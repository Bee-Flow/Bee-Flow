import { FieldRow } from '../fields';
import { SegmentedControl } from '../primitives';
import { useTranslation } from '../../../../hooks/useTranslation';

/** What blocks with a dark band are filled with: an enum, never a free colour. */
export default function DarkBandControl({ value, onChange }: { value?: string; onChange: (value: string) => void }) {
    const { t } = useTranslation();
    return (
        <FieldRow label={t('cms_site.site.design.dark_band', 'Dark band colour')} hint={t('cms_site.site.design.dark_band_hint', 'What blocks with a dark band are filled with.')}>
            <SegmentedControl
                value={value === 'secondary' ? 'secondary' : 'palette'}
                onChange={onChange}
                options={[
                    { value: 'palette', label: t('cms_site.site.design.dark_band_palette', 'Dark palette') },
                    { value: 'secondary', label: t('cms_site.site.design.dark_band_secondary', 'Secondary colour') },
                ]}
            />
        </FieldRow>
    );
}
