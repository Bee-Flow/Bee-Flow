/**
 * Running a Studio app on a phone.
 *
 * The desktop renderer draws the whole component tree. This draws the half of
 * it that a phone can honestly own — fill in a form, press the button, read
 * what came back — and says plainly which components it left out. See
 * appDefinition.ts for why that boundary sits where it does.
 *
 * The run itself follows the bridge's contract exactly
 * (server/routes/studioAppsRun.js):
 *   200 { runId, status, output }        — finished inside the 60s wait
 *   202 { runId, status: 'pending' }     — still going; poll GET .../runs/:runId
 *   200 { status: 'skipped', message }   — the routine was already running
 * Only the 202 path polls, and it stops the moment the status settles, because
 * a forgotten interval on a phone is a battery complaint.
 */

import { Feather } from '@expo/vector-icons';
import { useMutation, useQuery } from '@tanstack/react-query';
import React, { useMemo, useState } from 'react';
import { Linking, View } from 'react-native';

import { useTranslation } from '../../../i18n';
import { useTheme } from '../../../theme/ThemeProvider';
import { Badge, Chip } from '../../../ui/Badge';
import { Button } from '../../../ui/Button';
import { Banner, Spinner, describeError } from '../../../ui/Feedback';
import { TextField } from '../../../ui/Input';
import { Card, Divider } from '../../../ui/Surface';
import { Text } from '../../../ui/Text';
import { getAppActionRun, runAppAction } from '../api';
import {
    initialValues,
    missingRequired,
    type AppBlock,
    type AppInput,
    type AppPlan,
    type RunnableAction,
} from '../appDefinition';
import { isLiveStatus, previewValue, statusLabel, statusToken } from '../format';
import { isPlain, parseInlineMarkdown } from '../inlineMarkdown';
import type { AppActionResult, AppFormValues } from '../types';
import { StatusIcon } from './StatusPill';

export function AppRunner({ appId, plan }: { appId: string; plan: AppPlan }) {
    const theme = useTheme();

    return (
        <View style={{ gap: theme.spacing.lg }}>
            {plan.blocks.map((block) => (
                <BlockView key={block.id} appId={appId} block={block} />
            ))}

            {plan.unsupported.length > 0 ? (
                <Banner tone="info" icon="monitor">
                    {`This screen also has ${plan.unsupported.join(', ')}. Those parts need the full app in a browser — everything above works here.`}
                </Banner>
            ) : null}
        </View>
    );
}

function BlockView({ appId, block }: { appId: string; block: AppBlock }) {
    const theme = useTheme();

    switch (block.kind) {
        case 'page_header':
            return (
                <View style={{ gap: 2 }}>
                    <Text variant="title" accessibilityRole="header">
                        {block.title}
                    </Text>
                    {block.subtitle ? (
                        <Text variant="caption" tone="tertiary">
                            <Inline text={block.subtitle} />
                        </Text>
                    ) : null}
                    {block.divider ? (
                        <View style={{ marginTop: theme.spacing.sm }}>
                            <Divider />
                        </View>
                    ) : null}
                </View>
            );
        case 'spacer':
            // Empty vertical space, which is what AppSpacer draws. This used to
            // be planned as a divider, so a spacer put a visible hairline rule
            // where the app intended a gap.
            return <View style={{ height: theme.spacing.md * Math.max(1, block.steps) }} />;
        case 'heading':
            return (
                <Text variant={block.level === 1 ? 'title' : 'heading'} accessibilityRole="header">
                    {block.text}
                </Text>
            );
        case 'text':
            return (
                <Text variant="body" tone={block.muted ? 'tertiary' : 'primary'}>
                    <Inline text={block.text} />
                </Text>
            );
        case 'callout':
            return (
                <Banner tone={calloutTone(block.tone)}>
                    <View style={{ gap: 2 }}>
                        {block.title ? (
                            <Text variant="caption" weight="semibold">
                                {block.title}
                            </Text>
                        ) : null}
                        <Text variant="caption">
                            <Inline text={block.body} />
                        </Text>
                    </View>
                </Banner>
            );
        case 'stat':
            return (
                <Card>
                    <Text variant="label" tone="tertiary">
                        {block.label.toUpperCase()}
                    </Text>
                    <Text variant="title">{block.value}</Text>
                </Card>
            );
        case 'divider':
            return <Divider />;
        case 'button':
            return (
                <Card>
                    <ActionRunner
                        appId={appId}
                        action={block.action}
                        label={block.action.label}
                        collect={() => ({})}
                    />
                </Card>
            );
        case 'form':
            return <FormCard appId={appId} block={block} />;
        default:
            return <View style={{ height: theme.spacing.xs }} />;
    }
}

/**
 * A markdown-subset string, drawn.
 *
 * `text` and `callout.body` are markdown-typed props per componentSpecs.js, and
 * the phone was printing them raw — so `**spoed**` reached the screen with its
 * asterisks. Nested inside a parent <Text>, so it inherits the parent's
 * variant and tone and only overrides weight, style and colour.
 */
