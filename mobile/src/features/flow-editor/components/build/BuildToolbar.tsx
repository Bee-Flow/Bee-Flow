/**
 * The row under the build screen's header: Steps | Canvas as two icons, Undo,
 * Redo, then Ask AI, a test run and "more ways to run" — the web header's
 * history buttons, its assistant and its split Run button (RunFlowMenu).
 *
 * Every slot keeps its width whatever it shows: while a test runs, a spinner
 * stands where Run and its chevron were, so nothing to its left moves. The
 * autosave's words are the header's subline; a failed save is SaveBanner's.
 */

import React, { useState } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import { useDraftState } from '@/features/flow-editor/hooks';
import type { DraftStore } from '@/features/flow-editor/state';
import { Icon, IconButton, Segmented, Spinner } from '@/shared/ui';

import { RunMenu, type TestRuns } from '../run';

export type BuildTab = 'steps' | 'canvas';

/** The AI builder, when this screen has one (a flowlet's does not). */
export interface ToolbarAssistant {
    open: () => void;
    /** It is building into this routine. */
    busy: boolean;
}

const makeStyles = (theme: Theme) => ({
    bar: {
        flexDirection: 'row', alignItems: 'center', gap: theme.spacing[0.5], minHeight: 52,
        paddingLeft: theme.spacing[3], paddingRight: theme.spacing[1], backgroundColor: theme.colors.bgSecondary,
        borderBottomWidth: 1, borderBottomColor: theme.colors.borderSubtle,
    } satisfies ViewStyle,
    tabs: { marginRight: theme.spacing[1] } satisfies ViewStyle,
    spring: { flex: 1 } satisfies ViewStyle,
    tool: { width: 44 } satisfies ViewStyle,
    runSlot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', width: 84 } satisfies ViewStyle,
    chevron: { width: 36 } satisfies ViewStyle,
    glyph: { color: theme.colors.textSecondary },
    off: { color: theme.colors.textMuted },
});

type Styles = ReturnType<typeof makeStyles>;

function RunButtons({ runs, onMore, styles }: { runs: TestRuns; onMore: () => void; styles: Styles }) {
    const t = useTranslation();
    const start = runs.starts.find((s) => s.id === runs.from);
    if (runs.running) {
        return (
            <View style={styles.runSlot}>
                <Spinner />
            </View>
        );
    }
    return (
        <View style={styles.runSlot}>
            <IconButton
                style={styles.tool}
                icon={<Icon name="Play" size={20} color={styles.glyph.color} />}
                accessibilityLabel={t('mobile.flow.dry_run', 'Test run')}
                accessibilityHint={
                    runs.from && start
                        ? t('mobile.flow.dry_run_from_hint', 'Runs the flow from {name} with no real actions: a safe preview', { name: start.label })
                        : t('mobile.flow.dry_run_hint', 'Runs the flow with no real actions: a safe preview')
                }
                onPress={runs.dryRun}
            />
            <IconButton
                style={styles.chevron}
                icon={<Icon name="ChevronDown" size={18} color={styles.glyph.color} />}
                accessibilityLabel={t('routines.header.more_ways_to_run', 'More ways to run')}
                onPress={onMore}
                testID="run-more"
            />
        </View>
    );
}

export function BuildToolbar({
    store,
    tab,
    onTab,
    runs,
    onOpenStep,
    assistant = null,
}: {
    store: DraftStore;
    tab: BuildTab;
    onTab: (tab: BuildTab) => void;
    /** The routine's runs; null in a flowlet, which is run by the routine that calls it. */
    runs: TestRuns | null;
    /** Where Run live sends a form trigger that has nothing to run on. */
    onOpenStep: (stepId: string) => void;
    assistant?: ToolbarAssistant | null;
}) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const [menu, setMenu] = useState(false);
    const definition = useDraftState(store, (s) => s.definition);
    const canUndo = useDraftState(store, (s) => s.canUndo && !s.locked);
    const canRedo = useDraftState(store, (s) => s.canRedo && !s.locked);
    const glyph = (on: boolean) => (on ? styles.glyph.color : styles.off.color);
    const iconColour = (selected: boolean) => (selected ? styles.glyph.color : styles.off.color);
    return (
        <>
            <View style={styles.bar}>
                <View style={styles.tabs}>
                    <Segmented<BuildTab>
                        value={tab}
                        onChange={onTab}
                        iconOnly
                        accessibilityLabel={t('mobile.flow.view', 'View')}
                        options={[
                            { value: 'steps', label: t('mobile.flow.tab_steps', 'Steps'), icon: <Icon name="ListOrdered" size={18} color={iconColour(tab === 'steps')} /> },
                            { value: 'canvas', label: t('mobile.flow.tab_canvas', 'Canvas'), icon: <Icon name="Workflow" size={18} color={iconColour(tab === 'canvas')} /> },
                        ]}
                    />
                </View>
                <IconButton
                    style={styles.tool}
                    icon={<Icon name="Undo2" size={20} color={glyph(canUndo)} />}
                    accessibilityLabel={t('app_studio.header.undo', 'Undo')}
                    accessibilityHint={t('mobile.flow.undo_hint', 'Takes back your last change here. It is not a saved version.')}
                    disabled={!canUndo}
                    onPress={() => store.getState().undo()}
                />
                <IconButton
                    style={styles.tool}
                    icon={<Icon name="Redo2" size={20} color={glyph(canRedo)} />}
                    accessibilityLabel={t('app_studio.header.redo', 'Redo')}
                    disabled={!canRedo}
                    onPress={() => store.getState().redo()}
                />
                <View style={styles.spring} />
                {assistant ? (
                    <IconButton
                        style={styles.tool}
                        icon={<Icon name="Sparkles" size={20} color={styles.glyph.color} />}
                        accessibilityLabel={t('mobile.flow.ai.title', 'Ask AI')}
                        accessibilityHint={assistant.busy ? t('routines.builder.act.building', 'Building') : undefined}
                        selected={assistant.busy}
                        onPress={assistant.open}
                        testID="build-ask-ai"
                    />
                ) : null}
                {runs ? <RunButtons runs={runs} onMore={() => setMenu(true)} styles={styles} /> : null}
            </View>
            {runs ? <RunMenu visible={menu} onClose={() => setMenu(false)} runs={runs} definition={definition} onOpenStep={onOpenStep} /> : null}
        </>
    );
}
