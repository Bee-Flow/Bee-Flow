import { Copy, Rows3, Trash2 } from 'lucide-react';
import React, { useState } from 'react';
import ActionsSection from './ActionsSection';
import LogicSection from './logic/LogicSection';
import StudioScopeProvider from './logic/StudioScopeProvider';
import MultiInspector from './MultiInspector';
import { nodeLabel, nodeTypeLabel } from './nodeLabel';
import { getInspectorForType } from './registry';
import { TYPE_EVENT_LISTS } from './styleKnobMeta';
import StyleSection, { findSectionById } from './StyleSection';
import ThemePanel from './ThemePanel';
import useTranslation from '../../../../../hooks/useTranslation';
import ConfirmDialog from '../../../../shared/ConfirmDialog';
import IconButton from '../../../../shared/IconButton';
import { kindColorVar } from '../../../../shared/kindColors';
import SegmentedControl from '../../../../shared/SegmentedControl';
import AccordionSection from '../../../../automation/Builder/flow/AccordionSection';
import { getComponentEntry } from '../runtime/componentRegistry';
import { useAppEditor } from '../state/AppEditorContext';
import { findNode, duplicateNode, removeNode } from '../state/definitionOps';
import './panels'; // side effect: registers every per-type Content panel

/**
 * InspectorPanel — the fixed right-hand property inspector.
 *
 *   nothing selected      → ThemePanel (whole-app theme + meta + this screen)
 *   a section (sec_*)     → the section style knobs (padding/gap/background)
 *   a component node      → header (icon/label + Duplicate/Delete) and
 *                           Content / Style / Actions accordions
 *
 * Editing contract: every change builds nextDef via the pure definitionOps
 * and calls onCommit(nextDef) — this panel never dispatches definitions
 * itself. All inputs are disabled while the AI builder streams (streamLock).
 */
/**
 * The inspector header (Studio artboard 1b).
 *
 * The old one showed the component's TYPE as its heading — "Button" — which is
 * the single thing the author already knew, because they had just clicked the
 * button. What they could NOT tell from the canvas was which of four buttons
 * was selected. So the type moves up into a small eyebrow and the heading
 * becomes the component's own text.
 *
 * The 6px bar is the object-kind language (shared/kindColors): an App Studio
 * surface carries `--kind-app` down its leading edge, the same mark the app's
 * card and the editor header use. It is a var() reference, never a hex — the
 * AppStudio.noPurple source scan enforces exactly that.
 */
function InspectorHeader({ node, tab, onTab, onDuplicate, onDelete, disabled }) {
    const { t } = useTranslation();
    const entry = getComponentEntry(node.type);
    const TypeIcon = entry?.icon || null;
    const typeLabel = nodeTypeLabel(node);
    const title = nodeLabel(node);

    return (
        <header className="flex flex-col gap-2">
            <div className="flex items-start gap-2">
                <span
                    aria-hidden="true"
                    className="self-stretch shrink-0 rounded-full"
                    style={{ width: 6, background: kindColorVar('app') }}
                />
                {TypeIcon ? <TypeIcon className="w-4 h-4 mt-0.5 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" /> : null}
                <div className="min-w-0 flex-1">
                    {/* The eyebrow is not a heading: a screen reader moving by
                        heading should land on the component's NAME once, not on
                        its type and then its name. */}
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-secondary)] truncate">
                        {typeLabel}
                    </p>
                    <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate">
                        {title}
                    </h2>
                </div>
                {/* The canvas node toolbar carries these same two buttons, on
                    the same node, doing the same thing — so they share its two
                    keys rather than growing a second "Delete" in the same
                    namespace (I18N-CONVENTIES §1.3: an existing key is used,
                    not duplicated). */}
                <IconButton ariaLabel={t('app_studio.canvas.duplicate', 'Duplicate')} onClick={onDuplicate} disabled={disabled}>
                    <Copy />
                </IconButton>
                <IconButton ariaLabel={t('app_studio.canvas.delete', 'Delete')} variant="danger" disabled={disabled} onClick={onDelete}>
                    <Trash2 />
                </IconButton>
            </div>
            <SegmentedControl
                value={tab}
                onChange={onTab}
                options={[
                    { value: 'look', label: t('app_studio.inspector.tab_look', 'Look') },
                    { value: 'behaviour', label: t('app_studio.inspector.tab_behaviour', 'Behaviour') },
                ]}
                size="sm"
                fullWidth
                ariaLabel={t('app_studio.inspector.tabs_aria', 'What to edit')}
            />
        </header>
    );
}

