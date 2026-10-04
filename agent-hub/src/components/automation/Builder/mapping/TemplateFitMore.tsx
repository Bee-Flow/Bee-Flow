import { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { useTranslation } from '../../../../hooks/useTranslation';
import { templateRemediesFor, type TemplateRemedy } from './templateRemedies';

/**
 * "More" under a text field, for the list, table or group that was just put
 * in it. Closed by default: the drop already wrote what reads well (a list
 * comma separated, a table one row per line, a group as "key: value"), so an
 * author who just drags never opens it. Open, it offers what else the value
 * can be — only the first, how many, one column, a separate run per item —
 * as plain buttons with what each one writes.
 */
interface Props {
    path: string;
    sampleRoot: unknown;
    allowForEach: boolean;
    onChoose: (r: TemplateRemedy) => void;
}

export default function TemplateFitMore({ path, sampleRoot, allowForEach, onChoose }: Props) {
    const { t } = useTranslation();
    const [open, setOpen] = useState(false);
    const remedies = templateRemediesFor(path, sampleRoot, { allowForEach });
    if (!remedies) return null;
    const choices = remedies.choices.filter(c => c.id !== remedies.currentId);
    if (!choices.length) return null;
    return (
        <div className="text-[11px] text-[var(--text-tertiary)]" data-testid="template-fit-more">
            <button
                type="button"
                onClick={() => setOpen(o => !o)}
                aria-expanded={open}
                aria-label={t('automations.template_fit.more_aria', 'More ways to use this value')}
                className="inline-flex items-center gap-1 hover:text-[var(--text-primary)]"
            >
                {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />}
                {t('automations.builder.value_more', 'More')}
            </button>
            {open && (
                <div className="mt-1 flex flex-col gap-0.5" role="group" aria-label={t('automations.template_fit.more_aria', 'More ways to use this value')}>
                    {choices.map(c => (
                        <button
                            key={c.id}
                            type="button"
                            onClick={() => { setOpen(false); onChoose(c); }}
                            className="flex items-baseline gap-2 text-left rounded px-1.5 py-0.5 hover:bg-[var(--bg-secondary)] hover:text-[var(--text-primary)]"
                        >
                            <span className="text-[var(--text-secondary)]">{t(c.labelKey, c.labelEn, c.labelParams)}</span>
                            {c.preview != null && c.preview !== '' && <span className="truncate font-mono text-[10px]">{c.preview}</span>}
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
}
