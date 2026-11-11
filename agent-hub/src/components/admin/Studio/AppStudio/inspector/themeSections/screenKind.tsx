import FormField from '@/components/shared/FormField';
import SegmentedControl from '@/components/shared/SegmentedControl';
import useTranslation from '@/hooks/useTranslation';
import { SectionTitle } from '../AiBrowsingSettings';
import { updateScreen } from '../../state/definitionOps';
import type { ThemeSectionEntry, ThemeSectionProps } from '../themeSections';

/**
 * screen.kind for the screen on the canvas: a page (the key absent) or a dashboard, which sits on
 * the recessed ground under soft or elevated surfaces. The definition had it, only templates set
 * it; choosing Page removes the key again.
 */
function ScreenKindSection({ definition, onCommit, disabled, screenId }: ThemeSectionProps) {
    const { t } = useTranslation();
    const screen = (definition?.screens || []).find((s) => s.id === screenId) || null;
    if (!screen) return null;
    const value = screen.kind === 'dashboard' ? 'dashboard' : 'page';
    const commit = (next: string) => {
        if (next === value) return;
        const def = updateScreen(definition, screen.id, { kind: next === 'dashboard' ? 'dashboard' : null });
        if (def !== definition) onCommit(def);
    };
    return (
        <div data-testid="screen-kind-settings">
            <SectionTitle>{t('studio_apps_sections.screen_kind.title', 'Screen layout')}</SectionTitle>
            <FormField label={t('studio_apps_sections.screen_kind.label', 'Kind of screen')} hint={t('studio_apps_sections.screen_kind.hint', 'A dashboard sits on the recessed ground so its cards stand out (with soft or elevated surfaces).')}>
                <SegmentedControl
                    value={value}
                    onChange={commit}
                    options={[
                        { value: 'page', label: t('studio_apps_sections.screen_kind.page', 'Page') },
                        { value: 'dashboard', label: t('studio_apps_sections.screen_kind.dashboard', 'Dashboard') },
                    ]}
                    size="sm"
                    fullWidth
                    disabled={disabled}
                    ariaLabel={t('studio_apps_sections.screen_kind.label', 'Kind of screen')}
                />
            </FormField>
        </div>
    );
}

const entry: ThemeSectionEntry = { order: 10, Section: ScreenKindSection };
export default entry;