export default function InspectorPanel({ onCommit, onTestActionResult }) {
    const { t } = useTranslation();
    const { appId, definition, screenId, selectedNodeId, selectedNodeIds, streamLock, dispatch } = useAppEditor();
    const disabled = !!streamLock;
    // Which half of the component is being edited. Look = Content + Style,
    // Behaviour = Actions + Logic. Sticky across selections on purpose: an
    // author wiring six buttons in a row should not have to re-open Behaviour
    // for each one.
    const [tab, setTab] = useState('look');
    const multiCount = selectedNodeIds instanceof Set ? selectedNodeIds.size : 0;
    // The confirm dialog remembers WHICH node it was opened for, so a stale
    // dialog can never delete a different node after the selection moves.
    const [confirmFor, setConfirmFor] = useState(null);
    const confirmDelete = confirmFor != null && confirmFor === selectedNodeId;

    // The panel does NOT own its width, border or scrollbar — AppEditorShell's
    // <aside> does. It used to render a second <aside> inside that one, so the
    // inspector was literally nested in itself: two borders, two scroll
    // containers, and two different widths (320px outside, w-80 inside) fighting
    // over the same column. Anything that resizes or collapses the panel has to
    // have exactly one place to do it.
    const shell = (children) => (
        <div className="h-full bg-[var(--bg-secondary)]">{children}</div>
    );

    if (!definition) return shell(null);

    // ── Multiple selected → compact multi-panel (shared knobs + bulk ops) ──
    if (multiCount > 1) {
        return shell(
            <MultiInspector
                definition={definition}
                ids={[...selectedNodeIds]}
                onCommit={onCommit}
                disabled={disabled}
                dispatch={dispatch}
            />,
        );
    }

    // ── Nothing selected → app theme ───────────────────────────────────────
    if (!selectedNodeId) {
        return shell(<ThemePanel definition={definition} onCommit={onCommit} disabled={disabled} screenId={screenId} />);
    }

    // ── Section selected → section style knobs ─────────────────────────────
    if (selectedNodeId.startsWith('sec_')) {
        const found = findSectionById(definition, selectedNodeId);
        if (!found) return shell(<ThemePanel definition={definition} onCommit={onCommit} disabled={disabled} screenId={screenId} />);
        return shell(
            <div className="p-4 flex flex-col gap-3">
                <header className="flex items-center gap-2">
                    <Rows3 className="w-4 h-4 shrink-0 text-[var(--text-tertiary)]" />
                    <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('app_studio.inspector.section', 'Section')}</h2>
                </header>
                <AccordionSection stepType="appstudio.section" sectionKey="style" title={t('app_studio.inspector.style', 'Style')} defaultOpen>
                    <StyleSection
                        definition={definition}
                        sectionId={selectedNodeId}
                        onCommit={onCommit}
                        disabled={disabled}
                    />
                </AccordionSection>
            </div>,
        );
    }

    // ── Component node selected ────────────────────────────────────────────
    const found = findNode(definition, selectedNodeId);
    if (!found) {
        return shell(<ThemePanel definition={definition} onCommit={onCommit} disabled={disabled} screenId={screenId} />);
    }
    const { node } = found;
    const entry = getComponentEntry(node.type);
    const ContentPanel = getInspectorForType(node.type);
    const hasChildren = Array.isArray(node.children) && node.children.length > 0;

    const onDuplicate = () => {
        const { def } = duplicateNode(definition, node.id);
        if (def !== definition) onCommit(def);
    };
    const doDelete = () => {
        setConfirmFor(null);
        const next = removeNode(definition, node.id);
        if (next !== definition) onCommit(next);
    };

    return shell(
        <div className="p-4 flex flex-col gap-3">
            <InspectorHeader
                node={node}
                tab={tab}
                onTab={setTab}
                onDuplicate={onDuplicate}
                onDelete={() => (hasChildren ? setConfirmFor(node.id) : doDelete())}
                disabled={disabled}
            />

            {/* The accordions inside each tab STAY. Two tabs is the coarse cut
                (what it looks like / what it does); the accordions are the fine
                one, and they carry a per-type open/closed memory that is worth
                keeping. */}
            {tab === 'look' ? (
                <>
                    {ContentPanel ? (
                        <AccordionSection stepType={`appstudio.${node.type}`} sectionKey="content" title={t('app_studio.inspector.content', 'Content')} defaultOpen>
                            {/* Binding/formula fields inside a content panel need the
                                Studio variable scope, or their picker has nothing in it. */}
                            <StudioScopeProvider definition={definition} node={node}>
                                <ContentPanel node={node} definition={definition} onCommit={onCommit} disabled={disabled} />
                            </StudioScopeProvider>
                        </AccordionSection>
                    ) : null}

                    <AccordionSection stepType={`appstudio.${node.type}`} sectionKey="style" title={t('app_studio.inspector.style', 'Style')} defaultOpen>
                        <StyleSection definition={definition} node={node} onCommit={onCommit} disabled={disabled} />
                    </AccordionSection>
                </>
            ) : (
                <>
                    {TYPE_EVENT_LISTS[node.type]?.length ? (
                        <AccordionSection stepType={`appstudio.${node.type}`} sectionKey="actions" title={t('app_studio.inspector.actions', 'Actions')} defaultOpen>
                            {/* Actions hold formulas too — navigate params, an AI step's
                                source — and this section had no scope around it, so
                                every picker inside it came up empty. */}
                            <StudioScopeProvider definition={definition} node={node}>
                                <ActionsSection
                                    node={node}
                                    definition={definition}
                                    onCommit={onCommit}
                                    onTestActionResult={onTestActionResult}
                                    disabled={disabled}
                                    // Needed to NAME this app in a routine made
                                    // from here (trigger.appRef) and in the link
                                    // that opens one. Absent = no back-pointer,
                                    // never a guessed one.
                                    appId={appId}
                                />
                            </StudioScopeProvider>
                        </AccordionSection>
                    ) : (
                        /* A type with no events is not "missing" its actions —
                           it has none to have. Saying so beats an empty tab
                           that reads as a loading failure. */
                        <p className="text-[11px] text-[var(--text-secondary)]">
                            {t('app_studio.inspector.no_events', 'This component has nothing to react to — it shows information rather than taking input.')}
                        </p>
                    )}

                    <AccordionSection stepType={`appstudio.${node.type}`} sectionKey="logic" title={t('app_studio.inspector.logic', 'Logic')}>
                        <LogicSection node={node} definition={definition} onCommit={onCommit} disabled={disabled} />
                    </AccordionSection>
                </>
            )}

            {/* Same question, same object, same confirm button as the canvas
                node chrome asks — so title and button reuse its keys. Only the
                description differs (this one does not count the children), and
                that one sentence is the inspector's own. */}
            <ConfirmDialog
                open={confirmDelete}
                title={t('app_studio.canvas.delete_one_title', 'Delete this {label}?', {
                    // Lower-case on purpose — it sits mid-sentence, which is why
                    // it is its own key and not app_studio.shell.component
                    // ("Component", the name of a thing).
                    label: entry?.label?.toLowerCase() || t('app_studio.inspector.component', 'component'),
                })}
                description={t('app_studio.inspector.delete_desc', 'It contains other components — everything inside it will be deleted too.')}
                confirmLabel={t('app_studio.canvas.delete', 'Delete')}
                destructive
                onConfirm={doDelete}
                onCancel={() => setConfirmFor(null)}
            />
        </div>,
    );
}
