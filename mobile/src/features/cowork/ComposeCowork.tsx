/**
 * Delegate work by describing it — the AI chat that creates a Cowork schedule.
 *
 * The web's Cowork mode is exactly this: you type "stuur me elke maandag een
 * samenvatting van de week", the AI composer (POST /api/cowork/compose) turns
 * it into a title, a runnable instruction and a schedule, and one confirm
 * creates it. The phone had the Cowork tab but no way to CREATE one — the
 * endpoints were ported, the compose flow was not, so delegating still meant
 * walking to a desktop.
 *
 * The flow here mirrors agent-hub's useCoworkComposer, with one deliberate
 * addition: a CONFIRM SHEET between compose and create. The web shows When
 * and Repeat chips BEFORE you send, so by the time you hit enter you have
 * seen the schedule; the phone has no chips row, so the sheet is where you
 * see — and can refuse — what is about to run without you. A schedule must
 * never come into existence from one tap on a sentence the AI wrote.
 *
 * Two web rules kept verbatim:
 *   - A composer failure must never cost the user their work. If /compose
 *     fails, the confirm sheet offers their own words as the prompt and "Run
 *     now" as the schedule — which is what they got before the AI existed.
 *   - A composed time becomes the NEXT occurrence that has not happened yet
 *     (nextOccurrence), so a daily 08:00 job created at 09:00 starts
 *     tomorrow rather than firing immediately and again in the morning.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { composeCowork, coworkKeys, createSchedule, type ComposedCowork } from './api';
import {
    buildCoworkPayload,
    describeSchedule,
    nextOccurrence,
    repeatLabel,
    titleFromBrief,
} from './schedule';
import { useTheme } from '../../theme/ThemeProvider';
import { Button } from '../../ui/Button';
import { Sheet } from '../../ui/Sheet';
import { Text } from '../../ui/Text';
import { useToast } from '../../ui/Toast';

/** The web's own placeholder (CoworkComposer.jsx COWORK_PLACEHOLDER). */
const PLACEHOLDER = 'Describe the work — Bee Flow runs it and reports back';

/** Everything the confirm sheet needs to show, and the payload it would send. */
interface Proposal {
    title: string;
    prompt: string;
    scheduleSentence: string;
    repeat: string | null;
    payload: ReturnType<typeof buildCoworkPayload>;
}

/**
 * Turn a brief + the composer's answer into the create payload, mirroring the
 * web's submit step. Exported for the test — this derivation is where "every
 * Monday morning" either becomes next Monday 09:00 or quietly becomes now.
 */
export function proposalFrom(brief: string, spec: ComposedCowork | null): Proposal {
    const repeat = spec?.repeatInterval || null;
    const days = spec?.daysOfWeek ?? null;
    const runAt = spec?.timeOfDay ? nextOccurrence(spec.timeOfDay, days) : null;

    const payload = buildCoworkPayload({
        title: spec?.title || titleFromBrief(brief),
        prompt: spec?.prompt || brief,
        // With no composed time the work runs now — and, when it repeats, the
        // series is scheduled from the next interval (buildCoworkPayload's
        // startNow rule), so the user gets a result immediately without the
        // series drifting.
        presetId: 'now',
        runAt,
        repeatInterval: repeat,
        daysOfWeek: days,
        timeOfDay: spec?.timeOfDay ?? null,
        // The phone offers no tier picker here; an agent brings its own model
        // and agent-less work resolves server-side.
        modelTier: 'auto',
        agentId: spec?.agentId ?? null,
    });

    return {
        title: spec?.title || titleFromBrief(brief),
        prompt: spec?.prompt || brief,
        scheduleSentence: describeSchedule({
            presetId: runAt ? '' : 'now',
            runAt,
            repeatInterval: repeat,
        }),
        repeat,
        payload,
    };
}

