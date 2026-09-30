/**
 * Getting files off the device.
 *
 * Three doors, because the Android file story has three: the document picker
 * (Drive, Downloads, any SAF provider), the photo library, and the camera.
 * They return three different asset shapes, so each one is normalised to
 * `UploadFile` here and every caller downstream sees one type.
 *
 * `copyToCacheDirectory` is on for documents. A SAF content:// uri is scoped
 * to the picker session and can be revoked before an upload that is queued
 * behind two others gets to it — the copy is what makes a retry ten minutes
 * later still work.
 */

import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';

import { mimeTypeFor } from './format';
import type { UploadFile } from '../api/upload';

/** Returns [] when the person backs out — cancelling is not an error. */
export async function pickDocuments(): Promise<UploadFile[]> {
    const result = await DocumentPicker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: true,
    });
    if (result.canceled) return [];
    return result.assets.map((asset) => ({
        uri: asset.uri,
        name: asset.name || 'document',
        mimeType: asset.mimeType || mimeTypeFor(asset.name || ''),
        size: asset.size ?? 0,
    }));
}

/**
 * Photo library, through Android's Photo Picker, which needs no permission:
 * the app receives only the photos the person picks. app.config.ts blocks the
 * broad media reads on purpose, so asking for them first could only ever be
 * refused, and the pick would never open.
 */
export async function pickImages(): Promise<UploadFile[]> {
    const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ['images'],
        allowsMultipleSelection: true,
        quality: 0.85,
    });
    if (result.canceled) return [];

    return result.assets.map((asset, i) => ({
        uri: asset.uri,
        // The library often reports no file name for a photo taken by the
        // camera app; a timestamped fallback beats "undefined" in a list.
        name: asset.fileName || `photo-${Date.now()}-${i + 1}.jpg`,
        mimeType: asset.mimeType || 'image/jpeg',
        size: asset.fileSize ?? 0,
    }));
}
