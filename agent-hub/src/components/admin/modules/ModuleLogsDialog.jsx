import { ScrollText, X } from 'lucide-react';
import React, { useState } from 'react';
import { useModuleLogs } from '../../../api/queries/modules';
import { useTranslation } from '../../../hooks/useTranslation';
import Modal from '../../shared/Modal';

// Live module log viewer (server-side ring buffer). Polls every 2s while open
// (the useModuleLogs hook owns the interval); level filter is server-side.

const LEVELS = ['debug', 'info', 'warn', 'error'];

const LEVEL_COLOR = {
    debug: 'var(--text-muted)',
    info: 'var(--text-secondary)',
    warn: '#f59e0b',
    error: '#ef4444',
};

function formatTs(ts) {
    try {
        const d = new Date(ts);
        if (Number.isNaN(d.getTime())) return String(ts);
        return d.toLocaleTimeString(undefined, { hour12: false });
    } catch {
        return String(ts);
    }
}

export default function ModuleLogsDialog({ module, onClose }) {
    const { t } = useTranslation();
    const [level, setLevel] = useState('');
    const logsQuery = useModuleLogs(module.id, { level: level || null });
    const logs = logsQuery.data?.logs || [];
    const replica = logsQuery.data?.replica;

    return (
        <Modal
            open
            onClose={onClose}
            size="xl"
            data-testid="module-logs-dialog"
            // Above the detail drawer this opens from.
            zIndex={60}
            title={
                <span className="flex items-center gap-2 min-w-0">
                    <ScrollText className="w-4 h-4 flex-shrink-0" style={{ color: '#f59e0b' }} aria-hidden="true" />
                    <span className="truncate">{t('modules.logs_title', { name: module.name || module.id })}</span>
                </span>
            }
            headerActions={
                <div className="flex items-center gap-2">
                    <select
                        value={level}
                        onChange={(e) => setLevel(e.target.value)}
                        aria-label={t('modules.logs_level_all')}
                        className="text-xs rounded-lg border px-2 py-1 outline-none"
                        style={{ background: 'var(--bg-primary)', color: 'var(--text-primary)', borderColor: 'var(--border-default)' }}
                    >
                        <option value="">{t('modules.logs_level_all')}</option>
                        {LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                    </select>
                    <button onClick={onClose} className="p-1 rounded hover:bg-[var(--bg-tertiary)]" aria-label={t('modules.close')}>
                        <X className="w-4 h-4" style={{ color: 'var(--text-muted)' }} />
                    </button>
                </div>
            }
            footer={replica ? (
                <div className="flex-1 text-[10px]" style={{ color: 'var(--text-muted)' }}>
                    {t('modules.logs_replica', { replica })}
                </div>
            ) : null}
        >
            <div className="font-mono text-xs rounded-lg px-3 py-2" style={{ background: 'var(--bg-primary)' }}>
                {logs.length === 0 ? (
                    <p style={{ color: 'var(--text-muted)' }}>{t('modules.logs_empty')}</p>
                ) : (
                    logs.map((row) => (
                        <div key={row.seq} className="flex gap-2 py-0.5 leading-relaxed">
                            <span className="flex-shrink-0" style={{ color: 'var(--text-muted)' }}>{formatTs(row.ts)}</span>
                            <span className="flex-shrink-0 uppercase w-12" style={{ color: LEVEL_COLOR[row.level] || 'var(--text-secondary)' }}>
                                {row.level}
                            </span>
                            <span className="whitespace-pre-wrap break-all" style={{ color: 'var(--text-primary)' }}>{row.msg}</span>
                        </div>
                    ))
                )}
            </div>
        </Modal>
    );
}
