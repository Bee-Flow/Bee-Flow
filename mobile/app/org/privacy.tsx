/**
 * Privacy Shield and compliance.
 *
 * Three layers, and the screen keeps them visibly separate because they behave
 * differently:
 *
 *   1. YOUR shield (`/api/org-privacy-shield/user/me`) — editable by you,
 *      applies to your own messages. It is SECURE BY DEFAULT: an account that
 *      has never opened this panel is already protected, and the server marks
 *      that state with `implicitDefault` so the UI can say "these are the
 *      defaults in force" rather than pretending you chose them.
 *   2. YOUR ORGANISATION's shield (`/api/org-privacy-shield/:orgId`) — read
 *      here, editable only in the web app. When it is on, it applies on top of
 *      yours and can be stricter than anything you can set.
 *   3. Compliance (`/api/dsr/requests`) — data-subject requests, visible to
 *      administrators with `admin_compliance`.
 *
 * The guard-status probe matters more than it looks: with the shield on and
 * the PII Guard service absent, detection quietly does nothing. That used to
 * be indistinguishable from "on and working", so it is stated here first.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { RefreshControl, ScrollView, View } from 'react-native';

import { useAuth } from '../../src/auth/AuthProvider';
import {
    getGuardStatus,
    getOrgShield,
    getUserShield,
    listDsrRequests,
    saveUserShield,
    settingsKeys,
} from '../../src/features/settings/api';
import { humanise } from '../../src/features/settings/format';
import { useCanAdminCompliance } from '../../src/features/settings/permissions';
import {
    EMPTY_MEANS_ALL,
    PII_ACTIONS,
    PII_CATEGORIES,
    PII_FAILURE_MODES,
    PII_GROUPS,
} from '../../src/features/settings/piiCategories';
import type { UserShield } from '../../src/features/settings/types';
import { relativeTime } from '../../src/lib/time';
import { useTheme } from '../../src/theme/ThemeProvider';
import { Badge, Chip } from '../../src/ui/Badge';
import { Button } from '../../src/ui/Button';
import { OptionRow, ToggleRow } from '../../src/ui/Controls';
import { Banner, describeError, LoadingState } from '../../src/ui/Feedback';
import { Group, InfoRow, NoteRow } from '../../src/ui/Group';
import { SettingRow } from '../../src/ui/List';
import { Screen } from '../../src/ui/Screen';
import { ScreenHeader } from '../../src/ui/ScreenHeader';
import { Sheet } from '../../src/ui/Sheet';
import { Text } from '../../src/ui/Text';
import { useToast } from '../../src/ui/Toast';

export default function OrgPrivacyScreen() {
    const theme = useTheme();
    const router = useRouter();
    const queryClient = useQueryClient();
    const { toast } = useToast();
    const { user } = useAuth();
    const canAdminCompliance = useCanAdminCompliance();

    const [categorySheet, setCategorySheet] = useState(false);

    const shield = useQuery({
        queryKey: settingsKeys.userShield,
        queryFn: ({ signal }) => getUserShield(signal),
    });

    const guard = useQuery({
        queryKey: settingsKeys.guardStatus,
        queryFn: ({ signal }) => getGuardStatus(signal),
        staleTime: 60_000,
        retry: false,
    });

    const orgId = user?.organizationId ?? null;
    const orgShield = useQuery({
        queryKey: settingsKeys.orgShield(orgId ?? 'none'),
        queryFn: ({ signal }) => (orgId ? getOrgShield(orgId, signal) : Promise.resolve(null)),
        enabled: Boolean(orgId),
        staleTime: 5 * 60_000,
        retry: false,
    });

    const dsr = useQuery({
        queryKey: settingsKeys.dsr,
        queryFn: ({ signal }) => listDsrRequests(signal),
        enabled: canAdminCompliance,
        retry: false,
    });

    /**
     * Save the whole shield document.
     *
     * PUT /user/me replaces the stored config rather than patching it — every
     * field is read off `req.body` and defaulted if absent — so a partial send
     * would silently reset the omitted ones. The current document is always
     * spread first.
     */
    const save = useMutation({
        mutationFn: (next: UserShield) => saveUserShield(next),
        onSuccess: () => {
            void queryClient.invalidateQueries({ queryKey: settingsKeys.userShield });
            toast('Privacy settings saved', 'success');
        },
    });

    const current = shield.data;
    const patch = (changes: Partial<UserShield>) => {
        if (!current) return;
        save.mutate({ ...current, ...changes });
    };

    const guardMissing = guard.data && !guard.data.configured;
    const guardUnreachable = guard.data?.configured && !guard.data.reachable;

    return (
        <Screen edges={['top']} inset>
            <ScreenHeader title="Privacy" subtitle="What leaves your device, and what does not" />

            <ScrollView
                refreshControl={
                    <RefreshControl
                        refreshing={shield.isRefetching}
                        onRefresh={() => {
                            void shield.refetch();
                            void guard.refetch();
                            void orgShield.refetch();
                        }}
                        tintColor={theme.colors.accentPrimary}
                        colors={[theme.colors.accentPrimary]}
                    />
                }
                contentContainerStyle={{
                    padding: theme.spacing.lg,
                    gap: theme.spacing.xl,
                    paddingBottom: theme.spacing.xxxl,
                }}
            >
                {save.isError ? (
                    <Banner tone="error">{describeError(save.error).message}</Banner>
                ) : null}

                {guardMissing ? (
                    <Banner tone="warning">
                        No PII detector is installed on this server, so nothing is scanned for
                        personal data — whatever these settings say. An administrator installs it
                        with the <Text variant="code">guard</Text> profile.
                    </Banner>
                ) : guardUnreachable ? (
                    <Banner tone="error">
                        The PII detector is installed but not answering.{' '}
                        {current?.piiFailureMode === 'fail_open'
                            ? 'Your messages are going out unscanned, because you have chosen to send anyway when it is down.'
                            : 'Messages are being refused rather than sent unscanned.'}
                    </Banner>
                ) : null}

                {current?.implicitDefault ? (
                    <Banner tone="info" icon="shield">
                        These are Bee Flow&rsquo;s secure defaults, in force because you have never
                        changed them — not an unconfigured state. Changing anything below saves the
                        whole set as your own.
                    </Banner>
                ) : null}

                {shield.isLoading ? (
                    <LoadingState label="Reading your privacy settings" />
                ) : shield.isError ? (
                    <Banner tone="error">{describeError(shield.error).message}</Banner>
                ) : current ? (
                    <>
                        <Group
                            title="Your shield"
                            footer="Applies to everything you send from any device signed in to this account."
                        >
                            <ToggleRow
                                label="Privacy Shield"
                                description="Screen your messages before they reach a model"
                                value={current.enabled}
                                onValueChange={(value) => patch({ enabled: value })}
                                icon={
                                    <Feather
                                        name="shield"
                                        size={16}
                                        color={
                                            current.enabled
                                                ? theme.colors.success
                                                : theme.colors.textMuted
                                        }
                                    />
                                }
                            />
                            <ToggleRow
                                label="Detect personal data"
                                description="Find names, numbers and identifiers in what you send"
                                value={current.piiDetectionEnabled}
                                disabled={!current.enabled}
                                onValueChange={(value) => patch({ piiDetectionEnabled: value })}
                            />
                            <ToggleRow
                                label="EU-only models"
                                description="Route your work to models hosted in the EU"
                                value={current.euModeEnabled}
                                disabled={!current.enabled}
                                onValueChange={(value) => patch({ euModeEnabled: value })}
                                icon={
                                    <Feather
                                        name="globe"
                                        size={16}
                                        color={theme.colors.textSecondary}
                                    />
                                }
                            />
                            <ToggleRow
                                label="No web search on uploads"
                                description="Keep uploaded documents out of any web lookup"
                                value={current.disableSearchOnUpload}
                                disabled={!current.enabled}
                                onValueChange={(value) =>
                                    patch({ disableSearchOnUpload: value })
                                }
                            />
                        </Group>

                        <Group
                            title="What to look for"
                            footer={
                                current.piiDetectionCategories.length === 0
                                    ? EMPTY_MEANS_ALL
                                    : `${current.piiDetectionCategories.length} of ${PII_CATEGORIES.length} categories selected.`
                            }
                        >
                            <SettingRow
                                label="Categories"
                                value={
                                    current.piiDetectionCategories.length === 0
                                        ? 'Everything'
                                        : `${current.piiDetectionCategories.length} selected`
                                }
                                disabled={!current.enabled || !current.piiDetectionEnabled}
                                icon={
                                    <Feather
                                        name="list"
                                        size={16}
                                        color={theme.colors.textSecondary}
                                    />
                                }
                                onPress={() => setCategorySheet(true)}
                            />
                            <InfoRow
                                label="Confidence threshold"
                                value={`${Math.round(current.piiDetectionConfidenceThreshold * 100)}%`}
                            />
                        </Group>

                        <Group
                            title="When something is found"
                            footer="Replacing keeps the conversation working; stopping is stricter and more interruptive."
                        >
                            {PII_ACTIONS.map((action) => (
                                <OptionRow
                                    key={action.id}
                                    label={action.label}
                                    description={action.description}
                                    selected={current.piiDetectionAction === action.id}
                                    disabled={!current.enabled || !current.piiDetectionEnabled}
                                    onPress={() => patch({ piiDetectionAction: action.id })}
                                />
                            ))}
                        </Group>

                        <Group
                            title="If the detector is down"
                            footer="This only bites when a detector is installed but unreachable. On a server with none installed, messages are never held back."
                        >
                            {PII_FAILURE_MODES.map((mode) => (
                                <OptionRow
                                    key={mode.id}
                                    label={mode.label}
                                    description={mode.description}
                                    selected={current.piiFailureMode === mode.id}
                                    disabled={!current.enabled}
                                    onPress={() => patch({ piiFailureMode: mode.id })}
                                />
                            ))}
                        </Group>
                    </>
                ) : null}

                {orgShield.data ? (
                    <Group
                        title="Your organisation's shield"
                        footer="Set by your administrator in the web app. It applies on top of yours and can be stricter than anything you can choose here."
                    >
                        <View
                            style={{
                                flexDirection: 'row',
                                alignItems: 'center',
                                gap: theme.spacing.md,
                                paddingHorizontal: theme.spacing.lg,
                                paddingVertical: theme.spacing.md,
                                minHeight: theme.minTouch,
                            }}
                        >
                            <Text variant="body" style={{ flex: 1 }}>
                                Status
                            </Text>
                            <Badge
                                label={orgShield.data.enabled ? 'Active' : 'Off'}
                                tone={orgShield.data.enabled ? 'success' : 'neutral'}
                            />
                        </View>
                        {orgShield.data.enabled ? (
                            <>
                                <InfoRow
                                    label="On a match"
                                    value={
                                        PII_ACTIONS.find(
                                            (a) => a.id === orgShield.data?.piiDetectionAction,
                                        )?.label ?? humanise(orgShield.data.piiDetectionAction)
                                    }
                                />
                                <InfoRow
                                    label="EU-only models"
                                    value={orgShield.data.euModeEnabled ? 'Required' : 'Not required'}
                                />
                                <InfoRow
                                    label="Applies to automations"
                                    value={orgShield.data.applyToAutomations ? 'Yes' : 'No'}
                                />
                            </>
                        ) : null}
                        {orgShield.data.clamped_fields?.length ? (
                            <NoteRow>
                                <Text variant="caption" tone="warning">
                                    Your organisation&rsquo;s licence tier narrows{' '}
                                    {orgShield.data.clamped_fields.join(', ')}. The values above are
                                    what actually runs, not what is stored.
                                </Text>
                            </NoteRow>
                        ) : null}
                    </Group>
                ) : null}

                <Group
                    title="Your data rights"
                    footer="Bee Flow answers within thirty days, as the GDPR requires."
                >
                    <SettingRow
                        label="Request a copy, correction or deletion"
                        icon={
                            <Feather
                                name="file-text"
                                size={16}
                                color={theme.colors.textSecondary}
                            />
                        }
                        onPress={() => router.push('/settings/account')}
                    />
                </Group>

                {canAdminCompliance ? (
                    <Group
                        title="Data-subject requests"
                        footer="Requests filed against your organisation. Fulfilling one, and exporting the subject's data, is done in the web app's Compliance Hub."
                    >
                        {dsr.isLoading ? (
                            <NoteRow>
                                <LoadingState />
                            </NoteRow>
                        ) : dsr.data && dsr.data.length > 0 ? (
                            dsr.data.slice(0, 8).map((request) => (
                                <View
                                    key={request.id}
                                    style={{
                                        flexDirection: 'row',
                                        alignItems: 'center',
                                        gap: theme.spacing.md,
                                        paddingHorizontal: theme.spacing.lg,
                                        paddingVertical: theme.spacing.md,
                                        minHeight: theme.minTouch,
                                    }}
                                >
                                    <View style={{ flex: 1, gap: 2 }}>
                                        <Text variant="body" numberOfLines={1}>
                                            {humanise(request.request_type)} · #{request.id}
                                        </Text>
                                        <Text variant="caption" tone="tertiary" numberOfLines={1}>
                                            {request.subject_email ?? 'Anonymous'} ·{' '}
                                            {relativeTime(request.created_at)}
                                        </Text>
                                    </View>
                                    <Badge
                                        label={humanise(request.status)}
                                        tone={
                                            request.status === 'fulfilled'
                                                ? 'success'
                                                : request.status === 'open'
                                                  ? 'warning'
                                                  : 'neutral'
                                        }
                                    />
                                </View>
                            ))
                        ) : (
                            <NoteRow>No requests have been filed.</NoteRow>
                        )}
                    </Group>
                ) : null}
            </ScrollView>

            <CategorySheet
                visible={categorySheet}
                onClose={() => setCategorySheet(false)}
                selected={current?.piiDetectionCategories ?? []}
                saving={save.isPending}
                onSave={(categories) => {
                    patch({ piiDetectionCategories: categories });
                    setCategorySheet(false);
                }}
            />
        </Screen>
    );
}

