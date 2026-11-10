import { EyeOff, Rows3 } from 'lucide-react';
import { createPortal } from 'react-dom';
import useTranslation from '@/hooks/useTranslation';
import { sectionHasGate } from '../runtime/sectionModel';
import { sectionLabel } from './sectionLabel';
import './sectionChips.css';
import type { AppSection } from '../inspector/appDefinition';
import type { SectionModel } from '../runtime/sectionModel';

interface SectionChipsProps {
    sections: AppSection[];
    /** The renderer's <section data-section-id> elements, by section id (CanvasBody). */
    sectionEls: Map<string | null | undefined, Element>;
    selectedId: string | null;
    disabled: boolean;
    onSelect: (sectionId: string) => void;
}

/**
 * The canvas half of selecting a section: a small chip in the top-left corner of every section,
 * and a ring around the selected one. Both are portaled into the section element itself and
 * positioned absolutely, so they take no grid cell and the canvas keeps the running app's
 * layout. A section the previewed role cannot see has no element, and so no chip.
 */
export default function SectionChips({ sections, sectionEls, selectedId, disabled, onSelect }: SectionChipsProps) {
    const { t } = useTranslation();
    return (
        <>
            {sections.map((section, index) => {
                const id = section.id;
                const container = id ? sectionEls.get(id) : null;
                if (!id || !container) return null;
                const label = sectionLabel(section, index, t);
                const selected = id === selectedId;
                const gated = sectionHasGate(section as SectionModel);
                return createPortal(
                    <>
                        {selected ? <div className="ase-section-ring" aria-hidden="true" data-section-ring={id} /> : null}
                        <button
                            type="button"
                            className="ase-section-chip"
                            data-section-chip={id}
                            aria-pressed={selected}
                            aria-label={t('studio_apps_sections.chip.select', 'Select section {label}', { label })}
                            title={gated ? t('studio_apps_sections.chip.gated', 'Shown only to some viewers, or only when its rule holds') : label}
                            disabled={disabled}
                            onPointerDown={(e) => e.stopPropagation()}
                            onClick={(e) => {
                                e.stopPropagation();
                                onSelect(id);
                            }}
                        >
                            {gated ? <EyeOff aria-hidden="true" /> : <Rows3 aria-hidden="true" />}
                            <span>{label}</span>
                        </button>
                    </>,
                    container,
                    `chip-${id}`,
                );
            })}
        </>
    );
}