function Inline({ text }: { text: string }) {
    const theme = useTheme();
    const spans = useMemo(() => parseInlineMarkdown(text), [text]);
    if (isPlain(spans)) return <>{text}</>;
    return (
        <>
            {spans.map((span, i) => (
                <Text
                    key={`${i}-${span.text}`}
                    style={{
                        fontWeight: span.bold ? '600' : undefined,
                        fontStyle: span.italic ? 'italic' : undefined,
                        color: span.href ? theme.colors.accentPrimary : undefined,
                        textDecorationLine: span.href ? 'underline' : undefined,
                    }}
                    onPress={span.href ? () => void Linking.openURL(span.href as string) : undefined}
                >
                    {span.text}
                </Text>
            ))}
        </>
    );
}

function FormCard({ appId, block }: { appId: string; block: Extract<AppBlock, { kind: 'form' }> }) {
    const theme = useTheme();
    const [values, setValues] = useState<AppFormValues>(() => initialValues(block.inputs));
    const [touched, setTouched] = useState(false);

    const missing = useMemo(() => missingRequired(block.inputs, values), [block.inputs, values]);

    return (
        <Card>
            <View style={{ gap: theme.spacing.lg }}>
                {block.title ? <Text variant="heading">{block.title}</Text> : null}

                {block.inputs.length === 0 ? (
                    <Text variant="caption" tone="tertiary">
                        This form has no fields the phone can fill in.
                    </Text>
                ) : (
                    block.inputs.map((input) => (
                        <InputField
                            key={input.node.id}
                            input={input}
                            value={values[input.name] ?? null}
                            showError={touched}
                            onChange={(next) =>
                                setValues((prev) => ({ ...prev, [input.name]: next }))
                            }
                        />
                    ))
                )}

                {block.action ? (
                    <ActionRunner
                        appId={appId}
                        action={block.action}
                        label={block.submitLabel}
                        blockedReason={missing.length ? `Still needed: ${missing.join(', ')}` : null}
                        onBlocked={() => setTouched(true)}
                        collect={() => values}
                    />
                ) : (
                    <Text variant="caption" tone="tertiary">
                        This form saves as you type on the desktop, and has no submit action of its
                        own.
                    </Text>
                )}
            </View>
        </Card>
    );
}

/**
 * The button, its run, and its result. Kept as one component because they are
 * one thing to the person pressing it: the result has to appear where the
 * button was, not in a separate panel they have to go and find.
 */
function ActionRunner({
    appId,
    action,
    label,
    blockedReason,
    onBlocked,
    collect,
}: {
    appId: string;
    action: RunnableAction;
    label: string;
    blockedReason?: string | null;
    onBlocked?: () => void;
    collect: () => AppFormValues;
}) {
    const theme = useTheme();
    const [result, setResult] = useState<AppActionResult | null>(null);

    const mutation = useMutation({
        mutationFn: () => runAppAction(appId, action.actionId, collect()),
        onSuccess: (data) => setResult(data),
    });

    // Only a 202 leaves a run id with an unsettled status; everything else is
    // already final and must not be polled.
    const pendingRunId =
        result?.runId && (result.status === 'pending' || isLiveStatus(result.status))
            ? result.runId
            : null;

    const poll = useQuery({
        queryKey: ['automate', 'app-run', appId, pendingRunId],
        queryFn: ({ signal }) => getAppActionRun(appId, pendingRunId as string, signal),
        enabled: Boolean(pendingRunId),
        refetchInterval: 3000,
        retry: false,
        // The poll is the live answer; a cached one would freeze the spinner.
        staleTime: 0,
    });

    const live = poll.data ?? result;
    const running = mutation.isPending || Boolean(pendingRunId);

    if (!action.runnable) {
        return (
            <View style={{ gap: theme.spacing.sm }}>
                <Button label={label} onPress={() => {}} disabled variant="secondary" fullWidth />
                <Text variant="caption" tone="tertiary">
                    {action.action.kind === 'sequence'
                        ? 'This button runs a multi-step sequence, which only the desktop app can drive.'
                        : `This button does “${action.action.kind}”, which the phone cannot run yet.`}
                </Text>
            </View>
        );
    }

    return (
        <View style={{ gap: theme.spacing.md }}>
            <Button
                label={label}
                fullWidth
                size="lg"
                loading={running}
                onPress={() => {
                    if (blockedReason) {
                        onBlocked?.();
                        return;
                    }
                    setResult(null);
                    mutation.mutate();
                }}
                accessibilityHint={blockedReason ?? undefined}
            />

            {blockedReason ? (
                <Text variant="caption" tone="warning" accessibilityLiveRegion="polite">
                    {blockedReason}
                </Text>
            ) : null}

            {mutation.isError ? (
                <Banner tone="error">{describeError(mutation.error).message}</Banner>
            ) : null}

            {live ? <ActionResult result={live} polling={Boolean(pendingRunId)} /> : null}
        </View>
    );
}

