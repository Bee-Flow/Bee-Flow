/**
 * Create or edit a skill.
 *
 * The four text blocks (instructions, workflow, rules, examples) are separate
 * columns server-side and separate parts of the injected prompt, so they stay
 * separate fields here rather than being collapsed into one box — a person
 * editing on the phone must not silently flatten what they wrote on the web.
 * Only `instructions` is offered up front; the other three appear behind a
 * disclosure, because most skills only ever use the first one.
 *
 * The 4000-character cap is enforced by routes/skills.js on both POST and PUT
 * and applies to `instructions` alone. It is shown as a live count rather than
 * a hard input cap: truncating what someone pasted without telling them is
 * worse than letting them see they are 200 over and cut it themselves.
 *
 * The two switches were a local `FormToggle` — a copy of the settings
 * module's ToggleRow that existed only because this sheet supplies its own
 * horizontal padding and that row hard-coded a gutter. ToggleRow now takes
 * `gutter`, so the copy is gone.
 */

import React, { useState } from 'react';
import { Pressable, View } from 'react-native';

import { useTheme } from '../../../theme/ThemeProvider';
import { Button } from '../../../ui/Button';
import { ToggleRow } from '../../../ui/Controls';
import { describeError } from '../../../ui/Feedback';
import { TextField } from '../../../ui/Input';
import { Sheet } from '../../../ui/Sheet';
import { Text } from '../../../ui/Text';
import { SKILL_INSTRUCTIONS_MAX, emptyDraft, type SkillDraft } from '../types';

/**
 * The form seeds itself once, on mount. Callers therefore give it a `key` that
 * changes each time the sheet is opened — the alternative, re-seeding from an
 * effect when `visible` flips, both fights React's own advice and throws away
 * what the user is typing whenever the parent re-renders for its own reasons
 * (the list screen re-renders on every keystroke of its search field).
 */
