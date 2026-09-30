/**
 * The expo-image source for any picture an answer names — a Markdown image,
 * a report's hero or figure, a page image, a test's screenshot — by the one
 * rule in links.ts imageSource: a server path gets the server's address and
 * the session's headers, another host gets no headers, an inline `data:`
 * image is used as it is, and anything else (`file:`, `content:`, a bare
 * path with no server) is not loaded at all. A model's answer does not get
 * to point the app at its own files.
 */

import { authHeaders } from '@/core/api/client';
import { getServerUrl } from '@/core/api/server';
import { imageSource, type ImageSource } from '@/shared/markdown/links';

export function answerImage(url: string): ImageSource | null {
    return imageSource({ url, mimeType: '' }, getServerUrl(), authHeaders());
}
