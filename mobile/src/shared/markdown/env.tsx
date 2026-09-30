/**
 * What every part of a rendered answer shares: the theme and its sheet, the
 * translator, what a tapped link does, the clipboard, the answer's anchors,
 * and how to render Markdown nested inside a rich block (a research section,
 * a test report's notes).
 *
 * Built once per answer by <Markdown> (useMarkdownEnvValue) and stable while
 * the answer streams, so memoised blocks are not invalidated by a flush.
 * Plain render functions receive it as an argument; components deeper down
 * read it from context.
 */

import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { useRouter } from 'expo-router';
import React, { createContext, useContext, useMemo, useState, type ComponentType, type ReactNode } from 'react';

import { useTranslation, type TranslateFn } from '@/core/i18n';
import { useTheme, type Theme } from '@/core/theme/ThemeProvider';
import { openRoute } from '@/shared/navigation';
import { useToast } from '@/shared/ui';

import { useAppLinkTranslator } from './MarkdownLinkProvider';
import { openLink } from './openLink';
import { AnchorRegistry, useMarkdownScrollHost } from './render/anchors';
import { markdownStyles, type MarkdownStyles } from './styles';

export interface MarkdownEnv {
    theme: Theme;
    styles: MarkdownStyles;
    t: TranslateFn;
    /** A link in the answer was tapped: an anchor, an app screen, a web page or mailto:/tel: — or a toast saying it opens nowhere here. */
    open: (href: string) => void;
    /**
     * Put text on the clipboard with a light tap. `announce` adds the toast,
     * for a copy with no button of its own to say "Copied".
     */
    copy: (text: string, announce?: boolean) => void;
    anchors: AnchorRegistry;
    /** Markdown inside a rich block. */
    Nested: ComponentType<{ value: string }>;
}

const EnvContext = createContext<MarkdownEnv | null>(null);

export function MarkdownEnvProvider({ value, children }: { value: MarkdownEnv; children: ReactNode }) {
    return <EnvContext.Provider value={value}>{children}</EnvContext.Provider>;
}

export function useMarkdownEnv(): MarkdownEnv {
    const env = useContext(EnvContext);
    if (!env) throw new Error('A Markdown part rendered outside <Markdown>.');
    return env;
}

/** The env for one answer. `Nested` is passed in: it is <Markdown> itself, which imports this file. */
export function useMarkdownEnvValue(Nested: ComponentType<{ value: string }>): MarkdownEnv {
    const theme = useTheme();
    const t = useTranslation();
    const router = useRouter();
    const translate = useAppLinkTranslator();
    const host = useMarkdownScrollHost();
    const { toast } = useToast();
    const [anchors] = useState(() => new AnchorRegistry());

    return useMemo<MarkdownEnv>(
        () => ({
            theme,
            styles: markdownStyles(theme),
            t,
            anchors,
            Nested,
            open: (href) =>
                void openLink(href, {
                    push: (route) => openRoute(router, route),
                    translate,
                    anchor: (fragment) => {
                        const view = anchors.find(fragment)?.view;
                        if (view && host) host.scrollTo(view);
                    },
                    unavailable: () => toast(t('mobile.markdown.link_unavailable', 'This link doesn’t open on the phone. Open it in Bee Flow on a computer.')),
                }),
            copy: (text, announce = false) => {
                void Clipboard.setStringAsync(text);
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                if (announce) toast(t('common.copied', 'Copied to clipboard'));
            },
        }),
        [theme, t, anchors, Nested, router, translate, host, toast],
    );
}
