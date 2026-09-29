/**
 * What the assistant will read before it answers.
 *
 * This replaces the composer's options row, which showed up to eight model
 * tiers and six `Think: <effort>` chips behind an unlabelled slider glyph —
 * fifteen controls, in a vocabulary (Flow / Think / Write / Deep Thinking)
 * that means nothing to anyone who has not read the pricing page, all of it
 * demanded BEFORE the question, which is the one moment nobody can answer it.
 *
 * What replaces it is not a smaller version of the same idea. The row above the
 * composer shows only what is ON, so an empty row means "just you and the
 * assistant" and a full one is a list of things the answer will be built from.
 * The sheet is where you add to it.
 *
 * Three things live here, in the order they matter:
 *
 *   1. **Knowledge bases.** The reason this file exists. `knowledgeBaseIds`
 *      has been declared on SendTurnPayload since the app was written and
 *      never once assigned, while the server has been destructuring it in
 *      streamTurn.js and running access-validated retrieval in
 *      promptAssembly.js the whole time. Until now you could upload a contract
 *      to a knowledge base and have no way anywhere in the app to ask what its
 *      notice period was.
 *   2. **Skills**, from the store the Skills screen already writes. That
 *      screen has been promising "N switched on for new chats" against a field
 *      the composer never sent.
 *   3. **Web search**, because on a privacy product "did my question leave the
 *      building" is a per-turn decision and belongs in front of the person
 *      making it, not in a settings screen they visited once.
 *
 * The model tier is NOT here: it is the gauge on the composer's toolbar
 * (TierDial.tsx), in the web's own shape.
 */

import { Feather } from '@expo/vector-icons';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React from 'react';
import { View } from 'react-native';

import type { ModelTier } from './types';
import { useTheme } from '../../theme/ThemeProvider';
import { Chip } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Switch } from '../../ui/Controls';
import { ListSkeleton } from '../../ui/Feedback';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { libraryKeys, listKnowledgeBases } from '../library/api';
import { useActiveSkills } from '../skills/active';

export interface ChatContext {
    knowledgeBaseIds: string[];
    webSearchEnabled: boolean;
    modelTier: ModelTier;
}

function SectionLabel({ children, hint }: { children: string; hint?: string }) {
    const theme = useTheme();
    return (
        <View style={{ gap: 2, marginBottom: theme.spacing.sm }}>
            <Text variant="label" tone="tertiary">
                {children.toUpperCase()}
            </Text>
            {hint ? (
                <Text variant="caption" tone="tertiary">
                    {hint}
                </Text>
            ) : null}
        </View>
    );
}

