import { Plus, Save } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useStudioSlaPoliciesQuery } from '@/api/queries/supportPanels';
import useDraftOverServer from '@/hooks/useDraftOverServer';
import type { SupportInbox, SupportKb } from './supportStudio.types';
import { INPUT_FIELD, PRIMARY_BTN, PRIMARY_BTN_STYLE, GHOST_BTN } from './supportStyles';
import useTranslation from '@/hooks/useTranslation';
import { API_BASE } from '@/utils/helpers';
import ConfigToggle from '@/components/shared/ConfigToggle';
import FormField from '@/components/shared/FormField';
import Section from '@/components/shared/Section';
import { mutate, errorBody, RefusedError, request } from '@/api/mutate';

const PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const SLA_DEFAULTS: Record<string, number[]> = { low: [480, 2880], normal: [240, 1440], high: [60, 480], urgent: [30, 240] };

/**
 * AutomationsTab — per-inbox "resolved tickets → knowledge base" ingestion plus
 * the organisation's SLA policies (which apply to every inbox).
 */
interface AutomationsTabProps {
    inbox: SupportInbox | null;
    kbs?: SupportKb[];
    onChanged: () => void;
}

export default function AutomationsTab({ inbox, kbs = [], onChanged }: AutomationsTabProps) {
    const { t } = useTranslation();
    return (
        <div className="max-w-3xl mx-auto py-6 px-4 space-y-4">
            {inbox && <KnowledgeIngestion inbox={inbox} kbs={kbs} onChanged={onChanged} />}
            <SlaPolicies />
        </div>
    );
}

interface KnowledgeIngestionProps {
    inbox: SupportInbox;
    kbs: SupportKb[];
    onChanged?: () => void;
}

function KnowledgeIngestion({ inbox, kbs, onChanged }: KnowledgeIngestionProps) {
    const { t } = useTranslation();
    const orgKbs = kbs.filter(kb => !kb.organization_id || !inbox.organization_id || kb.organization_id === inbox.organization_id);
    const [enabled, setEnabled] = useState(!!inbox.kb_ingest_enabled);
    const [kbId, setKbId] = useState(inbox.kb_ingest_kb_id || '');
    const [automationId, setAutomationId] = useState(inbox.kb_ingest_automation_id || null);
    const [newKbName, setNewKbName] = useState('');
    const [busy, setBusy] = useState(false);
    const [status, setStatus] = useState('');
    const [seenInboxId, setSeenInboxId] = useState(inbox.id);
    if (seenInboxId !== inbox.id) {
        setSeenInboxId(inbox.id);
        setEnabled(!!inbox.kb_ingest_enabled); setKbId(inbox.kb_ingest_kb_id || ''); setAutomationId(inbox.kb_ingest_automation_id || null);
    }

    const createKb = async () => {
        const name = newKbName.trim();
        if (!name) return;
        setBusy(true); setStatus('');
        try {
            let kb: { id?: string; error?: string };
            try {
                const res = await mutate(`${API_BASE}/api/kb`, {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, organizationId: inbox.organization_id }),
                });
                kb = await res.json().catch(() => ({}));
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                kb = errorBody(err) ?? {};
                kb.id = undefined;
            }
            if (!kb.id) { setStatus(kb.error || t('support.kb_ingest.create_failed', 'Could not create knowledge base')); return; }
            setKbId(kb.id); setNewKbName('');
        } finally { setBusy(false); }
    };

    const save = async () => {
        if (enabled && !kbId) { setStatus(t('support.kb_ingest.kb_required', 'Pick or create a knowledge base first.')); return; }
        setBusy(true); setStatus('');
        try {
            let res: Response;
            try {
                res = await mutate(`${API_BASE}/api/support-inbox/inboxes/${inbox.id}/kb-automation`, {
                method: 'PUT', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled, knowledgeBaseId: enabled ? kbId : null }),
            });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err;
                const d = errorBody(err) ?? {};
                setStatus(d.error || t('support.kb_ingest.save_failed', 'Could not save knowledge ingestion'));
                return;
            }
            const d = await res.json().catch(() => ({}));
            setAutomationId(d.automationId || (enabled ? automationId : null));
            setStatus(t('support.kb_ingest.saved', 'Knowledge ingestion saved.'));
            onChanged?.();
        } finally { setBusy(false); }
    };

    return (
        <Section padded title={t('support.kb_ingest.section_title', 'Knowledge ingestion')}
            description={t('support.kb_ingest.section_desc', 'Distil resolved tickets into a knowledge base so the AI keeps getting better.')}>
            <div className="space-y-3">
                <ConfigToggle id={`kb-enable-${inbox.id}`} checked={enabled} onChange={setEnabled}
                    label={t('support.kb_ingest.enable', 'Turn resolved tickets into knowledge-base articles')} />
                {enabled && (
                    <div className="space-y-3 pl-1">
                        <FormField label={t('support.kb_ingest.choose_kb', 'Knowledge base')}>
                            <select value={kbId} onChange={e => setKbId(e.target.value)} className={INPUT_FIELD}>
                                <option value="">{t('support.kb_ingest.none', 'Choose a knowledge base…')}</option>
                                {orgKbs.map(kb => <option key={kb.id} value={kb.id}>{kb.name}</option>)}
                            </select>
                        </FormField>
                        <div className="flex items-center gap-2">
                            <input value={newKbName} onChange={e => setNewKbName(e.target.value)} placeholder={t('support.kb_ingest.new_kb_placeholder', 'New knowledge base name')} className={`${INPUT_FIELD} flex-1`} />
                            <button onClick={createKb} disabled={busy || !newKbName.trim()} className={GHOST_BTN}>
                                <Plus size={12} /> {t('support.kb_ingest.create_new', 'Create new KB')}
                            </button>
                        </div>
                        {automationId && <span className="text-[11px] text-green-600 dark:text-green-400">{t('support.kb_ingest.automation_active', 'Automation active — resolved tickets are distilled into this knowledge base.')}</span>}
                    </div>
                )}
                <div className="flex items-center justify-between gap-3 pt-1">
                    <span className="text-[11px] text-[var(--text-tertiary)]">{status}</span>
                    <button onClick={save} disabled={busy} className={PRIMARY_BTN} style={PRIMARY_BTN_STYLE}>
                        <Save size={14} /> {busy ? t('support.common.saving', 'Saving…') : t('support.common.save', 'Save')}
                    </button>
                </div>
            </div>
        </Section>
    );
}

