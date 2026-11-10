import { useTranslation } from '@/hooks/useTranslation';

/**
 * Whose connections a run uses, in one sentence. 'owner' is the default; with
 * definition.runPolicy.connections 'caller' a run someone else starts uses
 * that person's own (server: core/automationRunner/callerConnections.js).
 */
export default function ConnectionsNote({ callerMode }: { callerMode?: boolean }) {
    const { t } = useTranslation();
    return (
        <p className="text-[var(--text-secondary)] leading-4" data-testid="sharing-connections-note">
            {callerMode
                ? t('automations.sharing.connections_note_caller', 'A run someone else starts uses that person\'s own connections. Scheduled and automatic runs use the owner\'s.')
                : t('automations.sharing.connections_note', 'Runs use the owner\'s connections. Someone who can edit can add steps that read and send with them.')}
        </p>
    );
}
