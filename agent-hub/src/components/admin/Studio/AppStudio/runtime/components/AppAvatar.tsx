import { User } from 'lucide-react';
import { useState } from 'react';
import useTranslation from '@/hooks/useTranslation';
import AssetImage from '../assets/AssetImage';
import { isAllowedBoundImage, isImageValue } from '../assets/assetUrl';
import { resolveBinding } from '../resolveBinding';
import type { BindingInput } from '../resolveBinding.types';
import { useRuntime } from '../RuntimeContext';
import type { NodeProps } from './appNode.types';

/**
 * App Studio runtime - 'avatar' (schema 3). Spec: server/appStudio/componentSpecs/types/avatar.js.
 *
 * A round picture. The source follows the image type: an https URL or `asset:<id>`, `srcFrom`
 * (a binding) first and `src` as the fallback; a bound address off the app's `allowedLinkHosts`
 * is never loaded (the initials show). When there is no usable picture, or it fails to
 * load, the initials of `name` stand in (a person icon when there is no name either).
 */
interface AvatarProps {
    src?: string | null;
    srcFrom?: BindingInput;
    name?: string | null;
    nameFrom?: BindingInput;
    size?: string;
}

const SIZES: Record<string, string> = { sm: 'w-8 h-8 text-xs', md: 'w-10 h-10 text-sm', lg: 'w-16 h-16 text-xl' };

/** First letter of the first and of the last word of a name, upper-cased. One word gives one letter. */
export function initialsOf(name: string): string {
    const words = name.split(' ').filter((word) => word.trim() !== '');
    if (words.length === 0) return '';
    const letter = (word: string) => Array.from(word.trim())[0] ?? '';
    const pair = words.length === 1 ? letter(words[0]) : letter(words[0]) + letter(words[words.length - 1]);
    return pair.toUpperCase();
}

function textOf(raw: unknown): string {
    return typeof raw === 'string' || typeof raw === 'number' ? String(raw).trim() : '';
}

export default function AppAvatar({ node }: NodeProps<AvatarProps>) {
    const { t } = useTranslation();
    const { actionState, dataState, scope, linkHosts } = useRuntime();
    const { src = null, srcFrom, name = null, nameFrom, size = 'md' } = node.props || {};
    const { value: boundSrc } = resolveBinding(srcFrom, { actionState, dataState, scope });
    const { value: boundName } = resolveBinding(nameFrom, { actionState, dataState, scope });
    const shown = isAllowedBoundImage(boundSrc, linkHosts) ? boundSrc : (isImageValue(boundSrc) ? null : src);
    const who = textOf(boundName) || textOf(name);
    const [failedSrc, setFailedSrc] = useState<string | null>(null);
    const initials = (
        <span className="inline-flex items-center justify-center w-full h-full bfa-avatar__initials">
            {who ? initialsOf(who) : <User className="w-1/2 h-1/2" aria-hidden="true" />}
        </span>
    );
    const picture = isImageValue(shown) && failedSrc !== shown;

    return (
        <span
            role="img"
            aria-label={who || t('studio_apps_lk21a.avatar.label', 'Avatar')}
            className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-medium select-none [background:var(--app-primary-soft)] [color:var(--app-primary)] ${SIZES[size] ?? SIZES.md} bfa-avatar__root`}
        >
            {picture ? (
                <AssetImage
                    value={shown}
                    alt=""
                    onError={() => setFailedSrc(shown)}
                    className="block w-full h-full [object-fit:cover] bfa-avatar__image"
                    fallback={initials}
                />
            ) : initials}
        </span>
    );
}
