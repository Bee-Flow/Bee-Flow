/**
 * Pick a photo and send it as a data URI.
 *
 * `/auth/update-profile` stores whatever string it is given in the users
 * table's `avatar` column — the web app sends a base64 data URI from its
 * AvatarPicker, and shared/ui/Avatar.tsx already renders one. So this uploads
 * nothing: no multipart endpoint is involved, which is also why the image is
 * squared and shrunk hard before encoding.
 *
 * No permission is asked for: Android's Photo Picker hands over only the
 * photo the person picks, and app.config.ts blocks the broad media reads on
 * purpose, so asking for them first could only ever be refused.
 */

import * as ImagePicker from 'expo-image-picker';

export function usePickAvatar(onPicked: (dataUri: string) => void): () => Promise<void> {
    return async () => {
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            allowsEditing: true,
            aspect: [1, 1],
            // The avatar renders at 48dp; a 256px square is generous and keeps
            // the base64 blob well inside the server's 20 MB JSON body limit.
            quality: 0.7,
            base64: true,
        });
        if (result.canceled) return;
        const asset = result.assets[0];
        if (!asset?.base64) return;
        onPicked(`data:${asset.mimeType ?? 'image/jpeg'};base64,${asset.base64}`);
    };
}
