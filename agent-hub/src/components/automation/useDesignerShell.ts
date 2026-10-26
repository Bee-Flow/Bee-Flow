import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { describeCron } from './Builder/flow/scheduleBuilderUtils';
import type { PatternOrigin } from './Builder/usePatternOrigin';
import { releaseStudioChrome } from '../../hooks/useStudioChrome';
import { toast } from '../shared/Toast';
import { errorMessage } from '../../utils/caughtError';
import type { QuickSwitcherItem } from '../admin/Studio/AutomationsStudio/QuickSwitcher';
import type { AutomationLibrary, AutomationListRow } from './useAutomationLibrary';

interface QuickSwitcherArgs {
    embedded: boolean;
    automations: AutomationListRow[];
    setBuilderInitialTab: (tab: string | null) => void;
    setBuilderStepId: (id: string | null) => void;
    setBuilderAutomationId: (id: string | null) => void;
    stepUrlAdoptedRef: RefObject<boolean>;
}

/** Cmd/Ctrl+K: the chord, the items it lists and the jump to the one picked. */
export function useQuickSwitcher({
    embedded, automations, setBuilderInitialTab, setBuilderStepId, setBuilderAutomationId, stepUrlAdoptedRef,
}: QuickSwitcherArgs) {
    const [quickSwitcherOpen, setQuickSwitcherOpen] = useState(false);

    useEffect(() => {
        if (!embedded) return;
        const onKey = (e: KeyboardEvent) => {
            const isModK = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
            if (!isModK) return;
            // Only intercept when no other modifier surface owns it (ignore
            // shift/alt combinations to leave room for browser shortcuts).
            if (e.shiftKey || e.altKey) return;
            e.preventDefault();
            setQuickSwitcherOpen(true);
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [embedded]);

    const quickSwitcherItems = useMemo<QuickSwitcherItem[]>(() => automations.map(it => ({
        id: it.id,
        kind: 'automation',
        kindLabel: 'Automation',
        title: it.title || 'Untitled automation',
        // Readable, not raw: `0 9 * * *` in a quick-switcher subtitle
        // helps nobody pick the right automation.
        subtitle: String(it.triggerType) + (it.scheduleCron ? ` · ${describeCron(String(it.scheduleCron))}` : ''),
    })), [automations]);

    const onPickFromSwitcher = useCallback((item: { id?: string }) => {
        setQuickSwitcherOpen(false);
        // Jumping to another automation leaves the previous one's builder state
        // (open run, forced tab, an open Step builder) behind — carrying any
        // of it across reads as the new automation misbehaving.
        setBuilderInitialTab(null);
        setBuilderStepId(null);
        stepUrlAdoptedRef.current = true;
        setBuilderAutomationId(item.id ?? null);
    }, [setBuilderAutomationId, setBuilderInitialTab, setBuilderStepId, stepUrlAdoptedRef]);

    return { quickSwitcherOpen, setQuickSwitcherOpen, quickSwitcherItems, onPickFromSwitcher };
}

/**
 * Keeps the Studio chrome in step with the builder: the editing signal goes up
 * (only the Automations builder asks for fullscreen chrome collapse, so editing
 * a regular automation keeps the Studio top-tabs visible), the flyout never
 * stays "open" once its only trigger is gone, and the menu is brought back when
 * the builder closes.
 */
export function useStudioChromeSync(
    automationEditing: boolean,
    onEditingChange: ((editing: boolean) => void) | undefined,
    setListFlyoutOpen: (open: boolean) => void,
) {
    useEffect(() => {
        onEditingChange?.(automationEditing);
        return () => { onEditingChange?.(false); };
    }, [automationEditing, onEditingChange]);

    // Never leave the flyout "open" in state once its only trigger (an open
    // builder) is gone — otherwise re-entering a builder later could flash it.
    useEffect(() => {
        if (!automationEditing) setListFlyoutOpen(false);
    }, [automationEditing, setListFlyoutOpen]);

    // The Studio menu (and browser fullscreen) may be hidden from inside the
    // builder; the list has to bring them back when the builder closes.
    useEffect(() => {
        if (!automationEditing) releaseStudioChrome();
    }, [automationEditing]);
    useEffect(() => releaseStudioChrome, []);
}

interface TemplateTemplate {
    id?: string;
    title?: string;
    description?: string | null;
    definition?: unknown;
}

function isTemplateReply(r: unknown): r is { template?: TemplateTemplate } {
    return typeof r === 'object' && r !== null;
}

/**
 * Create an automation from a gallery template and hand its id to `open`.
 * The new row is fetched into the list first, so the sidebar shows it as the
 * builder opens on it.
 */
export async function createFromTemplate(
    templateId: string,
    { automationApi, fetchAutomations, open }: {
        automationApi: AutomationLibrary['automationApi'];
        fetchAutomations: () => Promise<void>;
        open: (id: string) => void;
    },
) {
    try {
        const r: unknown = await automationApi.getTemplate(templateId);
        const tmpl = isTemplateReply(r) ? r.template : undefined;
        if (!tmpl) return;
        const created = await automationApi.createAutomation<{ automation?: { id?: string }; id?: string }>({
            title: tmpl.title,
            description: tmpl.description || null,
            definition: tmpl.definition || {},
            // v1 then reads "Created from template <title>" in Versions.
            templateId: tmpl.id || templateId,
        });
        await fetchAutomations();
        const newId = created?.automation?.id || created?.id;
        if (newId) open(newId);
    } catch (err) {
        console.warn('[AITasksDesigner] template pick failed:', errorMessage(err));
        toast.error(`Could not load template: ${errorMessage(err)}`);
    }
}

/**
 * Which pane the designer shows and what it was opened with: the open
 * automation or building block, the tab and chat seed a builder starts from,
 * the list filter and the flyout. The actions here only move that state.
 */
export function useDesignerState(automationsAllowed: boolean) {
    const [builderAutomationId, setBuilderAutomationId] = useState<string | null>(null); // null = list, string = open builder
    // Which tab the builder opens on (e.g. 'history' from a "View executions"
    // affordance). Consumed once on mount, then cleared.
    const [builderInitialTab, setBuilderInitialTab] = useState<string | null>(null);
    const [openingBuilder, setOpeningBuilder] = useState(false);
    // A brand-new automation has no id in `builderAutomationId` (it stays '')
    // until BuilderShell lazily creates the row server-side. `liveAutomationId`
    // carries the id it reports back so the URL/refresh path can pick it up.
    const [liveAutomationId, setLiveAutomationId] = useState<string | null>(null);
    // Bumped every time the sidebar Plus opens a NEW builder. Part of the
    // BuilderShell `key`: a brand-new build keeps builderAutomationId === ''
    // for its whole life (the lazily-created id only lands in
    // liveAutomationId, deliberately never in the key), so WITHOUT the nonce
    // a second Plus while a new/just-finalized build is open re-used the same
    // 'new' key — no remount — and the previous flow's chat + draft bled into
    // the "new" automation.
    const [newBuilderNonce, setNewBuilderNonce] = useState(0);
    // Sidebar folders — org-wide, one level. Kept beside the list rather than
    // inside it: the list is per-user, the folders are shared.
    const [movingAutomation, setMovingAutomation] = useState<AutomationListRow | null>(null);
    const [presetChatInput, setPresetChatInput] = useState(''); // seeded from EmptyState examples
    const [autoSendInput, setAutoSendInput] = useState<string | null>(null); // "Build it directly" — auto-fire this spec in a fresh builder
    // The "Find repeating work" pattern a fresh builder was opened from, so
    // the builder can record `built` once that build is done. Cleared with
    // the two inputs above whenever a builder opens for anything else.
    const [patternOrigin, setPatternOrigin] = useState<PatternOrigin | null>(null);
    // Reusable Steps (kind='block') — own builder + own list. Always available
    // wherever automations are (no separate feature flag).
    const [builderStepId, setBuilderStepId] = useState<string | null>(null); // null=list · ''=new · id=editing
    // BFSF-404: the persistent sidebar is removed from the tree (not just
    // collapsed) the moment a builder is open — this flyout is the only
    // in-editor way back to the list + its per-item actions menu.
    const [listFlyoutOpen, setListFlyoutOpen] = useState(false);
    const [searchQuery, setSearchQuery] = useState('');
    // The flyout's filter takes the focus when it opens (Modal's initialFocus),
    // not the first control, the "+" button.
    const flyoutFilterRef = useRef<HTMLInputElement | null>(null);
    // Signal upward (Studio → AgentHub) when the BuilderShell is open so the
    // outer chrome can collapse for a fullscreen edit, mirroring AgentStudio.
    const automationEditing = builderAutomationId !== null || openingBuilder || builderStepId !== null;

    // The sidebar's plus button: a new automation.
    const onPlus = () => {
        if (!automationsAllowed) return;
        // The in-editor flyout offers this while a building block is
        // open, and an open Step builder outranks the automation pane.
        setBuilderStepId(null);
        setBuilderInitialTab(null);
        setBuilderAutomationId('');
        setPresetChatInput('');
        setAutoSendInput(null);
        setPatternOrigin(null);
        // Fresh mount for a fresh flow — never inherit the previous
        // build's conversation/draft (see newBuilderNonce above).
        setLiveAutomationId(null);
        setNewBuilderNonce(n => n + 1);
    };

    // Building blocks (reusable Steps) sit in the same list as the
    // automations, in their own group (owner, 2026-09-28; they had a tab
    // of their own before). Steps have no quick-switcher entry to model
    // on, so this mirrors its shape: clear the other builder's id first
    // so a block reliably takes over the right pane (the flyout can be
    // opened from an automation's builder), then swap in the target. ''
    // is a new one.
    const openBlock = (id: string, { runs = false }: { runs?: boolean } = {}) => {
        setListFlyoutOpen(false);
        setBuilderAutomationId(null);
        setOpeningBuilder(false);
        setBuilderInitialTab(runs ? 'history' : null);
        setBuilderStepId(id);
    };
    const onNewBlock = () => {
        if (!automationsAllowed) return;
        openBlock('');
    };

    return {
        builderAutomationId, setBuilderAutomationId, builderInitialTab, setBuilderInitialTab,
        openingBuilder, setOpeningBuilder, liveAutomationId, setLiveAutomationId, newBuilderNonce,
        movingAutomation, setMovingAutomation, presetChatInput, setPresetChatInput,
        autoSendInput, setAutoSendInput, patternOrigin, setPatternOrigin, builderStepId, setBuilderStepId,
        listFlyoutOpen, setListFlyoutOpen, searchQuery, setSearchQuery, flyoutFilterRef, automationEditing,
        onPlus, openBlock, onNewBlock,
    };
}

export type DesignerState = ReturnType<typeof useDesignerState>;
