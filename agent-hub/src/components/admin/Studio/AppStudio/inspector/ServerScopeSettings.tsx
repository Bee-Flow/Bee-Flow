import useTranslation from '@/hooks/useTranslation';
import Toggle from '@/components/shared/Toggle';
import { SectionTitle } from './AiBrowsingSettings';
import { SERVER_SCOPE_WIDE } from '../state/serverScopeOps';

interface ServerScopeSettingsProps {
    /** `definition.serverScope`. */
    value: unknown;
    onCommit: (wide: boolean) => void;
    disabled?: boolean;
}

/**
 * What a step that runs on the server can read. Off (every app made before this existed): the screen's
 * params, the other forms and action results are empty there. On: the browser sends them with each such
 * step of a click, so a formula gives on the server what it gives on the screen.
 */
export function ServerScopeSettings({ value, onCommit, disabled }: ServerScopeSettingsProps) {
    const { t } = useTranslation();
    return (
        <div data-server-scope-settings="true">
            <SectionTitle>{t('studio_apps_server_scope.title', 'Server steps')}</SectionTitle>
            <div className="flex flex-col gap-3">
                <Toggle
                    label={t('studio_apps_server_scope.toggle', 'Let server steps read the screen, other forms and action results')}
                    checked={value === SERVER_SCOPE_WIDE}
                    onChange={onCommit}
                    disabled={disabled}
                    size="sm"
                    ariaLabel={t('studio_apps_server_scope.toggle', 'Let server steps read the screen, other forms and action results')}
                />
                <p className="text-xs text-[var(--text-muted)]">
                    {t('studio_apps_server_scope.explainer', 'A step that saves, sends or asks the AI runs on the server. Without this, a formula in such a step reads screen, forms and actions as empty. With it, the browser sends them along with the step. They are what the person on the screen entered, so use currentUser and roles, not these, to decide who may do something. A public page, a background action and the phone app do not send them.')}
                </p>
            </div>
        </div>
    );
}