export function ContextSheet({
    visible,
    onClose,
    context,
    onChange,
    sources = true,
    onDocument,
    onImage,
    onCamera,
}: {
    visible: boolean;
    onClose: () => void;
    context: ChatContext;
    onChange: (next: ChatContext) => void;
    /** See the `sources` note on ComposerProps. */
    sources?: boolean;
    /** The three attachment sources, moved here from the composer's toolbar. */
    onDocument?: () => void;
    onImage?: () => void;
    onCamera?: () => void;
}) {
    const theme = useTheme();
    const router = useRouter();
    const { activeSkillIds } = useActiveSkills();

    const bases = useQuery({
        queryKey: libraryKeys.knowledgeBases,
        queryFn: ({ signal }) => listKnowledgeBases(signal),
        // Only fetched when the sheet is actually opened — the composer is on
        // screen for the whole of every conversation, and a knowledge-base
        // list is not worth a request on every one of them.
        enabled: visible && sources,
        staleTime: 5 * 60_000,
    });

    const toggleBase = (id: string) => {
        const on = context.knowledgeBaseIds.includes(id);
        onChange({
            ...context,
            knowledgeBaseIds: on
                ? context.knowledgeBaseIds.filter((v) => v !== id)
                : [...context.knowledgeBaseIds, id],
        });
    };

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title="Add to this chat"
            subtitle="Whatever you add here, the assistant reads before it answers."
            tall
        >
            <View style={{ gap: theme.spacing.xl }}>
                {sources ? (
                <View>
                    <SectionLabel hint="The assistant reads the passages most relevant to your question, not the whole base.">
                        Knowledge bases
                    </SectionLabel>
                    {bases.isLoading ? (
                        <ListSkeleton rows={3} />
                    ) : bases.data?.length ? (
                        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
                            {bases.data.map((kb) => (
                                <Chip
                                    key={kb.id}
                                    label={kb.name}
                                    selected={context.knowledgeBaseIds.includes(kb.id)}
                                    onPress={() => toggleBase(kb.id)}
                                />
                            ))}
                        </View>
                    ) : (
                        <View style={{ gap: theme.spacing.md, alignItems: 'flex-start' }}>
                            <Text variant="caption" tone="tertiary">
                                You have no knowledge bases yet. They are where documents go so the
                                assistant can answer from them.
                            </Text>
                            <Button
                                label="Go to Library"
                                variant="secondary"
                                onPress={() => {
                                    onClose();
                                    router.push('/knowledge');
                                }}
                            />
                        </View>
                    )}
                </View>
                ) : null}

                {onDocument || onImage || onCamera ? (
                    <View>
                        <SectionLabel hint="Rides along with this message.">Add</SectionLabel>
                        <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                            {onCamera ? (
                                <Chip
                                    label="Camera"
                                    onPress={() => {
                                        onClose();
                                        onCamera();
                                    }}
                                    icon={<Feather name="camera" size={12} color={theme.colors.textSecondary} />}
                                />
                            ) : null}
                            {onImage ? (
                                <Chip
                                    label="Photo"
                                    onPress={() => {
                                        onClose();
                                        onImage();
                                    }}
                                    icon={<Feather name="image" size={12} color={theme.colors.textSecondary} />}
                                />
                            ) : null}
                            {onDocument ? (
                                <Chip
                                    label="Document"
                                    onPress={() => {
                                        onClose();
                                        onDocument();
                                    }}
                                    icon={<Feather name="file" size={12} color={theme.colors.textSecondary} />}
                                />
                            ) : null}
                        </View>
                    </View>
                ) : null}

                <View>
                    <SectionLabel>Skills</SectionLabel>
                    {activeSkillIds.length ? (
                        <Text variant="caption" tone="secondary">
                            {activeSkillIds.length === 1
                                ? '1 skill is switched on and will be used.'
                                : `${activeSkillIds.length} skills are switched on and will be used.`}
                        </Text>
                    ) : (
                        <Text variant="caption" tone="tertiary">
                            None switched on.
                        </Text>
                    )}
                    {/*
                      * A link, not the sentence "Managed in More → Skills."
                      * that used to sit in the section hint. /skills had no
                      * inbound route anywhere outside the More tab, so the one
                      * place that names it was also the one place that could
                      * have gone there and did not.
                      */}
                    <Button
                        label="Manage skills"
                        variant="ghost"
                        onPress={() => {
                            onClose();
                            router.push('/skills');
                        }}
                    />
                </View>

                <View
                    style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        gap: theme.spacing.lg,
                    }}
                >
                    <View style={{ flex: 1, gap: 2 }}>
                        <Text variant="subheading">Search the web</Text>
                        <Text variant="caption" tone="tertiary">
                            When on, this question can leave your server.
                        </Text>
                    </View>
                    <Switch
                        value={context.webSearchEnabled}
                        onValueChange={(webSearchEnabled) => onChange({ ...context, webSearchEnabled })}
                        accessibilityLabel="Search the web for this chat"
                    />
                </View>

                {/*
                  * The tier picker is deliberately NOT here any more. It was a
                  * row of chips in this sheet while the web renders a gauge on
                  * the composer that opens a slider — the one control the
                  * owner compares side by side every day, drawn two different
                  * ways. It now lives in TierDial.tsx, on the composer's
                  * toolbar, in the web's own shape.
                  */}
            </View>
        </Sheet>
    );
}

/**
 * The row above the input: only what is ON, each chip tappable to remove.
 *
 * Renders nothing when there is nothing on, which is the point — an empty
 * composer is an empty composer, not a row of dormant switches.
 */
export function ContextRow({
    context,
    bases,
    activeSkillCount,
    onChange,
    onOpen,
    sources = true,
}: {
    context: ChatContext;
    /** Names for the attached ids; a base still loading shows as "Knowledge base". */
    bases: { id: string; name: string }[];
    activeSkillCount: number;
    onChange: (next: ChatContext) => void;
    onOpen: () => void;
    /** See the `sources` note on ComposerProps. */
    sources?: boolean;
}) {
    const theme = useTheme();
    const nameOf = (id: string) => bases.find((b) => b.id === id)?.name ?? 'Knowledge base';

    // Nothing attached, nothing to draw. This row is a child of the composer
    // card, which lays its children out with a `gap` — so an empty <View> is
    // not free, it buys a blank line above the message box. Hide instead.
    if (context.knowledgeBaseIds.length === 0 && activeSkillCount === 0) return null;

    return (
        <View
            accessibilityLabel="What this chat can use"
            style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}
        >
            {context.knowledgeBaseIds.map((id) => (
                <Chip
                    key={id}
                    label={nameOf(id)}
                    selected
                    accessibilityHint="Removes this knowledge base from the chat"
                    onPress={() =>
                        onChange({
                            ...context,
                            knowledgeBaseIds: context.knowledgeBaseIds.filter((v) => v !== id),
                        })
                    }
                    icon={<Feather name="x" size={12} color={theme.colors.accentText} />}
                />
            ))}
            {/*
              * The web-search chip used to live here, drawn in BOTH states so
              * that "off" was visible rather than merely absent. The owner
              * removed it: the same switch already sits in the "+" sheet under
              * "Search the web", one tap away, and two controls for one setting
              * on a six-inch screen is worse than one control in the place the
              * web app keeps it. The sheet's copy — "When on, this question can
              * leave your server" — carries the warning the chip used to.
              */}
            {activeSkillCount > 0 ? (
                <Chip
                    label={activeSkillCount === 1 ? '1 skill' : `${activeSkillCount} skills`}
                    selected
                    accessibilityHint="Opens what this chat can use"
                    onPress={onOpen}
                    icon={<Feather name="zap" size={12} color={theme.colors.accentText} />}
                />
            ) : null}
        </View>
    );
}
