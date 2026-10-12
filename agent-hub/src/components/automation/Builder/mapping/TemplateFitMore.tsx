import { useTranslation } from '../../../../hooks/useTranslation';
import { useFormMode } from '../flow/settings/formDensity';
import { templateRemediesFor, type TemplateRemedy } from './templateRemedies';

/**
 * The other ways to use the list, table or group just put in a text field.
 * The drop already wrote what reads well (a list comma separated, a table one
 * row per line, a group as "key: value"), so these are Advanced: shown inline
 * under the field in the Advanced mode, not at all in Simple. Each is a plain
 * button with what it writes: only the first, how many, one column, a
 * separate run per item.
 */
interface Props {
    path: string;
    sampleRoot: unknown;
    allowForEach: boolean;
    onChoose: (r: TemplateRemedy) => void;
}

export default function TemplateFitMore({ path, sampleRoot, allowForEach, onChoose }: Props) {
    const { t } = useTranslation();
    const advanced = useFormMode() !== 'simple';
    if (!advanced) return null;
    const remedies = templateRemediesFor(path, sampleRoot, { allowForEach });
    if (!remedies) return null;
    const choices = remedies.choices.filter(c => c.id !== remedies.currentId);
    if (!choices.length) return null;
    return (
        <div className="text-[11px] text-[var(--text-tertiary)]" data-testid="template-fit-more">
            <div role="group" aria-label={t('automations.template_fit.more_aria', 'More ways to use this value')} className="flex flex-col gap-0.5">
                <span>{t('automations.builder.use_it_as', 'Use it as:')}</span>
                {choices.map(c => (
                    <button
                        key={c.id}
                        type="button"
                        onClick={() => onChoose(c)}
                        className="flex items-baseline gap-2 text-left rounded px-1.5 py-0.5 hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                    >
                        <span className="text-[var(--text-secondary)]">{t(c.labelKey, c.labelEn, c.labelParams)}</span>
                        {c.preview != null && c.preview !== '' && <span className="truncate font-mono text-[10px]">{c.preview}</span>}
                    </button>
                ))}
            </div>
        </div>
    );
}
