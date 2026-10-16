import AppIcon from '../../components/icons/AppIcon';
import { resolveAssetUrl } from '../assetUrl';

// An icon field holds a Lucide name or an uploaded asset of this site. The
// asset test mirrors the server's safeIconAsset (stores/cms/localeMedia.js):
// only "cms/<file>" or "/api/cms/asset/<file>", no whitespace, quotes, angle
// brackets, backslashes or ".." segments. Anything else is not an image.
const ASSET_RE = /^(?:cms\/|\/api\/cms\/asset\/)[A-Za-z0-9._~%/-]+$/;
const LUCIDE_NAME = /^[A-Z][A-Za-z0-9]*$/;

/** The image address of an uploaded-asset icon, or null when `icon` is not one. */
export function iconAssetSrc(icon: string | null | undefined): string | null {
    if (typeof icon !== 'string') return null;
    const value = icon.trim();
    if (!ASSET_RE.test(value) || value.split('/').includes('..')) return null;
    return resolveAssetUrl(value);
}

interface IconGlyphProps {
    icon?: string | null;
    className?: string;
    /** Show a value that is neither an asset nor a Lucide name as text (legacy emoji in the menu). */
    legacyText?: boolean;
}

/**
 * The glyph inside an icon tile or beside a menu item: an uploaded SVG/PNG,
 * a Lucide icon, or (menu only) legacy text. Always decorative.
 */
export default function IconGlyph({ icon, className = '', legacyText = false }: IconGlyphProps) {
    if (!icon) return null;
    const src = iconAssetSrc(icon);
    if (src) {
        return <img className={`icon-glyph-img ${className}`.trim()} src={src} alt="" loading="lazy" decoding="async" />;
    }
    if (icon.startsWith('/') || icon.startsWith('cms/')) return null;
    if (!legacyText || LUCIDE_NAME.test(icon)) {
        return <AppIcon name={icon} className={className} aria-hidden="true" />;
    }
    return <>{icon}</>;
}
