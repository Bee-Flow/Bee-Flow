import type { ServerMcpServer } from '../../../api/queries/serverMcp';
import { useTranslation } from '../../../hooks/useTranslation';
import { DOT_ERROR, DOT_LIVE, DOT_OFF, DOT_WARN } from '../ui';

/** A server-wide server's state as a dot and a word. */
export default function ServerStatus({ server }: { server: ServerMcpServer }) {
    const { t } = useTranslation();
    const [dot, ink, word] = !server.enabled
        ? [DOT_OFF, 'text-[var(--text-secondary)]', t('mcp_library.status.off', 'Off')]
        : server.status === 'ready'
            ? [DOT_LIVE, 'text-[var(--success-ink)]', t('mcp_library.status.ready', 'Ready')]
            : server.status === 'pending_credentials'
                ? [DOT_WARN, 'text-[var(--warning-ink)]', t('mcp_library.status.waiting_for_keys', 'Waiting for keys')]
                : server.status === 'error'
                    ? [DOT_ERROR, 'text-[var(--error-ink)]', t('mcp_library.status.error', 'Error')]
                    : [DOT_OFF, 'text-[var(--text-secondary)]', t('mcp_library.status.not_checked', 'Not checked')];
    return (
        <span className={`inline-flex items-center gap-1.5 text-[11px] font-medium ${ink}`}>
            <span className={dot} aria-hidden="true" />{word}
        </span>
    );
}
