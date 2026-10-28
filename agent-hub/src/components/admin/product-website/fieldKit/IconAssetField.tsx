import { IconField } from './basicFields';
import { ImageField } from './ImageField';
import { useTranslation } from '@/hooks/useTranslation';

// Mirrors the renderer's IconGlyph rule (marketing/components/IconGlyph.tsx):
// an uploaded asset of this site, never another origin.
function isAssetIcon(value: string | null | undefined): value is string {
    return typeof value === 'string' && (value.startsWith('cms/') || value.startsWith('/api/cms/asset/'));
}

interface IconAssetFieldProps {
    label?: string;
    value: string | null | undefined;
    onChange: (value: string) => void;
}

/**
 * An icon that is either a Lucide name (IconField) or an uploaded SVG/PNG
 * (ImageField). The stored value is one string; picking one source replaces
 * the other.
 */
export function IconAssetField({ label, value, onChange }: IconAssetFieldProps) {
    const { t } = useTranslation();
    const asset = isAssetIcon(value);
    return (
        <>
            <IconField label={label} value={asset ? '' : value} onChange={onChange} />
            <ImageField
                label={t('cms_site.site.fields.icon_upload_label', 'Or use an uploaded icon')}
                value={asset ? value : ''}
                onChange={onChange}
                accept="image/svg+xml,image/png"
                uploadLabel={t('cms_site.site.fields.icon_upload', 'Upload SVG or PNG')}
                placeholder={t('cms_site.site.fields.icon_upload_placeholder', '/api/cms/asset/cms/…')}
            />
        </>
    );
}
