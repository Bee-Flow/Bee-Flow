import { FieldRow } from '../fields';
import { SegmentedControl } from '../primitives';
import { useTranslation } from '../../../../hooks/useTranslation';

/** Letter-spacing of the hero display headline: an enum, never a free value. */
export default function DisplayTrackingControl({ value, onChange }: { value?: string; onChange: (value: string) => void }) {
    const { t } = useTranslation();
    return (
        <FieldRow label={t('cms_site.site.design.display_tracking', 'Display letter-spacing')} hint={t('cms_site.site.design.display_tracking_hint', 'Tighter spacing gives the hero headline its modern, compact look. Pairs well with heavy weights.')}>
            <SegmentedControl
                value={value || 'default'}
                onChange={onChange}
                options={[
                    { value: 'default', label: t('cms_site.site.design.display_tracking_default', 'Default') },
                    { value: 'tight', label: t('cms_site.site.design.display_tracking_tight', 'Tight') },
                    { value: 'tighter', label: t('cms_site.site.design.display_tracking_tighter', 'Tighter') },
                    { value: 'tightest', label: t('cms_site.site.design.display_tracking_tightest', 'Tightest') },
                ]}
            />
        </FieldRow>
    );
}
