import { ImageOff } from 'lucide-react';
import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import AssetImage from '../assets/AssetImage';
import { isImageValue } from '../assets/assetUrl';
import { resolveBinding } from '../resolveBinding';
import { useRuntime } from '../RuntimeContext';
import type { BindingInput } from '../resolveBinding.types';
import type { NodeProps } from './appNode.types';

/**
 * App Studio runtime — 'image'. Spec: server/appStudio/componentSpecs.js.
 *
 * The source is an https URL or an uploaded file of the app (`asset:<id>`, assets/assetUrl.ts).
 * `srcFrom` (a binding, since 3) wins when it resolves to either; `src` stays the fallback.
 */
export default function AppImage({ node }: NodeProps<{ src?: string | null; alt?: string; fit?: string; srcFrom?: BindingInput }>) {
    const { t } = useTranslation();
    const { actionState, dataState, scope } = useRuntime();
    const { src = null, alt = '', fit = 'cover', srcFrom } = node.props || {};
    const { value: bound } = resolveBinding(srcFrom, { actionState, dataState, scope });
    const shown = isImageValue(bound) ? bound : src;
    // Remembered per source, so a bound image that moves on to a working source draws it.
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    const hasHeight = node.style?.height && node.style.height !== 'auto';

    // Broken/missing sources render a neutral placeholder with the same
    // footprint as the image would have — no layout shift.
    const placeholder = (
        <div
            role="img"
            aria-label={alt || t('studio_apps_runtime.image.unavailable', 'Image unavailable')}
            className="flex items-center justify-center w-full bfa-image__root bfa-image__placeholder"
            style={{
                height: hasHeight ? '100%' : undefined,
                minHeight: '96px',
                background: 'var(--bg-tertiary)',
                color: 'var(--text-muted)',
                borderRadius: 'inherit',
            }}
        >
            <ImageOff className="w-5 h-5" aria-hidden="true" />
        </div>
    );
    if (!isImageValue(shown) || failedSrc === shown) return placeholder;

    return (
        <AssetImage
            value={shown}
            alt={alt}
            onError={() => setFailedSrc(shown)}
            className={`block w-full [border-radius:inherit] ${hasHeight ? '[height:100%]' : '[height:auto]'} ${fit === 'contain' ? '[object-fit:contain]' : '[object-fit:cover]'} bfa-image__root`}
            fallback={placeholder}
        />
    );
}
