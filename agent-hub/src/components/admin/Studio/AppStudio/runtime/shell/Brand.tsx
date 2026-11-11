import AppIcon from '@/components/icons/AppIcon';
import AssetImage from '../assets/AssetImage';
import { isImageValue } from '../assets/assetUrl';
import { shellOptions } from './shellOptions';
import type { AppDefinition } from '../../inspector/appDefinition';

/**
 * Brand — the app's identity lockup, shared by both shell layouts (tabs top
 * bar, sidebar head, mobile bar). Icon tile + name by default; when the
 * design layer carries a logoUrl the image replaces the icon tile (the name
 * stays, truncated, so an icon-only logo still reads). The logo is an https URL
 * or an uploaded file of the app (`asset:<id>`). nav.brand (schema 3) names its own
 * name and logo, and `showName: false` shows a logo without the name.
 */
type BrandDefinition = (Pick<AppDefinition, 'meta' | 'design'> & { nav?: unknown }) | null | undefined;

/** What the lockup shows. nav.brand (schema 3, shellOptions.ts): its own name and logo win; showName false leaves the logo alone. */
function brandView(definition: BrandDefinition) {
    const brand = shellOptions(definition).brand;
    const raw = brand?.logo ?? definition?.design?.logoUrl;
    const logoUrl = isImageValue(raw) ? raw : null;
    return { logoUrl, name: brand?.name || definition?.meta?.name || 'App', showName: brand?.showName !== false || !logoUrl };
}

export default function Brand({ definition }: { definition?: BrandDefinition }) {
    const meta = definition?.meta || {};
    const { logoUrl, name, showName } = brandView(definition);
    return (
        <div className="flex items-center gap-2 py-2.5 min-w-0" data-app-brand="true">
            {logoUrl ? (
                <AssetImage value={logoUrl} alt={name} className="h-6 max-w-[120px] object-contain" />
            ) : (
                <span
                    className="inline-flex h-7 w-7 items-center justify-center rounded-md shrink-0 [background:var(--app-primary-soft)] [color:var(--app-primary)]"
                >
                    <AppIcon name={meta.icon || 'LayoutGrid'} className="w-4 h-4" />
                </span>
            )}
            {showName ? <span className="font-semibold text-sm truncate">{name}</span> : null}
        </div>
    );
}
