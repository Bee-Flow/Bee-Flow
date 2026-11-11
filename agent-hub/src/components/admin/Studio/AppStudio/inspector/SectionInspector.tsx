import { ArrowDown, ArrowUp, Copy, Plus, Rows3, Trash2 } from 'lucide-react';
import { useState } from 'react';
import useTranslation, { type TranslateFn } from '@/hooks/useTranslation';
import ConfirmDialog from '@/components/shared/ConfirmDialog';
import FormField from '@/components/shared/FormField';
import IconButton from '@/components/shared/IconButton';
import SegmentedControl from '@/components/shared/SegmentedControl';
import Toggle from '@/components/shared/Toggle';
import AccordionSection from '@/components/automation/Builder/flow/AccordionSection';
import FormulaField from './logic/FormulaField';
import StudioScopeProvider from './logic/StudioScopeProvider';
import SectionThemeFields from './SectionThemeFields';
import StyleSection from './StyleSection';
import { TextField } from './panels/kit';
import { sectionLabel } from '../editor/sectionLabel';
import { useAppEditor } from '../state/AppEditorContext';
import { addSection, listDefinitionRoles } from '../state/definitionOps';
import {
    MAX_SECTIONS_PER_SCREEN, deleteSection, duplicateSection, moveSection, sectionPlace, updateSection,
} from '../state/structureOps';
import { sectionTitle } from '../runtime/sectionModel';
import type { AppDefinition, AppSection, FormulaRef } from './appDefinition';
import type { SectionModel } from '../runtime/sectionModel';

/** The width choices; '' is "inherit" (the key absent). */
const WIDTHS = ['', 'narrow', 'medium', 'wide', 'full'] as const;

interface SectionInspectorProps {
    definition: AppDefinition;
    section: AppSection;
    onCommit: (definition: AppDefinition) => void;
    disabled: boolean;
}

interface SectionPartProps extends SectionInspectorProps {
    t: TranslateFn;
    patch: (keys: Record<string, unknown>) => void;
}

const exprOf = (flag: unknown): string => {
    if (typeof flag === 'string') return flag;
    if (flag && typeof flag === 'object') return String((flag as FormulaRef).expr || '');
    return '';
};

const widthLabel = (t: TranslateFn, v: string): string => ({
    '': t('studio_apps_sections.inspector.width_inherit', 'Screen'),
    narrow: 'S',
    medium: 'M',
    wide: 'L',
    full: t('studio_apps_sections.inspector.width_full', 'Full'),
} as Record<string, string>)[v] || v;

/** Title, folding, editor name and width. */
function SectionLookFields({ section, disabled, t, patch }: SectionPartProps) {
    const model = section as SectionModel;
    const hasTitle = !!sectionTitle(model);
    return (
        <>
            <TextField
                label={t('studio_apps_sections.inspector.heading', 'Title')}
                hint={t('studio_apps_sections.inspector.heading_hint', 'A heading at the top of the section, seen by everyone who uses the app. Leave empty for none.')}
                value={typeof model.title === 'string' ? model.title : ''}
                onChange={(v) => patch({ title: v.trim() ? v : null })}
                placeholder={t('studio_apps_sections.inspector.heading_placeholder', 'e.g. Open orders')}
                disabled={disabled}
            />
            <Toggle
                label={t('studio_apps_sections.inspector.collapsible', 'Can be folded')}
                description={hasTitle
                    ? t('studio_apps_sections.inspector.collapsible_hint', 'The viewer clicks the title to fold the section away.')
                    : t('studio_apps_sections.inspector.collapsible_needs_title', 'Give the section a title first: the title is what folds it.')}
                checked={model.collapsible === true}
                onChange={(next) => patch({ collapsible: next ? true : null })}
                disabled={disabled || (!hasTitle && model.collapsible !== true)}
                size="sm"
            />
            <TextField
                label={t('studio_apps_sections.inspector.name', 'Name in the editor')}
                hint={t('studio_apps_sections.inspector.name_hint', 'Only builders see this, on the section chip.')}
                value={typeof model.name === 'string' ? model.name : ''}
                onChange={(v) => patch({ name: v.trim() ? v : null })}
                placeholder={t('studio_apps_sections.inspector.name_placeholder', 'e.g. Filters')}
                disabled={disabled}
            />
            <FormField label={t('studio_apps_sections.inspector.width', 'Width')} hint={t('studio_apps_sections.inspector.width_hint', "Cap this section and centre it. Screen and Full take the screen's own width.")}>
                <SegmentedControl
                    value={typeof model.maxWidth === 'string' && (WIDTHS as readonly string[]).includes(model.maxWidth) ? model.maxWidth : ''}
                    onChange={(v) => patch({ maxWidth: v || null })}
                    options={WIDTHS.map((v) => ({ value: v, label: widthLabel(t, v) }))}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={t('studio_apps_sections.inspector.width', 'Width')}
                />
            </FormField>
        </>
    );
}

