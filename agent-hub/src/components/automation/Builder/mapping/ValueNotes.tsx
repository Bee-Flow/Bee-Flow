import { useTranslation } from '../../../../hooks/useTranslation';
import { AMBER_NOTE } from '../flow/settings/formStyles';

/**
 * Two one-line notes the value editors (BindingField, ValueBuilder) show under
 * a value that will not run the way it reads — each with the one click that
 * fixes it, in Simple mode too, where there is no Formula switch to reach for.
 */

/**
 * A plain-text value that IS a path (`steps.jira.output.fields["Story
 * Points"]` as text): the run sends those characters, not the value they name.
 * What an old Formula → Text flip used to leave behind.
 */
export function PathAsTextNote({ onUse }: { onUse: () => void }) {
    const { t } = useTranslation();
    return (
        <div className={`${AMBER_NOTE} flex items-center gap-2 flex-wrap`}>
            {t('automations.builder.path_as_text', 'This sends the path itself as text, not the value it points to.')}
            <button type="button" onClick={onUse} className="underline hover:no-underline">
                {t('automations.builder.use_its_value', 'Use its value')}
            </button>
        </div>
    );
}

/**
 * A structured value (a map of bindings, an object or a list) edited as JSON
 * text that is not valid JSON yet: nothing is saved until it is, because a
 * string in its place would hand the step binding descriptors, not values.
 */
export function JsonPendingNote({ onClear }: { onClear: () => void }) {
    const { t } = useTranslation();
    return (
        <div className={`${AMBER_NOTE} flex items-center gap-2 flex-wrap`}>
            {t('automations.builder.json_not_saved', 'This value is structured data: your change is saved as soon as it is valid JSON again.')}
            <button type="button" onClick={onClear} className="underline hover:no-underline">
                {t('automations.builder.clear_it', 'Clear it')}
            </button>
        </div>
    );
}
