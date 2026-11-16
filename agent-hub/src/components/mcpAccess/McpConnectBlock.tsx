import { Check, Copy } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from '../../hooks/useTranslation';
import Tabs from '../shared/Tabs';
import toast from '../shared/Toast';
import { LABEL, QUIET_BTN } from '../shared/adminUi';
import { claudeAddCommand, type McpServerInfo } from './mcpAccessLib';
import { authHeader, clientConfigJson, serverUrl } from './mcpConnect';
import { useServerName } from './serverNames';

type ConnectTab = 'any' | 'cli';

const CODE = 'm-0 mt-1 px-3 py-2 rounded-lg border border-[var(--border-default)] bg-[var(--bg-secondary)] text-[11.5px] font-mono whitespace-pre-wrap break-all text-[var(--text-primary)]';

async function copyText(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        return false;
    }
}

/** One copyable line or block, with its label. */
function CopyRow({ id, label, text, copied, onCopy }: { id: string; label: string; text: string; copied: string | null; onCopy: (id: string, text: string) => void }) {
    const { t } = useTranslation();
    return (
        <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
                <div className="text-[11.5px] text-[var(--text-tertiary)]">{label}</div>
                <pre className={CODE}>{text}</pre>
            </div>
            <button type="button" className={QUIET_BTN} aria-label={t('admin_connections.mcp_copy', 'Copy: {what}', { what: label })} onClick={() => onCopy(id, text)}>
                {copied === id ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
            </button>
        </div>
    );
}

interface McpConnectBlockProps {
    servers: readonly McpServerInfo[];
    origin: string;
    /** The token itself (right after it was created), or a placeholder that shows the shape. */
    token: string;
    /** Draw the block's own label; off where a section heading already names it. */
    heading?: boolean;
}

/**
 * How to connect an MCP client to this server. The first tab works for any
 * client (the address of each server, the Authorization header, the JSON
 * block of a configuration file); the second, "Command-line client", the
 * ready-made command of one such client, named in its hint as an example.
 */
export default function McpConnectBlock({ servers, origin, token, heading = true }: McpConnectBlockProps) {
    const { t } = useTranslation();
    const serverName = useServerName();
    const [tab, setTab] = useState<ConnectTab>('any');
    const [copied, setCopied] = useState<string | null>(null);

    const copy = async (what: string, text: string) => {
        if (await copyText(text)) {
            setCopied(what);
            toast.success(t('mcp_access.reveal.copied', 'Copied'));
        } else {
            toast.error(t('mcp_access.reveal.copy_failed', 'Copying failed. Select the text and copy it by hand.'));
        }
    };

    return (
        <div className="flex flex-col gap-3" data-testid="mcp-connect-block">
            {heading && <p className={`${LABEL} mb-0`}>{t('admin_connections.mcp_connect_title', 'Connect an MCP client')}</p>}
            <Tabs
                value={tab}
                onChange={setTab}
                size="sm"
                ariaLabel={t('admin_connections.mcp_connect_title', 'Connect an MCP client')}
                items={[
                    { id: 'any' as const, label: t('admin_connections.mcp_tab_any', 'Any MCP client') },
                    { id: 'cli' as const, label: t('mcp_access.reveal.commands', 'Command-line client') },
                ]}
            />
            {tab === 'any' ? (
                <div className="flex flex-col gap-2">
                    <p className="m-0 text-[12px] text-[var(--text-secondary)]">
                        {t('admin_connections.mcp_any_hint', 'Add each server to your client as a remote (HTTP) MCP server, and send the token in the Authorization header.')}
                    </p>
                    {servers.map(s => (
                        <CopyRow key={s.id} id={`url-${s.id}`} label={serverName(s.id)} text={serverUrl(s, origin)} copied={copied} onCopy={copy} />
                    ))}
                    <CopyRow id="header" label={t('admin_connections.mcp_header', 'Header')} text={authHeader(token)} copied={copied} onCopy={copy} />
                    <CopyRow id="json" label={t('admin_connections.mcp_config_file', 'Configuration file (JSON)')} text={clientConfigJson(servers, origin, token)} copied={copied} onCopy={copy} />
                </div>
            ) : (
                <div className="flex flex-col gap-2">
                    <p className="m-0 text-[12px] text-[var(--text-secondary)]">
                        {t('security_access.mcp_cli_hint', 'A ready-made command per server for a command-line client. The format is that of Claude Code; another client takes the same address and header.')}
                    </p>
                    {servers.map(s => (
                        <CopyRow key={s.id} id={`cmd-${s.id}`} label={serverName(s.id)} text={claudeAddCommand(s, origin, token)} copied={copied} onCopy={copy} />
                    ))}
                </div>
            )}
        </div>
    );
}
