import { Plus } from 'lucide-react';
import useTranslation from '@/hooks/useTranslation';
import { useAppEditor } from '../state/AppEditorContext';
import { addSection } from '../state/definitionOps';
import { MAX_SECTIONS_PER_SCREEN } from '../state/structureOps';
import type { RefObject } from 'react';
import type { AppDefinition, AppScreen } from '../inspector/appDefinition';

interface AddSectionButtonProps {
    screen: AppScreen | null;
    definitionRef: RefObject<AppDefinition | null>;
    onCommit: ((def: AppDefinition) => void) | undefined;
    disabled: boolean;
}

/**
 * "Add section" under the screen on the editor canvas: appends an empty section (the shared
 * addSection op, the same one app_add_section runs) and selects it, so its settings open in the
 * inspector. Outside the renderer's DOM, so the screen itself is laid out as in the running app.
 */
export default function AddSectionButton({ screen, definitionRef, onCommit, disabled }: AddSectionButtonProps) {
    const { t } = useTranslation();
    const { dispatch } = useAppEditor();
    if (!screen) return null;
    const full = (screen.sections || []).length >= MAX_SECTIONS_PER_SCREEN;
    const add = () => {
        const def = definitionRef.current;
        if (!def || full) return;
        const { def: next, sectionId } = addSection(def, screen.id);
        if (!sectionId) return;
        onCommit?.(next);
        dispatch({ type: 'select_node', nodeId: sectionId });
    };
    return (
        <div className="ase-add-section">
            <button
                type="button"
                data-add-section={screen.id}
                onClick={add}
                disabled={disabled || full}
                title={full ? t('studio_apps_sections.canvas.max', 'A screen holds at most {n} sections.', { n: MAX_SECTIONS_PER_SCREEN }) : undefined}
                className="inline-flex items-center gap-1.5 rounded-full border border-dashed px-3 py-1 text-xs font-medium border-[var(--border-default)] text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-50"
            >
                <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                {t('studio_apps_sections.canvas.add', 'Add section')}
            </button>
        </div>
    );
}
