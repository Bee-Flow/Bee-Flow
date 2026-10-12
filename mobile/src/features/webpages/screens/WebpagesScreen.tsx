/**
 * Webpages — the pages you can open, and a new one.
 *
 * The list is audience-scoped: your own pages plus anything published to your
 * organisation or your groups. So a row here is not necessarily yours to
 * change; the page screen makes that distinction (`readOnly`).
 *
 * `/webpages?new=1` opens the new-page sheet straight away, which is how the
 * Studio's New menu reaches it.
 */

import { useRouter } from 'expo-router';
import React, { useState } from 'react';

import { useTranslation } from '@/core/i18n';
import { QueryList } from '@/shared/patterns';
import { Button, Screen, ScreenHeader } from '@/shared/ui';

import { NewWebpageSheet } from '../components/NewWebpageSheet';
import { WebpageRow } from '../components/WebpageRow';
import { useWebpages } from '../hooks/queries';
import type { Webpage } from '../model/types';

const matches = (page: Webpage, needle: string) =>
    `${page.name} ${page.description} ${page.tagline}`.toLowerCase().includes(needle);

const keyOf = (page: Webpage) => page.id;

function summary(pages: Webpage[] | undefined, t: ReturnType<typeof useTranslation>): string | undefined {
    if (!pages) return undefined;
    const published = pages.filter((page) => page.isPublished).length;
    return t('mobile.webpages.list.summary', '{count} pages · {published} published', {
        count: pages.length,
        published,
    });
}

export function WebpagesScreen({ startCreating = false }: { startCreating?: boolean }) {
    const t = useTranslation();
    const router = useRouter();
    const query = useWebpages();
    const [creating, setCreating] = useState(startCreating);

    return (
        <Screen edges={['top', 'bottom']}>
            <ScreenHeader
                title={t('mobile.webpages.title', 'Webpages')}
                subtitle={summary(query.data, t)}
                actions={
                    <Button
                        label={t('mobile.webpages.new.title', 'New webpage')}
                        size="sm"
                        iconName="Plus"
                        onPress={() => setCreating(true)}
                    />
                }
            />

            <QueryList
                query={query}
                keyExtractor={keyOf}
                search={{ placeholder: t('mobile.webpages.search', 'Search pages'), match: matches }}
                renderItem={({ item }) => (
                    <WebpageRow page={item} onPress={() => router.push(`/webpages/${encodeURIComponent(item.id)}`)} />
                )}
                empty={{
                    icon: 'Globe',
                    title: t('mobile.webpages.empty_title', 'No pages yet'),
                    message: t(
                        'mobile.webpages.empty_build',
                        'Describe a page and the builder makes it — then publish it to your colleagues or share a link.',
                    ),
                    actionLabel: t('mobile.webpages.new.title', 'New webpage'),
                    onAction: () => setCreating(true),
                }}
                noMatch={{
                    title: t('mobile.webpages.no_match', 'No page matches that'),
                    message: t('mobile.webpages.no_match_hint', 'Try another word.'),
                    clearLabel: t('automations.mapping.clear_search', 'Clear search'),
                }}
            />
            <NewWebpageSheet visible={creating} onClose={() => setCreating(false)} />
        </Screen>
    );
}
