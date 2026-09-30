/**
 * Pick an image for the organisation logo. Unlike the account avatar (a data
 * URI stored on the user row), the logo is a FILE the server keeps under
 * data/uploads, so the picked asset travels as a multipart part from disk.
 * The server's own rules are checked first so a refusal costs no upload:
 * PNG, JPEG, SVG or WebP (the library returns PNG/JPEG/WebP), at most 2 MB.
 *
 * No permission is asked for: Android's Photo Picker hands over only the
 * image the admin picks, and app.config.ts blocks the broad media reads on
 * purpose, so asking for them first could only ever be refused.
 */

import * as ImagePicker from 'expo-image-picker';

import { useTranslation } from '@/core/i18n';

import { LOGO_MAX_BYTES, type LogoFile } from '../api/profile';

const ACCEPTED = /^image\/(png|jpeg|jpg|svg\+xml|webp)$/;

export type PickResult = { file: LogoFile } | { error: string } | null;

export function usePickLogo(): () => Promise<PickResult> {
    const t = useTranslation();
    return async () => {
        const result = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.9 });
        const asset = result.canceled ? undefined : result.assets[0];
        if (!asset) return null;
        const mimeType = asset.mimeType ?? 'image/jpeg';
        if (!ACCEPTED.test(mimeType)) {
            return { error: t('mobile.org.logo_type', 'A logo is a PNG, JPEG, SVG or WebP image.') };
        }
        if (asset.fileSize && asset.fileSize > LOGO_MAX_BYTES) {
            return { error: t('mobile.org.logo_too_large', 'A logo is at most 2 MB.') };
        }
        const extension = mimeType.split('/')[1]?.replace('+xml', '') ?? 'jpg';
        return { file: { uri: asset.uri, name: asset.fileName ?? `logo.${extension}`, mimeType } };
    };
}