/** visibleWhen and visibleToRoles. */
function SectionVisibilityFields({ definition, section, disabled, t, patch }: SectionPartProps) {
    const model = section as SectionModel;
    const roles = listDefinitionRoles(definition) as { id: string; name?: string }[];
    const gate = Array.isArray(model.visibleToRoles) ? (model.visibleToRoles as string[]) : [];
    const toggleRole = (id: string, on: boolean) => {
        const next = on ? [...new Set([...gate, id])] : gate.filter((r) => r !== id);
        patch({ visibleToRoles: next.length ? next : null });
    };
    return (
        <>
            <StudioScopeProvider definition={definition} node={null}>
                <FormulaField
                    label={t('studio_apps_sections.inspector.visible_when', 'Only show when')}
                    value={exprOf(model.visibleWhen)}
                    onChange={(expr: string) => patch({ visibleWhen: expr.trim() ? { kind: 'formula', expr } : null })}
                    definition={definition}
                    placeholder={t('studio_apps_sections.inspector.visible_when_placeholder', "e.g. vars.view == 'all'")}
                    expectsBoolean
                    ariaLabel={t('studio_apps_sections.inspector.visible_when', 'Only show when')}
                    disabled={disabled}
                />
            </StudioScopeProvider>
            <p className="text-[11px] text-[var(--text-secondary)]">
                {t('studio_apps_sections.inspector.visible_when_hint', 'A hidden section is left out of the running app. When the rule reads only variables, forms, the user or the screen, its data is not loaded either.')}
            </p>
            <FormField label={t('studio_apps_sections.inspector.roles', 'Visible to')} hint={t('studio_apps_sections.inspector.roles_hint', 'Nothing ticked means everyone. The owner always sees it.')}>
                {roles.length ? (
                    <div className="flex flex-col gap-1" data-section-roles>
                        {roles.map((role) => (
                            <label key={role.id} className="flex items-center gap-2 text-xs text-[var(--text-primary)]">
                                <input
                                    type="checkbox"
                                    checked={gate.includes(role.id)}
                                    onChange={(e) => toggleRole(role.id, e.target.checked)}
                                    disabled={disabled}
                                />
                                {role.name || role.id}
                            </label>
                        ))}
                    </div>
                ) : (
                    <p className="text-[11px] text-[var(--text-secondary)]">{t('studio_apps_sections.inspector.roles_none', 'This app has no roles yet.')}</p>
                )}
            </FormField>
        </>
    );
}

