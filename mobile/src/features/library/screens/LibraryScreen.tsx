/**
 * Library — everything you read. A pushed screen since the drawer took over
 * navigation (it was a tab); its parts are also in the drawer and Studio.
 *
 * A hub rather than a list, because the four collections underneath it
 * (notebooks, knowledge bases, documents, templates) are genuinely different
 * things and a single merged feed of them would be unreadable. Each section
 * shows what changed most recently and hands off to its own screen.
 *
 * The search box on top is the exception: typing collapses the whole hub into
 * one ranked list of matches (see model/hits.ts).
 */

import React, { useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, View } from 'react-native';

import { useAuth } from '@/core/auth/AuthProvider';
import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { MemorySheet } from '@/features/memory';
import { Screen, ScreenHeader, SearchField } from '@/shared/ui';

import { AlsoHere } from '../components/AlsoHere';
import { DocumentsHubSection } from '../components/DocumentsHubSection';
import { HouseStylesSheet } from '../components/HouseStylesSheet';
import { HubSearchResults } from '../components/HubSearchResults';
import { KnowledgeHubSection } from '../components/KnowledgeHubSection';
import { NotebooksHubSection } from '../components/NotebooksHubSection';
import { TemplatesHubSection } from '../components/TemplatesHubSection';
import { useLibraryHub } from '../hooks/useLibraryHub';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        search: { paddingHorizontal: theme.spacing.lg, paddingBottom: theme.spacing.sm },
        hub: { paddingBottom: 96, gap: theme.spacing.xl },
    });

export function LibraryScreen() {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { user } = useAuth();
    const [search, setSearch] = useState('');
    const [memoryOpen, setMemoryOpen] = useState(false);
    const [houseStylesOpen, setHouseStylesOpen] = useState(false);

    const term = search.trim();
    const hub = useLibraryHub(term);

    return (
        <Screen edges={['top']}>
            {/* Pushed now (it was a tab): Back, not the drawer toggle. */}
            <ScreenHeader size="large" title="Library" showBack />

            <View style={styles.search}>
                <SearchField value={search} onChangeText={setSearch} placeholder="Search your library" />
            </View>

            {term ? (
                <HubSearchResults hits={hub.hits} refreshing={hub.refreshing} onRefresh={hub.refreshAll} />
            ) : (
                // Four sections of at most four rows each, and two links: bounded.
                <ScrollView
                    contentContainerStyle={styles.hub}
                    refreshControl={
                        <RefreshControl
                            refreshing={hub.refreshing}
                            onRefresh={hub.refreshAll}
                            tintColor={theme.colors.accentPrimary}
                            colors={[theme.colors.accentPrimary]}
                        />
                    }
                >
                    <NotebooksHubSection notebooks={hub.notebooks} />
                    <KnowledgeHubSection bases={hub.bases} />
                    <DocumentsHubSection documents={hub.documents} basesLoading={hub.bases.isLoading} />
                    <TemplatesHubSection templates={hub.templates} />
                    <AlsoHere onMemory={() => setMemoryOpen(true)} onHouseStyles={() => setHouseStylesOpen(true)} />
                </ScrollView>
            )}

            <MemorySheet visible={memoryOpen} onClose={() => setMemoryOpen(false)} />
            <HouseStylesSheet
                visible={houseStylesOpen}
                onClose={() => setHouseStylesOpen(false)}
                orgId={user?.organizationId ?? null}
            />
        </Screen>
    );
}
