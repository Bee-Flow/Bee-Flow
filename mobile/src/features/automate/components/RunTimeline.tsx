/**
 * A run's step-by-step history.
 *
 * This is the phone-native answer to the desktop canvas. The canvas shows you
 * a flow; a phone shows you what that flow DID, in order, with the clock and
 * the error attached to each node. The two are answering different questions,
 * which is why this is not a shrunken canvas.
 *
 * Three details come straight from the server and are worth naming:
 *   - The step list is the whole JOURNEY (getRunStepsForChain), so a routine
 *     that paused on a form and continued in a child run reads as one
 *     timeline rather than two with holes.
 *   - `definition` is the snapshot AS IT WAS at run time, so a step's label
 *     here is the label it had then — not today's, and not "unknown step".
 *   - `parentStepId` is non-null for sub-steps recorded inside a loop or a
 *     called Step, which is why rows indent instead of flattening.
 */

import { Feather } from '@expo/vector-icons';
import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useTranslation } from '../../../i18n';
import { useTheme } from '../../../theme/ThemeProvider';
import { Divider } from '../../../ui/Surface';
import { Text } from '../../../ui/Text';
import { describeValue, formatDuration, statusLabel, tokenForStep } from '../format';
import { ValuePreview } from './ValuePreview';
import type { AutomationDefinition, AutomationRunStep, AutomationStepDef } from '../types';
import { StatusIcon } from './StatusPill';
import { stepTypeName } from '../stepNames';

export function RunTimeline({
    steps,
    definition,
}: {
    steps: AutomationRunStep[];
    definition: AutomationDefinition | null;
}) {
    const theme = useTheme();
    const labels = useMemo(() => labelIndex(definition), [definition]);

    if (steps.length === 0) {
        return (
            <View style={{ padding: theme.spacing.lg }}>
                <Text variant="caption" tone="tertiary">
                    This run recorded no steps. That usually means it stopped at the trigger — the
                    run’s own error, above, is the whole story.
                </Text>
            </View>
        );
    }

    return (
        <View>
            {steps.map((step, index) => (
                <View key={`${step.runId}:${step.stepId}:${index}`}>
                    {index > 0 ? <Divider inset={theme.spacing.lg} /> : null}
                    <StepRow
                        step={step}
                        index={index}
                        label={labelFor(labels, step.stepId)}
                        nested={Boolean(step.parentStepId)}
                    />
                </View>
            ))}
        </View>
    );
}

