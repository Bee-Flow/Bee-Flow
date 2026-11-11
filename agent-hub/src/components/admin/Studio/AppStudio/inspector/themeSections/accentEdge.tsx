import FormField from '@/components/shared/FormField';
import SegmentedControl from '@/components/shared/SegmentedControl';
import useTranslation from '@/hooks/useTranslation';
import { SectionTitle } from '../AiBrowsingSettings';
import { DESIGN_DEFAULTS } from '../../runtime/appDesign';
import { updateDesign } from '../../state/definitionOps';
import type { ThemeSectionEntry, ThemeSectionProps } from '../themeSections';

/**
 * design.accentEdge: the coloured stripe along callouts, stats, toned rows and cards, or none.
 * Committed the way the panel's own design fields are: the look becomes the author's own
 * (preset "custom"). Picking the value the app already shows changes nothing, so an app
 * without a design keeps none.
 */
function AccentEdgeSection({ definition, onCommit, disabled }: ThemeSectionProps) {
    const { t } = useTranslation();
    const design = (definition?.design || {}) as Record<string, unknown>;
    const value = design.accentEdge === 'none' ? 'none' : String(DESIGN_DEFAULTS.accentEdge || 'bar');
    const commit = (next: string) => {
        if (next === value) return;
        const def = updateDesign(definition, { ...design, accentEdge: next, preset: 'custom' });
        if (def !== definition) onCommit(def);
    };
    return (
        <div data-testid="accent-edge-settings">
            <SectionTitle>{t('studio_apps_sections.accent_edge.title', 'Accents')}</SectionTitle>
            <FormField label={t('studio_apps_sections.accent_edge.label', 'Accent edge')} hint={t('studio_apps_sections.accent_edge.hint', 'The coloured stripe along callouts, stats, toned rows and cards. None removes it everywhere; the tint and icons stay.')}>
                <SegmentedControl
                    value={value}
                    onChange={commit}
                    options={[
                        { value: 'bar', label: t('studio_apps_sections.accent_edge.bar', 'Bar') },
                        { value: 'none', label: t('studio_apps_sections.accent_edge.none', 'None') },
                    ]}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={t('studio_apps_sections.accent_edge.label', 'Accent edge')}
                />
            </FormField>
        </div>
    );
}

const entry: ThemeSectionEntry = { order: 20, Section: AccentEdgeSection };
export default entry;
