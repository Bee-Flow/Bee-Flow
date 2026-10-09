/**
 * An app-event trigger: which app, which of its events, and that event's
 * filter — the web's AppEventFields and its per-event filter forms
 * (triggerEditors.jsx, triggerFilters.jsx). The app picker names what each
 * app can trigger on before you commit to it, as the web's provider picker
 * does; a fresh trigger snaps to the first app the catalog offers, once.
 */

import React, { useEffect, useRef } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { SelectField, type SelectOption } from '@/features/flow-editor/components/fields';
import { Text } from '@/shared/ui';

import { say } from '../declarative/runtime';
import { Note } from '../shared/Note';
import { SpecFields } from '../shared/SpecFields';
import { Warn } from '../shared/Warn';
import type { StepEditorProps } from '../types';
import { currentEvent, pickEvent, pickProvider, providerDefs, providerLabel, type ProviderDef } from './appEvent';
import { filterFormFor } from './filters';

function providerOptions(defs: readonly ProviderDef[], provider: string, t: ReturnType<typeof useTranslation>): SelectOption[] {
    const rows: SelectOption[] = defs.map((p) => ({
        value: p.id,
        label: p.label,
        description: p.events.map((e) => e.label).join(', ') || undefined,
    }));
    if (provider && !defs.some((p) => p.id === provider)) {
        rows.unshift({ value: provider, label: t('mobile.flow.trigger.provider_unavailable', '{name} (not available)', { name: providerLabel(provider, null) }) });
    }
    return rows;
}

function eventOptions(def: ProviderDef | null, event: string, t: ReturnType<typeof useTranslation>): SelectOption[] {
    const rows: SelectOption[] = (def?.events ?? []).map((e) => ({ value: e.id, label: e.label }));
    if (event && !rows.some((r) => r.value === event)) {
        rows.unshift({ value: event, label: def ? t('mobile.flow.trigger.event_unknown', '{event} (unknown event)', { event }) : event });
    }
    return rows;
}

export function AppEventFields(editor: StepEditorProps) {
    const t = useTranslation();
    const styles = useThemedStyles(makeStyles);
    const { draft, setMany, ctx } = editor;
    const defs = providerDefs(ctx.catalog);
    const provider = typeof draft.appProvider === 'string' ? draft.appProvider : '';
    const def = defs.find((p) => p.id === provider) ?? null;
    const event = currentEvent(draft, def);
    const selected = def?.events.find((e) => e.id === event) ?? null;
    const form = filterFormFor(provider, event);

    // One-shot snap: a fresh trigger starts with no app; take the first one the
    // catalog offers, once — a later clear back to nothing must not re-trigger it.
    const snapped = useRef(false);
    const firstId = defs[0]?.id;
    useEffect(() => {
        if (snapped.current || provider || !firstId || ctx.disabled) return;
        snapped.current = true;
        setMany(pickProvider(defs, firstId));
    });

    if (!provider && defs.length === 0) {
        return (
            <Note>
                {t(
                    'automations.trigger_editors.no_event_sources_are_available_to',
                    'No event sources are available to you yet. Connect an app (e.g. Gmail or Nextcloud) in Settings → Integrations first.',
                )}
            </Note>
        );
    }
    return (
        <>
            <SelectField
                label={t('automations.versions.setting.provider', 'App')}
                value={provider}
                options={providerOptions(defs, provider, t)}
                onChange={(next) => setMany(pickProvider(defs, next))}
                prompt={t('automations.form_builder_fields.choose_an_app', 'Choose an app…')}
                disabled={ctx.disabled}
                testID="trigger-app"
            />
            {provider && !def ? (
                <Warn>
                    {t(
                        'mobile.flow.trigger.app_unavailable',
                        "This app isn't available to you right now (integration not connected or not permitted for your account). The trigger is kept as configured, but it may not fire.",
                    )}
                </Warn>
            ) : null}
            <SelectField
                label={t('automation_editor.trigger.event', 'Event')}
                value={event}
                options={eventOptions(def, event, t)}
                onChange={(next) => setMany(pickEvent(next))}
                disabled={ctx.disabled}
                testID="trigger-event"
            />
            {selected?.deliverability === 'connector' ? (
                <Warn>
                    {selected.deliverabilityNote ||
                        t('mobile.flow.trigger.needs_connector', 'This event needs an extra connector that isn’t available yet — it will not fire.')}
                </Warn>
            ) : null}
            {form ? (
                <View style={styles.filter} testID="trigger-filter">
                    <Text variant="caption" weight="semibold" tone="secondary">
                        {say(t, form.title)}
                    </Text>
                    <SpecFields editor={editor} fields={form.fields} />
                </View>
            ) : null}
        </>
    );
}

const makeStyles = (theme: Theme) => ({
    filter: {
        gap: theme.spacing.md,
        padding: theme.spacing.md,
        borderRadius: theme.radii.md,
        borderWidth: 1,
        borderColor: theme.colors.borderSubtle,
    } satisfies ViewStyle,
});