interface SlaRow {
    first?: number | string | null;
    resolution?: number | string | null;
    enabled?: boolean;
}

interface SlaPolicy {
    priority: string;
    first_response_minutes?: number | null;
    resolution_minutes?: number | null;
    enabled?: boolean;
}

function SlaPolicies() {
    const { t } = useTranslation();
    const slaQuery = useStudioSlaPoliciesQuery<SlaPolicy>();
    const serverRows = useMemo(() => {
        const map: Record<string, SlaRow> = {};
        (slaQuery.data ?? []).forEach((p: SlaPolicy) => { map[p.priority] = { first: p.first_response_minutes, resolution: p.resolution_minutes, enabled: p.enabled }; });
        return map;
    }, [slaQuery.data]);
    // The targets as typed: the server's rows with the unsaved edits laid over them.
    const { value: byPriority, patch: patchRows, discard } = useDraftOverServer(serverRows);
    const { refetch } = slaQuery;
    const [savingP, setSavingP] = useState<string | null>(null);

    const load = async () => { await refetch(); discard(); };

    const valueFor = (prio: string, key: 'first' | 'resolution') => {
        const row = byPriority[prio];
        if (row && row[key] != null) return row[key];
        return key === 'first' ? SLA_DEFAULTS[prio][0] : SLA_DEFAULTS[prio][1];
    };
    const setVal = (prio: string, key: 'first' | 'resolution', v: string) => patchRows({ [prio]: { ...(byPriority[prio] || {}), [key]: v } });

    const savePolicy = async (prio: string) => {
        setSavingP(prio);
        try {
            try {
                await mutate(`${API_BASE}/api/support-inbox/sla-policies`, {
                    method: 'PUT', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        priority: prio,
                        firstResponseMinutes: Number(valueFor(prio, 'first')),
                        resolutionMinutes: Number(valueFor(prio, 'resolution')),
                        enabled: byPriority[prio]?.enabled !== false,
                    }),
                });
            } catch (err) {
                if (!(err instanceof RefusedError)) throw err; // a refused save is re-read below, as before
            }
            await load();
        } finally { setSavingP(null); }
    };

    return (
        <Section padded title={t('support.sla.title', 'SLA policies')} description={t('support.sla.desc', 'Targets per priority. Applies to all inboxes in your organisation.')}>
            <div className="space-y-2">
                <div className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center text-[11px] text-[var(--text-tertiary)] px-1">
                    <span>{t('support.sla.priority', 'Priority')}</span>
                    <span>{t('support.sla.first', 'First response (min)')}</span>
                    <span>{t('support.sla.resolution', 'Resolution (min)')}</span>
                    <span />
                </div>
                {PRIORITIES.map(prio => (
                    <div key={prio} className="grid grid-cols-[1fr_auto_auto_auto] gap-2 items-center">
                        <span className="text-sm text-[var(--text-primary)] capitalize">{t(`support.priority.${prio}`, prio)}</span>
                        <input type="number" min={1} value={valueFor(prio, 'first')} onChange={e => setVal(prio, 'first', e.target.value)} className={`${INPUT_FIELD} w-24`} />
                        <input type="number" min={1} value={valueFor(prio, 'resolution')} onChange={e => setVal(prio, 'resolution', e.target.value)} className={`${INPUT_FIELD} w-24`} />
                        <button onClick={() => savePolicy(prio)} disabled={savingP === prio} className={GHOST_BTN}>
                            <Save size={12} /> {savingP === prio ? t('support.common.saving', 'Saving…') : t('support.common.save', 'Save')}
                        </button>
                    </div>
                ))}
            </div>
        </Section>
    );
}
