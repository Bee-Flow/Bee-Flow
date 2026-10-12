/**
 * Studio apps you can run.
 *
 * `GET /api/studio-apps` lists the apps the caller's org and groups let them
 * see, meta only — the component tree comes later, from /runtime, which is
 * also where the audience gate is actually enforced.
 *
 * Two things this screen deliberately does NOT show:
 *
 *   - The App Marketplace (`/apps` on the server, `appStore`). Those "apps" are
 *     HTML and JavaScript that the web client renders in a sandboxed iframe.
 *     There is no honest way to run them natively, and the dishonest way is a
 *     WebView, which this app does not have and is not getting.
 *   - Drafts. An unpublished app answers 404 from /runtime for everyone but its
 *     owner, so listing one would be offering a door that does not open.
 */

import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { QueryList } from '@/shared/patterns';
import { Screen, ScreenHeader } from '@/shared/ui';

import { AppRow } from '../components/AppRow';
import { useStudioApps } from '../hooks/queries';

/** A pushed screen: reached from Studio's Workspace group, a link or a search hit. */
export function AppsScreen() {
    const t = useTranslation();
    const router = useRouter();
    const [search, setSearch] = useState('');
    const apps = useStudioApps();

    const published = useMemo(() => apps.data?.filter((app) => app.isPublished), [apps.data]);
    const needle = search.trim().toLowerCase();
    const visible = (published ?? []).filter(
        (app) => !needle || `${app.name} ${app.description}`.toLowerCase().includes(needle),
    );

    return (
        <Screen>
            <ScreenHeader
                title={t('sidebar.apps', 'Apps')}
                subtitle={visible.length ? `${visible.length} you can run` : undefined}
            />

            <QueryList
                query={{
                    // Drafts are counted out before the list decides "none yet"
                    // from "no match", so an org with only drafts reads as empty.
                    data: published,
                    isLoading: apps.isLoading,
                    isError: apps.isError,
                    error: apps.error,
                    refetch: apps.refetch,
                }}
                keyExtractor={(app) => app.id}
                renderItem={({ item }) => <AppRow app={item} onPress={() => router.push(`/apps/${item.id}`)} />}
                search={{
                    placeholder: 'Search apps',
                    value: search,
                    onChange: setSearch,
                    match: (app, n) => `${app.name} ${app.description}`.toLowerCase().includes(n),
                }}
                empty={{
                    icon: 'PanelsTopLeft',
                    title: t('mobile.apps.none_published', 'No published apps'),
                    message: t(
                        'mobile.apps.none_published_hint',
                        'Apps are built in App Studio on the desktop. Once one is published, you can fill in its form and run it from here.',
                    ),
                }}
                noMatch={{
                    title: t('mobile.apps.no_match', 'No app matches that'),
                    message: t('mobile.apps.no_match_hint', 'Try another word.'),
                    clearLabel: t('automations.mapping.clear_search', 'Clear search'),
                }}
            />
        </Screen>
    );
}
