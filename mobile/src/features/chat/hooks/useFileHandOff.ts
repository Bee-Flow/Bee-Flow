/**
 * How an answer's video or file leaves the app, for the cards that offer one.
 *
 * This workspace's own file is fetched with the session and handed to
 * Android's share sheet (core/api/shareFile.ts): that is where "save to
 * Drive", "send" and the apps that accept a shared file live, so the button
 * says "Share or save…" rather than promising a download or a player. A link
 * anywhere else opens in the browser, without the session's headers, and says
 * that instead. Either way a failure is said out loud: the download's own
 * reason in describeError's words, or that the link would not open.
 */

import { useState } from 'react';
import { Linking } from 'react-native';

import { describeError } from '@/core/api/errors';
import { shareServerFile } from '@/core/api/shareFile';
import { useTranslation } from '@/core/i18n';
import type { ImageSource } from '@/shared/markdown';
import { useToast, type IconName } from '@/shared/ui';

import { isOwnServer } from '../model/media';

export interface HandOffAction {
    label: string;
    icon: IconName;
    onPress: () => void;
}

export function useFileHandOff() {
    const t = useTranslation();
    const { toast } = useToast();
    const [busy, setBusy] = useState(false);

    const openLink = (url: string) =>
        void Linking.openURL(url).catch(() => toast(t('mobile.chat.link_failed', 'This link could not be opened on this phone.'), 'error'));

    const share = (path: string, fileName: string, mimeType?: string) => {
        setBusy(true);
        shareServerFile(path, fileName, mimeType)
            .catch((err: unknown) => toast(describeError(err).message, 'error'))
            .finally(() => setBusy(false));
    };

    /** The button for a file: what it says and what it does; null when there is no file. */
    const actionFor = (source: ImageSource | null, fileName: string, mimeType?: string): HandOffAction | null => {
        if (!source) return null;
        if (isOwnServer(source)) {
            return { label: t('mobile.chat.share_or_save', 'Share or save…'), icon: 'Share2', onPress: () => share(source.uri, fileName, mimeType) };
        }
        return { label: t('mobile.chat.open_in_browser', 'Open in browser'), icon: 'ExternalLink', onPress: () => openLink(source.uri) };
    };

    return { busy, openLink, actionFor };
}
