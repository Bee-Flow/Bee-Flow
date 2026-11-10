import AssetImage from './AssetImage';
import { isImageValue } from './assetUrl';

/**
 * The header of a public page: its OWN logo (publicAccess.design.logoUrl), which the server
 * names beside the served definition (GET /api/public-app/:token `page.logoUrl`). The served
 * design also carries the app's logo; that one is never drawn here, so a page that set no logo
 * of its own looks as it did. Same size as the shell brand: 24 px high, 120 px wide at most.
 */
export default function PublicPageLogo({ page, alt }: { page?: { logoUrl?: unknown } | null; alt?: string | null }) {
    const logoUrl = page?.logoUrl;
    if (!isImageValue(logoUrl)) return null;
    return (
        <div className="shrink-0 px-4 pt-3" data-app-public-logo="true">
            <AssetImage value={logoUrl} alt={alt || 'App'} className="h-6 max-w-[120px] object-contain" />
        </div>
    );
}