export function SkillFormSheet({
    visible,
    initial,
    busy,
    error,
    canShare,
    onClose,
    onSubmit,
}: {
    visible: boolean;
    /** Undefined creates; a draft edits. */
    initial?: SkillDraft;
    busy: boolean;
    error: unknown;
    /** Sharing needs an organisation; a personal skill has nobody to share with. */
    canShare: boolean;
    onClose: () => void;
    onSubmit: (draft: SkillDraft) => void;
}) {
    const theme = useTheme();
    const [draft, setDraft] = useState<SkillDraft>(() => initial ?? emptyDraft());
    // Open the extra sections when the skill being edited already uses them —
    // otherwise they are hidden behind the disclosure and someone could save
    // without ever seeing what is in them.
    const [expanded, setExpanded] = useState(
        () => Boolean(initial && (initial.workflow || initial.rules || initial.examples)),
    );
    // A facet the draft does not carry at all is one the server holds in
    // STRUCTURED form (steps / rulesV2 / examplesV2) — draftFromSkill leaves it
    // out so this form's PUT cannot re-parse it and flatten what the Studio
    // laid down. It is therefore not offered as a field either: an empty box
    // saying "Workflow" over a skill that has one is a lie, and typing in it
    // would be the very overwrite the omission prevents.
    const structuredElsewhere = Boolean(initial)
        && (draft.workflow === undefined || draft.rules === undefined || draft.examples === undefined);

    const set = <K extends keyof SkillDraft>(key: K, value: SkillDraft[K]): void =>
        setDraft((prev) => ({ ...prev, [key]: value }));

    const over = draft.instructions.length - SKILL_INSTRUCTIONS_MAX;
    const nameOk = draft.name.trim().length > 0;

    return (
        <Sheet
            visible={visible}
            onClose={onClose}
            title={initial ? 'Edit skill' : 'New skill'}
            subtitle="A reusable set of instructions you can switch on for a chat"
        >
            <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
                <TextField
                    label="Icon"
                    value={draft.icon}
                    onChangeText={(v) => set('icon', v)}
                    placeholder="⚡"
                    maxLength={4}
                    containerStyle={{ width: 84 }}
                    accessibilityLabel="Icon, one emoji"
                />
                <TextField
                    label="Name"
                    value={draft.name}
                    onChangeText={(v) => set('name', v)}
                    placeholder="Sales tone"
                    autoFocus={!initial}
                    containerStyle={{ flex: 1 }}
                />
            </View>

            <TextField
                label="What is it for?"
                value={draft.description}
                onChangeText={(v) => set('description', v)}
                placeholder="How we write to prospects."
                hint="Shown in the library, and read by the model when it decides whether a “when relevant” skill applies."
            />

            <TextField
                label="Instructions"
                value={draft.instructions}
                onChangeText={(v) => set('instructions', v)}
                multiline
                maxLines={10}
                placeholder="Write in short sentences. Never promise a delivery date."
                error={over > 0 ? `${over} characters over the ${SKILL_INSTRUCTIONS_MAX} limit` : null}
                hint={
                    over > 0
                        ? undefined
                        : `${draft.instructions.length} of ${SKILL_INSTRUCTIONS_MAX} characters`
                }
            />

            <Pressable
                onPress={() => setExpanded((v) => !v)}
                accessibilityRole="button"
                accessibilityLabel={expanded ? 'Hide the extra sections' : 'Add workflow, rules and examples'}
                accessibilityState={{ expanded }}
                style={{ minHeight: theme.minTouch, justifyContent: 'center' }}
            >
                <Text variant="body" tone="accent">
                    {expanded ? 'Fewer sections' : 'Workflow, rules and examples'}
                </Text>
            </Pressable>

            {expanded ? (
                <>
                    {draft.workflow !== undefined ? (
                        <TextField
                            label="Workflow"
                            value={draft.workflow}
                            onChangeText={(v) => set('workflow', v)}
                            multiline
                            maxLines={6}
                            placeholder="1. Read the thread. 2. Draft. 3. Check the price list."
                        />
                    ) : null}
                    {draft.rules !== undefined ? (
                        <TextField
                            label="Rules"
                            value={draft.rules}
                            onChangeText={(v) => set('rules', v)}
                            multiline
                            maxLines={6}
                            placeholder="Never quote a discount above 10%."
                        />
                    ) : null}
                    {draft.examples !== undefined ? (
                        <TextField
                            label="Examples"
                            value={draft.examples}
                            onChangeText={(v) => set('examples', v)}
                            multiline
                            maxLines={6}
                            placeholder="Good: “I can have that with you on Thursday.”"
                        />
                    ) : null}
                    {structuredElsewhere ? (
                        <Text variant="caption" tone="tertiary">
                            Steps, rules or examples that were built in the Studio are edited there.
                            Saving here leaves them exactly as they are.
                        </Text>
                    ) : null}
                </>
            ) : null}

            <ToggleRow
                gutter={false}
                label="Load only when relevant"
                description="Off, the pack is added to every message. On, the model pulls it in when it fits — cheaper, but less certain."
                value={draft.dynamicActivation}
                onValueChange={(v) => set('dynamicActivation', v)}
            />

            {canShare ? (
                <ToggleRow
                    gutter={false}
                    label="Share with my organisation"
                    description="Colleagues can switch it on. They cannot edit it — only you can."
                    value={draft.isShared}
                    onValueChange={(v) => set('isShared', v)}
                />
            ) : null}

            {error ? (
                <Text variant="caption" tone="error" accessibilityLiveRegion="polite">
                    {describeError(error).message}
                </Text>
            ) : null}

            <Button
                label={initial ? 'Save changes' : 'Create skill'}
                fullWidth
                loading={busy}
                disabled={!nameOk || over > 0}
                onPress={() => onSubmit({ ...draft, name: draft.name.trim() })}
            />
        </Sheet>
    );
}
