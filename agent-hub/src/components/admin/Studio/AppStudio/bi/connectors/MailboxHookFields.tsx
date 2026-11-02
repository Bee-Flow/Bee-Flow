import { INPUT, LABEL } from './connectorModel';
import type { Connector } from './connectorModel';
import { hookActionOptions } from './mailboxHook';
import type { HookAction } from './mailboxHook';
import useTranslation from '@/hooks/useTranslation';

interface MailboxHookFieldsProps {
    connector: Connector;
    /** The app's actions (definition.actions); none when the editor has no definition. */
    actions?: Record<string, HookAction> | null;
    /** Several keys in one edit; `undefined` removes a key. */
    patch: (p: Record<string, unknown>) => void;
    disabled?: boolean;
}

/**
 * "When new mail arrives": pick the action that runs for each new row. An action with a
 * send_email step cannot be picked: nothing may mail on its own when a mail comes in.
 */
export default function MailboxHookFields({ connector, actions, patch, disabled }: MailboxHookFieldsProps) {
    const { t } = useTranslation();
    const options = hookActionOptions(actions);
    const hook = connector.onNewRecord || null;
    const threaded = connector.groupIntoThreads === true;
    const target = hook?.target === 'thread' && threaded ? 'thread' : 'inbound_message';

    const choose = (actionId: string) => patch({ onNewRecord: actionId ? { actionId, target } : undefined });
    const chooseTarget = (next: string) => hook?.actionId && patch({ onNewRecord: { actionId: hook.actionId, target: next } });

    return (
        <div className="flex flex-col gap-2 rounded-md border border-[var(--border-default)] p-2.5">
            <span className={LABEL}>{t('studio_apps_bi.connectors.hook_title', 'When new mail arrives')}</span>
            <div className="grid grid-cols-2 gap-2">
                <label className="flex flex-col gap-1">
                    <span className={LABEL}>{t('studio_apps_bi.connectors.hook_action', 'Run this action')}</span>
                    <select
                        className={INPUT}
                        value={hook?.actionId || ''}
                        onChange={(e) => choose(e.target.value)}
                        disabled={disabled}
                        aria-label={t('studio_apps_bi.connectors.hook_action', 'Run this action')}
                    >
                        <option value="">{t('studio_apps_bi.connectors.hook_none', 'Nothing (off)')}</option>
                        {options.map((o) => (
                            <option key={o.id} value={o.id} disabled={o.blocked && o.id !== hook?.actionId}>
                                {o.blocked ? t('studio_apps_bi.connectors.hook_blocked', '{id} (has a step that cannot run on its own)', { id: o.id }) : `${o.id}${o.summary ? ` · ${o.summary}` : ''}`}
                            </option>
                        ))}
                    </select>
                </label>
                <label className="flex flex-col gap-1">
                    <span className={LABEL}>{t('studio_apps_bi.connectors.hook_target', 'For each new')}</span>
                    <select
                        className={INPUT}
                        value={target}
                        onChange={(e) => chooseTarget(e.target.value)}
                        disabled={disabled || !hook?.actionId}
                        aria-label={t('studio_apps_bi.connectors.hook_target', 'For each new')}
                    >
                        {threaded ? <option value="thread">{t('studio_apps_bi.connectors.hook_target_thread', 'conversation')}</option> : null}
                        <option value="inbound_message">{t('studio_apps_bi.connectors.hook_target_message', 'incoming message')}</option>
                    </select>
                </label>
            </div>
            <p className="text-xs text-[var(--text-tertiary)]">
                {t('studio_apps_bi.connectors.hook_hint', 'Runs on the server as the app owner after a sync, with the new row as item. Only steps that run without a person are allowed: send_email is not, so nothing mails by itself. Mail already in the table is not processed, and runs are capped per sync and per minute.')}
            </p>
        </div>
    );
}
