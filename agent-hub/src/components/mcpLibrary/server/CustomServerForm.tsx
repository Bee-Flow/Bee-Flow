import { CheckCircle2, Loader2, PlugZap, Plus, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import SegmentedControl from '../../shared/SegmentedControl';
import { useTestServerMcp } from '../../../api/queries/serverMcp';
import type { ServerMcpInstall } from '../../../api/queries/serverMcp';
import { CATEGORIES } from '../../../config/mcpCatalog';
import { useTranslation } from '../../../hooks/useTranslation';
import { errorText, toolCount } from '../libraryText';
import { ALERT_ERROR, HINT, INPUT, LABEL, PRIMARY_BTN, SECONDARY_BTN } from '../ui';

interface CustomServerFormProps {
    busy: boolean;
    onInstall: (input: ServerMcpInstall) => void;
}

const splitArgs = (s: string) => (s.trim() ? s.trim().split(/\s+/) : []);

/** A server-wide server that is in no catalogue: a command to run here, or a remote address. */
export default function CustomServerForm({ busy, onInstall }: CustomServerFormProps) {
    const { t } = useTranslation();
    const ids = { name: useId(), cmd: useId(), args: useId(), url: useId(), creds: useId(), cat: useId() };
    const test = useTestServerMcp();
    const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
    const [name, setName] = useState('');
    const [command, setCommand] = useState('');
    const [args, setArgs] = useState('');
    const [url, setUrl] = useState('');
    const [creds, setCreds] = useState('');
    const [category, setCategory] = useState('development');

    const target = transport === 'stdio' ? !!command.trim() : !!url.trim();
    const runTest = () => test.mutate({ transport, command: command.trim() || undefined, args: splitArgs(args), url: url.trim() || undefined });
    const install = () => onInstall({
        name: name.trim(),
        transport,
        command: transport === 'stdio' ? command.trim() : undefined,
        args: transport === 'stdio' ? splitArgs(args) : [],
        url: transport === 'http' ? url.trim() : undefined,
        category,
        required_credentials: creds.split(',').map(s => s.trim()).filter(Boolean).map(key => ({ key, label: key })),
        source: 'manual',
    });

    return (
        <div className="flex flex-col gap-3">
            <SegmentedControl
                size="sm"
                value={transport}
                onChange={v => { setTransport(v); test.reset(); }}
                ariaLabel={t('mcp_library.server.transport', 'Where it runs')}
                options={[
                    { value: 'stdio', label: t('mcp_library.server.transport_stdio', 'On this server (command)') },
                    { value: 'http', label: t('mcp_library.server.transport_http', 'Remote (https address)') },
                ]}
            />
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                    <label htmlFor={ids.name} className={LABEL}>{t('mcp_library.wizard.name', 'Name')}</label>
                    <input id={ids.name} className={INPUT} value={name} onChange={e => setName(e.target.value)} />
                </div>
                <div>
                    <label htmlFor={ids.cat} className={LABEL}>{t('mcp_library.server.category', 'Category')}</label>
                    <select id={ids.cat} className={INPUT} value={category} onChange={e => setCategory(e.target.value)}>
                        {CATEGORIES.filter((c: { id: string }) => c.id !== 'all').map((c: { id: string; label: string }) => (
                            <option key={c.id} value={c.id}>{c.label}</option>
                        ))}
                    </select>
                </div>
            </div>
            {transport === 'stdio' ? (
                <div className="grid grid-cols-1 sm:grid-cols-[10rem_1fr] gap-3">
                    <div>
                        <label htmlFor={ids.cmd} className={LABEL}>{t('mcp_library.server.command', 'Command')}</label>
                        <input id={ids.cmd} className={`${INPUT} font-mono`} value={command} onChange={e => { setCommand(e.target.value); test.reset(); }} placeholder={t('mcp_library.server.command_example', 'npx')} spellCheck={false} />
                    </div>
                    <div>
                        <label htmlFor={ids.args} className={LABEL}>{t('mcp_library.server.args', 'Arguments')}</label>
                        <input id={ids.args} className={`${INPUT} font-mono`} value={args} onChange={e => { setArgs(e.target.value); test.reset(); }} placeholder={t('mcp_library.server.args_example', '-y @vendor/mcp-server@1.2.3')} spellCheck={false} />
                    </div>
                    <p className={`${HINT} sm:col-span-2`}>{t('mcp_library.server.pin_hint', 'Pin an exact version (@1.2.3). An unpinned package runs whatever was published last, every time it starts.')}</p>
                </div>
            ) : (
                <div>
                    <label htmlFor={ids.url} className={LABEL}>{t('mcp_library.wizard.url', 'Server address')}</label>
                    <input id={ids.url} className={`${INPUT} font-mono`} value={url} onChange={e => { setUrl(e.target.value); test.reset(); }} placeholder={t('mcp_library.wizard.url_example', 'https://mcp.example.com/mcp')} spellCheck={false} />
                </div>
            )}
            <div>
                <label htmlFor={ids.creds} className={LABEL}>{t('mcp_library.server.member_key_names', 'Keys each member provides (optional)')}</label>
                <input id={ids.creds} className={`${INPUT} font-mono`} value={creds} onChange={e => setCreds(e.target.value)} placeholder={t('mcp_library.server.member_key_example', 'GITHUB_TOKEN, API_KEY')} spellCheck={false} />
                <p className={HINT}>{t('mcp_library.server.member_key_hint', 'Comma-separated environment variable names. Members fill them in under Settings → Connections.')}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
                <button type="button" className={SECONDARY_BTN} onClick={runTest} disabled={!target || test.isPending}>
                    {test.isPending ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <PlugZap size={13} aria-hidden="true" />}
                    {t('mcp_library.server.test', 'Test')}
                </button>
                <button type="button" className={PRIMARY_BTN} onClick={install} disabled={!target || !name.trim() || busy}>
                    {busy ? <Loader2 size={13} className="animate-spin" aria-hidden="true" /> : <Plus size={13} aria-hidden="true" />}
                    {t('mcp_library.server.install_one', 'Install')}
                </button>
                {test.data?.success && (
                    <span role="status" className="inline-flex items-center gap-1.5 text-[12px] font-medium text-[var(--success-ink)]">
                        <CheckCircle2 size={14} aria-hidden="true" />{t('mcp_library.wizard.connected', 'Connected · {tools}', { tools: toolCount(t, test.data.tools.length) })}
                    </span>
                )}
            </div>
            {(test.isError || (test.data && !test.data.success)) && (
                <div role="alert" className={ALERT_ERROR}>
                    <TriangleAlert size={14} className="mt-0.5 flex-shrink-0" aria-hidden="true" />
                    <span className="break-words">{test.isError ? errorText(t, test.error) : (test.data?.error || t('mcp_library.error.unreachable', 'The server could not be reached.'))}</span>
                </div>
            )}
        </div>
    );
}
