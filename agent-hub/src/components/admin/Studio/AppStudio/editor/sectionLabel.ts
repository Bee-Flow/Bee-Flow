import { sectionName, sectionTitle } from '../runtime/sectionModel';
import type { TranslateFn } from '@/hooks/useTranslation';
import type { AppSection } from '../inspector/appDefinition';
import type { SectionModel } from '../runtime/sectionModel';

/** The label a builder knows a section by: its name, else its title, else "Section n". */
export function sectionLabel(section: AppSection, index: number, t: TranslateFn): string {
    const model = section as SectionModel;
    return sectionName(model) || sectionTitle(model) || t('studio_apps_sections.inspector.label', 'Section {n}', { n: index + 1 });
}