function StepRow({
    step,
    index,
    label,
    nested,
}: {
    step: AutomationRunStep;
    index: number;
    label: string | null;
    nested: boolean;
}) {
    const t = useTranslation();
    const theme = useTheme();
    // The whole row, not just its status word: that is what separates a step
    // somebody switched off from one that ran and found nothing to do.
    const token = tokenForStep(step);
    const word = statusLabel(t, token);
    const failed = token.tone === 'error';
    // A failed step opens itself. Nobody taps a row to find out why something
    // broke when the answer could already be on screen.
    const [expanded, setExpanded] = useState(failed);

    const duration =
        step.startedAt && step.finishedAt
            ? new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime()
            : null;

    const title = label ?? step.stepId;
    // The RAW values travel to ValuePreview, which decides whether they are a
    // table, a record, a list or genuinely raw. Pre-stringifying here is what
    // made every output a JSON wall in the first place.
    const output = step.output;
    const input = step.input;
    const hasDetail = describeValue(output).kind !== 'empty' || describeValue(input).kind !== 'empty';

    return (
        <View>
            <Pressable
                onPress={hasDetail ? () => setExpanded((v) => !v) : undefined}
                disabled={!hasDetail}
                accessibilityRole={hasDetail ? 'button' : undefined}
                accessibilityState={{ expanded }}
                accessibilityLabel={`Step ${index + 1}, ${title}, ${word}${
                    failed && step.error ? `. Error: ${step.error}` : ''
                }`}
                accessibilityHint={hasDetail ? 'Shows what this step sent and received' : undefined}
                style={({ pressed }) => [
                    {
                        minHeight: 56,
                        flexDirection: 'row',
                        alignItems: 'flex-start',
                        gap: theme.spacing.md,
                        paddingVertical: theme.spacing.md,
                        paddingRight: theme.spacing.lg,
                        paddingLeft: theme.spacing.lg + (nested ? theme.spacing.xl : 0),
                        backgroundColor: pressed ? theme.colors.itemHoverBg : 'transparent',
                    },
                ]}
            >
                <View style={{ paddingTop: 2 }}>
                    <StatusIcon step={step} size={16} />
                </View>

                <View style={{ flex: 1, gap: 2 }}>
                    <View style={styles.titleRow}>
                        <Text variant="body" weight="medium" numberOfLines={2} style={{ flex: 1 }}>
                            {title}
                        </Text>
                        <Text variant="label" tone="tertiary">
                            {formatDuration(duration)}
                        </Text>
                    </View>

                    <Text variant="caption" tone="tertiary" numberOfLines={1}>
                        {[
                            // The engine's own identifier used to be printed
                            // here verbatim — "integration_action",
                            // "knowledge_write", "stop_error" — which is the
                            // one description of a step a phone shows at all,
                            // in a vocabulary the web builder spent a release
                            // getting off its canvas. Same run, two readings.
                            stepTypeName(step.stepType),
                            word,
                            (step.attempts ?? 1) > 1 ? `${step.attempts} attempts` : null,
                            step.branchIndex !== null ? `branch ${step.branchIndex + 1}` : null,
                        ]
                            .filter(Boolean)
                            .join(' · ')}
                    </Text>

                    {step.error ? (
                        <View
                            style={{
                                marginTop: theme.spacing.xs,
                                padding: theme.spacing.sm,
                                gap: theme.spacing.xs,
                                borderRadius: theme.radii.sm,
                                borderWidth: StyleSheet.hairlineWidth,
                                borderColor: theme.colors.error,
                                backgroundColor: theme.colors.itemHoverBg,
                            }}
                        >
                            <Text variant="caption" tone="error" selectable>
                                {step.error}
                            </Text>
                            {/* Only present on older Nextcloud rows; newer errors
                                already carry "<cause> — <remediation>" inline. */}
                            {step.errorRemediation ? (
                                <Text variant="caption" tone="warning">
                                    {step.errorRemediation}
                                </Text>
                            ) : null}
                            {step.errorClass ? (
                                <Text variant="label" tone="tertiary">
                                    {step.errorClass}
                                </Text>
                            ) : null}
                        </View>
                    ) : null}
                </View>

                {hasDetail ? (
                    <Feather
                        name={expanded ? 'chevron-up' : 'chevron-down'}
                        size={18}
                        color={theme.colors.textMuted}
                        style={{ marginTop: 4 }}
                    />
                ) : null}
            </Pressable>

            {expanded && hasDetail ? (
                <View
                    style={{
                        paddingLeft: theme.spacing.lg + (nested ? theme.spacing.xl : 0) + 28,
                        paddingRight: theme.spacing.lg,
                        paddingBottom: theme.spacing.lg,
                        gap: theme.spacing.md,
                    }}
                >
                    <ValuePreview label="Sent" value={input} />
                    <ValuePreview label="Received" value={output} />
                </View>
            ) : null}
        </View>
    );
}

// Same ceiling as the runner (server/core/automationRunner/shared.js): a
// deeper flowlet call fails there, so nothing below it is ever recorded.
const MAX_LAYER_DEPTH = 8;

/**
 * stepId → the label the flow gave it, walking nested bodies so a step inside
 * a loop is named too. Falls back to the step's own type, and finally to the
 * raw id — which is ugly but true, and better than "Step 4".
 *
 * A step inside a flowlet is recorded under its call step's id,
 * `<callId>/<innerId>`, one segment per level (BFSF-457), so the flowlet's
 * steps are indexed under that path. A layer already on the call path is not
 * entered again; the runner refuses that recursion too.
 */
function labelIndex(definition: AutomationDefinition | null): Map<string, string> {
    const out = new Map<string, string>();
    const layers = definition?.layers ?? {};
    const walk = (steps: AutomationStepDef[] | undefined, prefix: string, stack: string[]) => {
        for (const step of steps ?? []) {
            if (!step || typeof step.id !== 'string') continue;
            const name = step.label?.trim() || step.tool || step.type;
            if (name) out.set(`${prefix}${step.id}`, name);
            walk(step.body, prefix, stack);
            const key = step.type === 'call_layer' ? step.layerKey : null;
            if (key && !stack.includes(key) && stack.length < MAX_LAYER_DEPTH && layers[key]) {
                walk(layers[key]?.steps, `${prefix}${step.id}/`, [...stack, key]);
            }
        }
    };
    walk(definition?.steps, '', []);
    return out;
}

/**
 * The label for one recorded step id. A nested id the index does not know (a
 * published Step runs a definition that is not in the run's snapshot) reads
 * "<call step> › <inner id>" rather than the bare recorded path.
 */
function labelFor(labels: Map<string, string>, stepId: string): string | null {
    const known = labels.get(stepId);
    if (known) return known;
    const cut = stepId.lastIndexOf('/');
    if (cut <= 0) return null;
    const parent = stepId.slice(0, cut);
    return `${labelFor(labels, parent) ?? parent} › ${stepId.slice(cut + 1)}`;
}

const styles = StyleSheet.create({
    titleRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8 },
});
