/**
 * The composer's staged attachments and the three ways to add one. Staged,
 * not uploaded: a file shows as a chip that can be removed before sending,
 * because discovering the wrong file after the answer is worse than a
 * moment's delay. Anything that could never be sent is refused at pick time
 * (pickLimit in model/attachments).
 *
 * The photo library asks for no permission: Android's Photo Picker hands over
 * only the photos the person picks, and app.config.ts blocks the broad media
 * reads on purpose, so asking for them could only ever be refused. The camera
 * does need its permission; once Android stops asking for it, the button
 * offers Android's settings and takes the photo when the person comes back
 * with it allowed.
 */

import * as DocumentPicker from 'expo-document-picker';
import * as ImagePicker from 'expo-image-picker';
import { useCallback, useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { deniedForGood } from '@/shared/device/appSettings';
import { useSettingsOffer } from '@/shared/device/useSettingsOffer';
import { useToast } from '@/shared/ui';

import { overPickLimit } from '../model/attachments';
import type { Attachment } from '../model/types';

type PickedImage = ImagePicker.ImagePickerAsset;

function fromImage(asset: PickedImage): Attachment {
    return {
        name: asset.fileName ?? 'photo.jpg',
        mimeType: asset.mimeType ?? 'image/jpeg',
        size: asset.fileSize,
        uri: asset.uri,
    };
}

export function useAttachmentPicker(initial?: Attachment[]) {
    const t = useTranslation();
    const { toast } = useToast();
    const offerSettings = useSettingsOffer();
    const [attachments, setAttachments] = useState<Attachment[]>(initial ?? []);

    const stage = useCallback(
        (next: Attachment) => {
            const mb = overPickLimit(next);
            if (mb !== null) {
                toast(t('mobile.chat.attach_too_large', '{name} is too large to attach: the limit is {mb} MB.', { name: next.name, mb }), 'error');
                return;
            }
            setAttachments((prev) => [...prev, next]);
        },
        [toast, t],
    );

    const pickDocument = useCallback(async () => {
        const result = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: true });
        if (result.canceled) return;
        for (const asset of result.assets) {
            stage({ name: asset.name, mimeType: asset.mimeType, size: asset.size ?? undefined, uri: asset.uri });
        }
    }, [stage]);

    const pickImage = useCallback(async () => {
        const result = await ImagePicker.launchImageLibraryAsync({
            mediaTypes: ['images'],
            quality: 0.8,
            allowsMultipleSelection: true,
        });
        if (result.canceled) return;
        for (const asset of result.assets) stage(fromImage(asset));
    }, [stage]);

    const shoot = useCallback(async () => {
        const result = await ImagePicker.launchCameraAsync({ quality: 0.8 });
        if (result.canceled) return;
        const asset = result.assets[0];
        if (asset) stage(fromImage(asset));
    }, [stage]);

    const takePhoto = useCallback(async () => {
        const permission = await ImagePicker.requestCameraPermissionsAsync();
        if (permission.granted) return shoot();
        if (!deniedForGood(permission)) {
            toast(t('mobile.chat.camera_needed', 'Bee Flow needs camera permission to take a photo'), 'error');
            return undefined;
        }
        // Android no longer shows its dialog: offer its settings, and read the
        // permission again once the person is back from there.
        if (!(await offerSettings('camera'))) return undefined;
        const again = await ImagePicker.getCameraPermissionsAsync();
        return again.granted ? shoot() : undefined;
    }, [shoot, toast, t, offerSettings]);

    const remove = useCallback((index: number) => setAttachments((prev) => prev.filter((_, j) => j !== index)), []);
    const clear = useCallback(() => setAttachments([]), []);

    return { attachments, pickDocument, pickImage, takePhoto, remove, clear };
}
