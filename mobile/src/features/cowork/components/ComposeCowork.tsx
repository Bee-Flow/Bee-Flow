/**
 * Delegate work by describing it — the AI chat that creates a Cowork schedule.
 *
 * The web's Cowork mode is exactly this: you type "stuur me elke maandag een
 * samenvatting van de week", the AI composer (POST /api/cowork/compose) turns
 * it into a title, a runnable instruction and a schedule, and one confirm
 * creates it.
 *
 * The flow mirrors agent-hub's useCoworkComposer, with one deliberate
 * addition: a CONFIRM SHEET between compose and create. The web shows When
 * and Repeat chips BEFORE you send; the phone has no chips row, so the sheet
 * is where you see — and can refuse — what is about to run without you. A
 * schedule must never come into existence from one tap on a sentence the AI
 * wrote.
 *
 * Two web rules kept verbatim:
 *   - A composer failure must never cost the user their work. If /compose
 *     fails, the confirm sheet offers their own words as the prompt and "Run
 *     now" as the schedule — which is what they got before the AI existed.
 *   - A composed time becomes the NEXT occurrence that has not happened yet
 *     (nextOccurrence), so a daily 08:00 job created at 09:00 starts
 *     tomorrow rather than firing immediately and again in the morning.
 */

import React, { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { useTheme, useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { Icon, Text, useToast } from '@/shared/ui';

import { ConfirmCoworkSheet } from './ConfirmCoworkSheet';
import { useComposeCowork, useCreateSchedule } from '../hooks/mutations';
import type { Proposal } from '../model/proposal';

/** The web's own placeholder (CoworkComposer.jsx COWORK_PLACEHOLDER). */
const PLACEHOLDER = 'Describe the work — Bee Flow runs it and reports back';

const makeStyles = (theme: Theme) =>
    StyleSheet.create({
        root: { paddingHorizontal: theme.spacing.md, paddingTop: theme.spacing.sm },
        // The same card grammar as the chat composer, minus the controls this
        // surface has no use for.
        card: {
            backgroundColor: theme.colors.bgCard,
            borderRadius: theme.radii.xl,
            borderWidth: StyleSheet.hairlineWidth,
            borderColor: theme.colors.borderSubtle,
            padding: theme.spacing.md,
            gap: theme.spacing.sm,
        },
        input: {
            ...theme.type.body,
            color: theme.colors.textPrimary,
            paddingTop: theme.spacing.xs,
            paddingBottom: theme.spacing.sm,
            maxHeight: theme.type.body.lineHeight * 5,
        },
        footer: { flexDirection: 'row', alignItems: 'center' },
        hint: { flex: 1 },
        send: {
            width: 40,
            height: 40,
            borderRadius: theme.radii.pill,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.bgTertiary,
        },
        sendReady: { backgroundColor: theme.colors.accentFill },
    });

export function ComposeCowork() {
    const theme = useTheme();
    const styles = useThemedStyles(makeStyles);
    const { toast } = useToast();
    const [brief, setBrief] = useState('');
    const [proposal, setProposal] = useState<Proposal | null>(null);

    const compose = useComposeCowork(setProposal);
    const create = useCreateSchedule(() => {
        setProposal(null);
        setBrief('');
        toast('Scheduled. It runs whether the app is open or not.');
    });

    const canSend = brief.trim().length > 0 && !compose.isPending;

    return (
        <View style={styles.root}>
            <View style={styles.card}>
                <TextInput
                    value={brief}
                    onChangeText={setBrief}
                    placeholder={PLACEHOLDER}
                    placeholderTextColor={theme.colors.textMuted}
                    multiline
                    accessibilityLabel="Describe the work to delegate"
                    underlineColorAndroid="transparent"
                    style={styles.input}
                />
                <View style={styles.footer}>
                    <Text variant="label" tone="tertiary" style={styles.hint}>
                        Now, later, or every week — say it in the sentence.
                    </Text>
                    <Pressable
                        onPress={() => compose.mutate(brief.trim())}
                        disabled={!canSend}
                        accessibilityRole="button"
                        accessibilityLabel="Work out the schedule"
                        style={[styles.send, canSend ? styles.sendReady : null]}
                    >
                        <Icon
                            name={compose.isPending ? 'Loader' : 'ArrowUp'}
                            size={20}
                            color={canSend ? theme.colors.accentFillFg : theme.colors.textMuted}
                        />
                    </Pressable>
                </View>
            </View>

            <ConfirmCoworkSheet
                proposal={proposal}
                error={create.isError ? create.error : null}
                creating={create.isPending}
                onCreate={(p) => create.mutate(p)}
                onDismiss={() => setProposal(null)}
            />
        </View>
    );
}
