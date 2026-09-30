/**
 * Open a web address the server minted — a finding's "Show me"
 * (projects/completeness.js DEEP_LINK) or a filed item's page — on the phone.
 *
 * The translation is the notification table's (`translateWebLink`), through
 * the same `linkTarget` a chat answer's links use, so a link and a
 * notification to the same thing open the same screen. The in-app browser is
 * left only for a page the web draws on a phone; any other address — one the
 * web would bounce to the Agents chat after a sign-in — gets a toast that
 * says where it opens, instead of a tap that does nothing.
 */

import { useRouter } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';

import { getServerUrl } from '@/core/api/server';
import { useTranslation } from '@/core/i18n';
import { translateWebLink } from '@/features/notifications';
import { linkTarget } from '@/shared/markdown';
import { openRoute } from '@/shared/navigation';
import { useToast } from '@/shared/ui';

export function useOpenLink(): (path: string) => void {
    const router = useRouter();
    const t = useTranslation();
    const { toast } = useToast();
    return (path) => {
        const target = linkTarget(path, getServerUrl(), translateWebLink);
        if (target?.kind === 'route') openRoute(router, target.href);
        else if (target?.kind === 'browser') void WebBrowser.openBrowserAsync(target.url, { createTask: false });
        else if (!target) toast(t('mobile.projects.open_unavailable', 'This isn’t on the phone. Open it in Bee Flow on a computer.'));
    };
}
