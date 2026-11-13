/**
 * Which image model the composer offers and which one is picked. The list
 * comes from the server (/ai/user-settings `imageModels`: the Google models
 * with a Google key, `azure/<deployment>` per Azure image deployment); the two
 * Google models are the fallback when a server sends no list. The choice is
 * stored as `imageGenSettings.model` and sent with every chat turn; the server
 * takes either kind of id and falls back itself when one is no longer there.
 */
import type { ImageModelOption } from '@/api/queries/composerSettings';

export const FALLBACK_IMAGE_MODELS: readonly ImageModelOption[] = [
    { id: 'gemini-3.1-flash-image-preview', label: 'Flash Image (Fast)', provider: 'google' },
    { id: 'gemini-3-pro-image-preview', label: 'Pro Image (Quality)', provider: 'google' },
];

/** The models to offer: the server's list, or the fallback when it sent none. */
export function imageModelOptions(fromServer: readonly ImageModelOption[] | null | undefined): readonly ImageModelOption[] {
    return fromServer && fromServer.length > 0 ? fromServer : FALLBACK_IMAGE_MODELS;
}

/** The stored choice when it is still offered, else the first model offered. */
export function selectedImageModel(stored: string | null | undefined, options: readonly ImageModelOption[]): string {
    if (stored && options.some(o => o.id === stored)) return stored;
    return options[0]?.id ?? '';
}