function CategorySheet({
    visible,
    onClose,
    selected,
    saving,
    onSave,
}: {
    visible: boolean;
    onClose: () => void;
    selected: string[];
    saving: boolean;
    onSave: (categories: string[]) => void;
}) {
    const theme = useTheme();
    const [draft, setDraft] = useState<string[]>(selected);

    // Re-seed whenever the sheet opens: the stored list may have changed since
    // this component last rendered (another device, or a save that landed).
    const key = useMemo(() => selected.join('|'), [selected]);
    const [seededFor, setSeededFor] = useState(key);
    if (visible && seededFor !== key) {
        setSeededFor(key);
        setDraft(selected);
    }

    const toggle = (id: string) =>
        setDraft((previous) =>
            previous.includes(id) ? previous.filter((x) => x !== id) : [...previous, id],
        );

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title="What counts as personal data"
            subtitle={
                draft.length === 0
                    ? 'Nothing selected means everything'
                    : `${draft.length} categories`
            }
            footer={
                <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
                    <Button
                        label="Select all"
                        variant="ghost"
                        onPress={() => setDraft([])}
                        style={{ flex: 1 }}
                    />
                    <Button
                        label="Save"
                        onPress={() => onSave(draft)}
                        loading={saving}
                        style={{ flex: 1 }}
                    />
                </View>
            }
        >
            <View style={{ gap: theme.spacing.lg }}>
                <Text variant="caption" tone="tertiary">
                    {EMPTY_MEANS_ALL}
                </Text>
                {PII_GROUPS.map((group) => {
                    const items = PII_CATEGORIES.filter((c) => c.group === group);
                    if (items.length === 0) return null;
                    return (
                        <View key={group} style={{ gap: theme.spacing.sm }}>
                            <Text variant="label" tone="tertiary">
                                {group.toUpperCase()}
                            </Text>
                            <View
                                accessibilityRole="list"
                                style={{
                                    flexDirection: 'row',
                                    flexWrap: 'wrap',
                                    gap: theme.spacing.sm,
                                }}
                            >
                                {items.map((category) => (
                                    <Chip
                                        key={category.id}
                                        label={category.label}
                                        selected={draft.includes(category.id)}
                                        onPress={() => toggle(category.id)}
                                    />
                                ))}
                            </View>
                        </View>
                    );
                })}
            </View>
        </Sheet>
    );
}