function ActionResult({ result, polling }: { result: AppActionResult; polling: boolean }) {
    const t = useTranslation();
    const theme = useTheme();
    const output = previewValue(result.output);

    if (result.status === 'skipped') {
        return <Banner tone="warning">{result.message ?? 'This routine was already running.'}</Banner>;
    }

    const token = statusToken(result.status === 'pending' ? 'running' : (result.status ?? 'idle'));

    return (
        <View
            accessibilityLiveRegion="polite"
            style={{
                gap: theme.spacing.sm,
                padding: theme.spacing.md,
                borderRadius: theme.radii.md,
                backgroundColor: theme.colors.bgTertiary,
            }}
        >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
                {polling ? <Spinner /> : <StatusIcon status={result.status ?? 'idle'} size={16} />}
                <Text variant="caption" weight="medium" style={{ flex: 1 }}>
                    {polling ? 'Still running…' : statusLabel(t, token)}
                </Text>
                {result.approvalId ? <Badge label="Needs approval" tone="warning" /> : null}
            </View>

            {result.error ? (
                <Text variant="caption" tone="error" selectable>
                    {result.error}
                </Text>
            ) : null}

            {output ? (
                <Text variant="code" tone="secondary" selectable>
                    {output}
                </Text>
            ) : !result.error && !polling ? (
                <Text variant="caption" tone="tertiary">
                    Finished with nothing to show.
                </Text>
            ) : null}
        </View>
    );
}

function InputField({
    input,
    value,
    showError,
    onChange,
}: {
    input: AppInput;
    value: string | number | boolean | null;
    showError: boolean;
    onChange: (next: string | number | boolean | null) => void;
}) {
    const theme = useTheme();
    const empty =
        input.type === 'input_checkbox'
            ? value !== true
            : value === null || value === undefined || String(value).trim() === '';
    const error = showError && input.required && empty ? 'This one is required.' : null;

    switch (input.type) {
        case 'input_checkbox':
            return (
                <Chip
                    label={input.label}
                    selected={value === true}
                    onPress={() => onChange(value !== true)}
                />
            );

        case 'input_select':
            return (
                <View style={{ gap: theme.spacing.sm }}>
                    <Text variant="caption" tone="secondary" weight="medium">
                        {input.label}
                        {input.required ? ' *' : ''}
                    </Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.sm }}>
                        {input.options.map((option) => (
                            <Chip
                                key={option.value}
                                label={option.label}
                                selected={value === option.value}
                                onPress={() => onChange(option.value)}
                            />
                        ))}
                    </View>
                    {error ? (
                        <Text variant="caption" tone="error" accessibilityLiveRegion="polite">
                            {error}
                        </Text>
                    ) : null}
                </View>
            );

        case 'input_number':
            return (
                <TextField
                    label={input.required ? `${input.label} *` : input.label}
                    value={value === null || value === undefined ? '' : String(value)}
                    onChangeText={(text) => {
                        const parsed = Number(text.replace(',', '.'));
                        onChange(text.trim() === '' ? null : Number.isNaN(parsed) ? text : parsed);
                    }}
                    keyboardType="numeric"
                    error={error}
                    hint={
                        input.min !== null || input.max !== null
                            ? `Between ${input.min ?? '−∞'} and ${input.max ?? '∞'}`
                            : undefined
                    }
                />
            );

        case 'input_date':
            return (
                <View style={{ gap: theme.spacing.sm }}>
                    <TextField
                        label={input.required ? `${input.label} *` : input.label}
                        value={value === null ? '' : String(value)}
                        onChangeText={(text) => onChange(text || null)}
                        placeholder="YYYY-MM-DD"
                        keyboardType="numbers-and-punctuation"
                        error={error}
                        hint="The app expects a date like 2026-08-29."
                    />
                    <Chip
                        label="Today"
                        onPress={() => onChange(new Date().toISOString().slice(0, 10))}
                    />
                </View>
            );

        case 'input_textarea':
            return (
                <TextField
                    label={input.required ? `${input.label} *` : input.label}
                    value={value === null ? '' : String(value)}
                    onChangeText={(text) => onChange(text || null)}
                    placeholder={input.placeholder ?? undefined}
                    multiline
                    maxLines={Math.min(8, Math.max(3, input.rows))}
                    error={error}
                />
            );

        case 'input_text':
        default:
            return (
                <TextField
                    label={input.required ? `${input.label} *` : input.label}
                    value={value === null ? '' : String(value)}
                    onChangeText={(text) => onChange(text || null)}
                    placeholder={input.placeholder ?? undefined}
                    keyboardType={
                        input.inputType === 'email'
                            ? 'email-address'
                            : input.inputType === 'url'
                              ? 'url'
                              : 'default'
                    }
                    autoCapitalize={input.inputType === 'text' ? 'sentences' : 'none'}
                    error={error}
                />
            );
    }
}

/** callout tones are info/success/warning/danger; Banner speaks four too. */
function calloutTone(tone: string): 'info' | 'success' | 'warning' | 'error' {
    if (tone === 'success') return 'success';
    if (tone === 'warning') return 'warning';
    if (tone === 'danger') return 'error';
    return 'info';
}

/** A Feather glyph for an app in a list. Named apps carry an icon string we
 *  cannot map one-for-one to Feather, so this is a stable neutral default. */
export const APP_ICON: keyof typeof Feather.glyphMap = 'layout';
