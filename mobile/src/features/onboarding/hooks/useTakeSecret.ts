/**
 * Copying or sharing a one-time secret, and remembering that it happened —
 * the first of the two deliberate acts RecoveryKeyCard asks for.
 */

import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';
import { useState } from 'react';
import { Share } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useToast } from '@/shared/ui';

export function useTakeSecret(plain: string, shareTitle: string) {
    const { toast } = useToast();
    const t = useTranslation();
    const [taken, setTaken] = useState(false);

    const copy = async () => {
        await Clipboard.setStringAsync(plain);
        setTaken(true);
        toast(t('common.copied', 'Copied to your clipboard'), 'success');
    };

    // expo-sharing needs a file; Share is the system sheet and takes text
    // directly, which is what a password manager accepts. Falling back to
    // isAvailableAsync keeps the button honest on a device with no share
    // targets at all.
    const share = async () => {
        try {
            const result = await Share.share({ message: plain, title: shareTitle });
            if (result.action !== Share.dismissedAction) setTaken(true);
        } catch {
            if (!(await Sharing.isAvailableAsync())) {
                toast(t('mobile.onboarding.share_unavailable', 'No app on this device can accept it — copy it instead'), 'error');
            }
        }
    };

    return { taken, copy, share };
}
