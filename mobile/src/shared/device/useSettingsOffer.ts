/**
 * "Camera access is off. Open Android settings?", for a one-tap action (take
 * a photo, dictate) that needs a permission Android will no longer ask for.
 *
 * Without it the action ends in a toast and the button stays dead: Android
 * answers "denied" without a dialog, and nothing on screen says where the
 * switch is. The question goes through the app's confirm sheet, opening the
 * settings page is its button, and the promise resolves once the person is
 * back in the app, so the caller reads the permission again right then.
 */

import { useTranslation } from '@/core/i18n';
import { useConfirm } from '@/shared/patterns';

import { openAppSettings } from './appSettings';

export type DeviceAccess = 'camera' | 'microphone';

/** Resolves true once the person went to the settings page and came back; false when they chose not to. */
export type SettingsOffer = (access: DeviceAccess) => Promise<boolean>;

export function useSettingsOffer(): SettingsOffer {
    const t = useTranslation();
    const confirm = useConfirm();
    return async (access) => {
        const words =
            access === 'camera'
                ? {
                      title: t('mobile.device.camera_off_title', 'Camera access is off'),
                      message: t(
                          'mobile.device.camera_off_body',
                          "Android will not ask again. Allow the camera in Bee Flow's settings, then come back here.",
                      ),
                  }
                : {
                      title: t('mobile.device.mic_off_title', 'Microphone access is off'),
                      message: t(
                          'mobile.device.mic_off_body',
                          "Android will not ask again. Allow the microphone in Bee Flow's settings, then come back here.",
                      ),
                  };
        const open = await confirm({
            ...words,
            confirmLabel: t('mobile.device.open_settings', 'Open Android settings'),
            tone: 'primary',
        });
        if (!open) return false;
        await openAppSettings();
        return true;
    };
}