/** The header: what the section is, and move / copy / delete / add below. */
function SectionHeader({ definition, section, onCommit, disabled, t }: Omit<SectionPartProps, 'patch'>) {
    const { dispatch } = useAppEditor();
    const [confirming, setConfirming] = useState(false);
    const id = section.id as string;
    const place = sectionPlace(definition, id);
    const index = place?.index ?? 0;
    const count = place?.count ?? 1;
    const full = count >= MAX_SECTIONS_PER_SCREEN;
    const commit = (next: AppDefinition, select: string | null = id) => {
        if (next === definition) return;
        onCommit(next);
        dispatch({ type: 'select_node', nodeId: select });
    };
    const remove = () => {
        setConfirming(false);
        commit(deleteSection(definition, id), null);
    };
    const childCount = (section.children || []).length;
    return (
        <header className="flex flex-col gap-2">
            <div className="flex items-center gap-1">
                <Rows3 className="w-4 h-4 shrink-0 text-[var(--text-tertiary)]" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                    <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('app_studio.inspector.section', 'Section')}</h2>
                    <p className="truncate text-[11px] text-[var(--text-secondary)]" data-section-inspector={id}>{sectionLabel(section, index, t)}</p>
                </div>
                <IconButton ariaLabel={t('studio_apps_sections.inspector.move_up', 'Move section up')} onClick={() => commit(moveSection(definition, id, index - 1))} disabled={disabled || index === 0}><ArrowUp /></IconButton>
                <IconButton ariaLabel={t('studio_apps_sections.inspector.move_down', 'Move section down')} onClick={() => commit(moveSection(definition, id, index + 1))} disabled={disabled || index >= count - 1}><ArrowDown /></IconButton>
                <IconButton ariaLabel={t('studio_apps_sections.inspector.duplicate', 'Duplicate section')} onClick={() => { const r = duplicateSection(definition, id); commit(r.def, r.sectionId); }} disabled={disabled || full}><Copy /></IconButton>
                <IconButton ariaLabel={t('studio_apps_sections.inspector.delete', 'Delete section')} variant="danger" onClick={() => (childCount ? setConfirming(true) : remove())} disabled={disabled}><Trash2 /></IconButton>
            </div>
            <button
                type="button"
                onClick={() => { const r = addSection(definition, place?.screenId, index + 1); if (r.sectionId) commit(r.def, r.sectionId); }}
                disabled={disabled || full}
                className="inline-flex items-center gap-1.5 self-start rounded-md px-2 py-1 text-xs font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('studio_apps_sections.inspector.add_below', 'Add a section below')}
            </button>
            <ConfirmDialog
                open={confirming}
                title={t('studio_apps_sections.inspector.delete_title', 'Delete this section?')}
                description={t('studio_apps_sections.inspector.delete_desc', 'Its {count} component(s) are deleted with it. You can undo this.', { count: childCount })}
                confirmLabel={t('studio_apps_sections.inspector.delete', 'Delete section')}
                destructive
                onConfirm={remove}
                onCancel={() => setConfirming(false)}
            />
        </header>
    );
}

/**
 * The inspector of a selected section (a sec_… id): the header with its order, copy and delete
 * buttons, its settings (the optional section keys: title, folding, editor name, width, the
 * visibility rule and roles) and its style knobs. Every change goes through the shared ops
 * (state/structureOps) and onCommit; a cleared field removes its key, so a section the author
 * leaves alone keeps exactly the keys it had.
 */
export default function SectionInspector(props: SectionInspectorProps) {
    const { t } = useTranslation();
    const { definition, section, onCommit, disabled } = props;
    const patch = (keys: Record<string, unknown>) => {
        const next = updateSection(definition, section.id as string, keys);
        if (next !== definition) onCommit(next);
    };
    const part = { ...props, t, patch };
    return (
        <div className="p-4 flex flex-col gap-3">
            <SectionHeader {...props} t={t} />
            <AccordionSection stepType="appstudio.section" sectionKey="settings" title={t('studio_apps_sections.inspector.settings', 'Settings')} defaultOpen>
                <div className="flex flex-col gap-3">
                    <SectionLookFields {...part} />
                    <SectionVisibilityFields {...part} />
                </div>
            </AccordionSection>
            <AccordionSection stepType="appstudio.section" sectionKey="theme" title={t('studio_apps_w3d.section_theme.title', 'Theme of this section')} defaultOpen={!!(section as { theme?: unknown }).theme}>
                <SectionThemeFields definition={definition} section={section} onCommit={onCommit} disabled={disabled} />
            </AccordionSection>
            <AccordionSection stepType="appstudio.section" sectionKey="style" title={t('app_studio.inspector.style', 'Style')} defaultOpen>
                <StyleSection definition={definition} sectionId={section.id as string} onCommit={onCommit} disabled={disabled} />
            </AccordionSection>
        </div>
    );
}
