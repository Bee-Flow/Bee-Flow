/**
 * The rendered page, full width, inside the app: a WebView holding the
 * wrapper document from model/preview.ts.
 *
 * Isolation, prop by prop — the page is untrusted, generated content:
 *
 *   - no bridge to the app: no `onMessage`, no injected JavaScript, so
 *     `window.ReactNativeWebView` does not exist in the page;
 *   - JavaScript is on because the web's shielded preview runs the page's
 *     scripts (`allow-scripts`); they run inside the sandboxed, opaque-origin
 *     iframe, never in the wrapper, which has no script;
 *   - `originWhitelist` is about: (the wrapper) and the server's own origin
 *     (the public content document); react-native-webview hands anything
 *     else to the system browser, and `decideNavigation` sends every link
 *     that leaves the page there too;
 *   - no cookies into the frame (third-party cookies off), no file access,
 *     no mixed content, no DOM storage, no new windows, no form autofill,
 *     no geolocation, no remote debugging.
 *
 * Not `incognito`: on Android it calls CookieManager.removeAllCookies, and
 * that cookie jar is the one React Native's own networking uses — it would
 * sign a password user out of the app.
 */

import React, { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { WebView, type WebViewProps } from 'react-native-webview';

import { useTranslation } from '@/core/i18n';
import { ErrorState, Spinner } from '@/shared/ui';

import { serverOrigin } from '../hooks/usePreviewDocument';
import { decideNavigation } from '../model/preview';

const styles = StyleSheet.create({
    fill: { flex: 1 },
    overlay: { position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, alignItems: 'center', justifyContent: 'center' },
});

type ShouldStart = NonNullable<WebViewProps['onShouldStartLoadWithRequest']>;

function useNavigationGuard(): ShouldStart {
    const origin = serverOrigin();
    return ({ url, isTopFrame }) => {
        const decision = decideNavigation(url, isTopFrame !== false, origin);
        if (decision === 'external') void Linking.openURL(url).catch(() => undefined);
        return decision === 'load';
    };
}

export interface PagePreviewProps {
    html: string;
    baseUrl?: string;
    /** Bumped by Reload: a new key is a fresh WebView. */
    reloadKey: number;
    onReload: () => void;
}

export function PagePreview({ html, baseUrl, reloadKey, onReload }: PagePreviewProps) {
    const t = useTranslation();
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState<Error | null>(null);
    const onShouldStart = useNavigationGuard();
    const origin = serverOrigin();
    const failure = t('mobile.webpages.preview.failed', 'The preview could not be loaded.');

    if (failed) {
        return (
            <ErrorState
                error={failed}
                onRetry={() => {
                    setFailed(null);
                    onReload();
                }}
            />
        );
    }

    return (
        <View style={styles.fill}>
            <WebView
                key={reloadKey}
                style={styles.fill}
                source={baseUrl ? { html, baseUrl } : { html }}
                accessibilityLabel={t('webpages.preview.frame_title', 'Webpage preview')}
                originWhitelist={origin ? ['about:*', origin] : ['about:*']}
                onShouldStartLoadWithRequest={onShouldStart}
                javaScriptEnabled
                domStorageEnabled={false}
                thirdPartyCookiesEnabled={false}
                sharedCookiesEnabled={false}
                allowFileAccess={false}
                allowFileAccessFromFileURLs={false}
                allowUniversalAccessFromFileURLs={false}
                mixedContentMode="never"
                setSupportMultipleWindows={false}
                javaScriptCanOpenWindowsAutomatically={false}
                saveFormDataDisabled
                geolocationEnabled={false}
                webviewDebuggingEnabled={false}
                mediaPlaybackRequiresUserAction
                allowsProtectedMedia={false}
                textZoom={100}
                onLoadStart={() => setLoading(true)}
                onLoadEnd={() => setLoading(false)}
                onError={() => setFailed(new Error(failure))}
                onRenderProcessGone={() => setFailed(new Error(failure))}
            />
            {loading ? (
                <View style={styles.overlay} pointerEvents="none">
                    <Spinner />
                </View>
            ) : null}
        </View>
    );
}
