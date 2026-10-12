/**
 * The build screen's body: the toolbar, the run line, and the flow as the
 * Steps outline or the Canvas, with the findings pill over it. A flowlet's
 * screen draws the same body without runs and without the pill: a test run
 * and the findings belong to the automation.
 */

import React, { useState, type ReactNode } from 'react';
import { View, type ViewStyle } from 'react-native';

import { useTranslation } from '@/core/i18n';
import { useThemedStyles, type Theme } from '@/core/theme/ThemeProvider';
import type { FlowCatalog } from '@/features/flow-editor/api';
import { useDraftState, type FlowDraft } from '@/features/flow-editor/hooks';
import type { FlowDefinition } from '@/features/flow-editor/model';
import type { AddTarget } from '@/features/flow-editor/model/outline';
import { Banner } from '@/shared/ui';

import { BuildToolbar, type BuildTab, type ToolbarAssistant } from './BuildToolbar';
import { LocalDraftBanner } from './LocalDraftBanner';
import { SaveBanner } from './SaveBanner';
import type { useOutlineEditing } from './useOutlineEditing';
import { CanvasView } from '../canvas';
import type { CardContext } from '../outline/cardModel';
import { StepOutline } from '../outline/StepOutline';
import { RunBanner, type TestRuns } from '../run';

export type Editing = ReturnType<typeof useOutlineEditing>;

const makeStyles = (theme: Theme) => ({
    body: { flex: 1 } satisfies ViewStyle,
    hidden: { display: 'none' } satisfies ViewStyle,
    banner: { paddingHorizontal: theme.spacing[4], paddingBottom: theme.spacing[2] } satisfies ViewStyle,
});

function toggled(set: ReadonlySet<string>, key: string): ReadonlySet<string> {
    const next = new Set(set);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    return next;
}

export interface BuildBodyProps {
    draft: FlowDraft;
    definition: FlowDefinition;
    card: CardContext;
    catalog: FlowCatalog | null;
    editing: Editing;
    /** The automation's test runs; absent in a flowlet. */
    runs: TestRuns | null;
    onAdd: (target: AddTarget) => void;
    onOpen: (address: string) => void;
    onRunDetails: () => void;
    /** Floats over the flow: the findings pill. */
    overlay?: ReactNode;
    /** Under the save banners: saved changes that are not live yet (PublishBanner); absent in a flowlet. */
    banner?: ReactNode;
    /** The AI builder's toolbar button; absent in a flowlet. */
    assistant?: ToolbarAssistant | null;
}

export function BuildBody({ draft, definition, card, catalog, editing, runs, onAdd, onOpen, onRunDetails, overlay = null, banner = null, assistant = null }: BuildBodyProps) {
    const styles = useThemedStyles(makeStyles);
    const t = useTranslation();
    const locked = useDraftState(draft.store, (s) => s.locked);
    const [tab, setTab] = useState<BuildTab>('steps');
    const [canvasSeen, setCanvasSeen] = useState(false);
    const showTab = (next: BuildTab) => {
        if (next === 'canvas') setCanvasSeen(true);
        setTab(next);
    };
    const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
    const lockedBanner = locked ? (
        <View style={styles.banner}>
            <Banner tone="info">{t('automations.builder.edits_locked', 'The AI is building this automation — editing is paused until it finishes.')}</Banner>
        </View>
    ) : null;
    return (
        <>
            <BuildToolbar store={draft.store} tab={tab} onTab={showTab} runs={runs} onOpenStep={onOpen} assistant={assistant} />
            <LocalDraftBanner local={draft.local} />
            <SaveBanner store={draft.store} />
            {banner}
            {runs ? <RunBanner runs={runs} onOpenStep={onOpen} onDetails={onRunDetails} /> : null}
            <View style={styles.body}>
                {/* Both stay mounted once seen, the other one hidden: switching
                    back keeps the outline's scroll and the canvas's camera. */}
                <View style={tab === 'steps' ? styles.body : styles.hidden}>
                    <StepOutline
                        definition={definition}
                        card={card}
                        locked={locked}
                        collapsed={collapsed}
                        onOpen={onOpen}
                        onMenu={editing.openMenu}
                        onAdd={onAdd}
                        onToggleGroup={(key) => setCollapsed((prev) => toggled(prev, key))}
                        header={lockedBanner}
                    />
                </View>
                {canvasSeen ? (
                    <View style={tab === 'canvas' ? styles.body : styles.hidden}>
                        <CanvasView store={draft.store} onOpenStep={onOpen} card={card} onMenu={editing.openMenu} onAdd={onAdd} catalog={catalog} />
                    </View>
                ) : null}
                {overlay}
            </View>
        </>
    );
}