export function ComposeCowork() {
    const theme = useTheme();
    const { toast } = useToast();
    const queryClient = useQueryClient();
    const [brief, setBrief] = useState('');
    const [proposal, setProposal] = useState<Proposal | null>(null);

    const compose = useMutation({
        mutationFn: async (text: string) => {
            // The web's degradation, kept: a compose failure falls back to the
            // user's own words rather than losing them.
            let spec: ComposedCowork | null = null;
            try {
                spec = await composeCowork(text);
            } catch {
                spec = null;
            }
            return proposalFrom(text, spec);
        },
        onSuccess: (p) => setProposal(p),
    });

    const create = useMutation({
        mutationFn: async (p: Proposal) => {
            if (!p.payload) throw new Error('Could not work out when this should run.');
            return createSchedule(p.payload);
        },
        onSuccess: () => {
            setProposal(null);
            setBrief('');
            void queryClient.invalidateQueries({ queryKey: coworkKeys.schedules });
            toast('Scheduled. It runs whether the app is open or not.');
        },
    });

    const canSend = brief.trim().length > 0 && !compose.isPending;

    return (
        <View
            style={{
                paddingHorizontal: theme.spacing.md,
                paddingTop: theme.spacing.sm,
            }}
        >
            {/* The same card grammar as the chat composer, minus the controls
                this surface has no use for. */}
            <View
                style={{
                    backgroundColor: theme.colors.bgCard,
                    borderRadius: theme.radii.xl,
                    borderWidth: StyleSheet.hairlineWidth,
                    borderColor: theme.colors.borderSubtle,
                    padding: theme.spacing.md,
                    gap: theme.spacing.sm,
                }}
            >
                <TextInput
                    value={brief}
                    onChangeText={setBrief}
                    placeholder={PLACEHOLDER}
                    placeholderTextColor={theme.colors.textMuted}
                    multiline
                    accessibilityLabel="Describe the work to delegate"
                    underlineColorAndroid="transparent"
                    style={[
                        theme.type.body,
                        {
                            color: theme.colors.textPrimary,
                            paddingTop: theme.spacing.xs,
                            paddingBottom: theme.spacing.sm,
                            maxHeight: theme.type.body.lineHeight * 5,
                        },
                    ]}
                />
                <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                    <Text variant="label" tone="tertiary" style={{ flex: 1 }}>
                        Now, later, or every week — say it in the sentence.
                    </Text>
                    <Pressable
                        onPress={() => compose.mutate(brief.trim())}
                        disabled={!canSend}
                        accessibilityRole="button"
                        accessibilityLabel="Work out the schedule"
                        style={{
                            width: 40,
                            height: 40,
                            borderRadius: theme.radii.pill,
                            alignItems: 'center',
                            justifyContent: 'center',
                            backgroundColor: canSend
                                ? theme.colors.accentFill
                                : theme.colors.bgTertiary,
                        }}
                    >
                        <Feather
                            name={compose.isPending ? 'loader' : 'arrow-up'}
                            size={20}
                            color={canSend ? theme.colors.accentFillFg : theme.colors.textMuted}
                        />
                    </Pressable>
                </View>
            </View>

            {/*
              * The confirm sheet — the moment of consent. Everything on it is
              * what WILL happen, not what was asked: the AI's title, the AI's
              * instruction, and the schedule as a sentence. One button
              * creates; closing the sheet creates nothing.
              */}
            <Sheet
                visible={Boolean(proposal)}
                onClose={() => setProposal(null)}
                title="Schedule this?"
            >
                {proposal ? (
                    <View style={{ gap: theme.spacing.lg }}>
                        <View style={{ gap: theme.spacing.xs }}>
                            <Text variant="subheading" weight="semibold">
                                {proposal.title}
                            </Text>
                            <View
                                style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
                            >
                                <Feather
                                    name="clock"
                                    size={14}
                                    color={theme.colors.accentText}
                                />
                                <Text variant="caption" tone="secondary">
                                    {proposal.scheduleSentence}
                                </Text>
                            </View>
                        </View>

                        <View
                            style={{
                                borderLeftWidth: 2,
                                borderLeftColor: theme.colors.borderSubtle,
                                paddingLeft: theme.spacing.md,
                            }}
                        >
                            <Text variant="caption" tone="tertiary" numberOfLines={6}>
                                {proposal.prompt}
                            </Text>
                        </View>

                        {create.isError ? (
                            <Text variant="caption" tone="error">
                                {(create.error as Error).message}
                            </Text>
                        ) : null}

                        <View style={{ gap: theme.spacing.sm }}>
                            <Button
                                label={
                                    proposal.repeat
                                        ? `Schedule it — ${repeatLabel(proposal.repeat).toLowerCase()}`
                                        : 'Schedule it'
                                }
                                onPress={() => create.mutate(proposal)}
                                loading={create.isPending}
                            />
                            <Button
                                label="Not this"
                                variant="ghost"
                                onPress={() => setProposal(null)}
                            />
                        </View>
                    </View>
                ) : null}
            </Sheet>
        </View>
    );
}
