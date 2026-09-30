/**
 * Choosing the file a file question asks for. The question's `accept` is an
 * HTML accept list (`application/pdf,image/*,.docx`); Android's picker
 * filters by MIME type only, so the MIME entries are kept and a list with
 * none falls back to "any file" — the server's upload guard is the real
 * check either way.
 */

import * as DocumentPicker from 'expo-document-picker';

import type { FillUploadFile } from './fillTypes';

export function acceptTypes(accept: string | null | undefined): string[] {
    const types = String(accept || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^[a-z]+\/[a-z0-9.+*-]+$/i.test(s));
    return types.length ? types : ['*/*'];
}

/** One file, or null when the person backs out — cancelling is not an error. */
export async function pickFormFile(accept: string): Promise<FillUploadFile | null> {
    const result = await DocumentPicker.getDocumentAsync({ type: acceptTypes(accept), copyToCacheDirectory: true, multiple: false });
    if (result.canceled) return null;
    const asset = result.assets[0];
    if (!asset) return null;
    return {
        uri: asset.uri,
        name: asset.name || 'file',
        mimeType: asset.mimeType || 'application/octet-stream',
        size: asset.size ?? 0,
    };
}
