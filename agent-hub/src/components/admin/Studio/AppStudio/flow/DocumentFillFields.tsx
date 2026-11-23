import { useEffect, useState } from 'react';
import { documentRequest, listTemplates } from '@/pages/documents/documentsApi';
import useDocumentText from '@/pages/documents/useDocumentText';
import useTranslation from '@/hooks/useTranslation';
import BindingField from '../inspector/panels/BindingField';
import { INPUT_CLS } from '../inspector/panels/kit';
import type { AppAction, AppDefinition, AppNode, FormFieldRef } from '../inspector/appDefinition';
import { duplicateNameSuffix } from '@/components/automation/Builder/flow/settings/actionEditors/documentOptionLabel';

interface ContractParameter {
    key: string;
    label?: string;
    type?: string;
    required?: boolean;
    summary?: string;
    instructions?: string;
    default?: unknown;
    example?: unknown;
    fields?: Array<{ key: string; label?: string; type?: string; required?: boolean }>;
}

interface ContractSection { id: string; title?: string; summary?: string }

interface Contract {
    documentId: string;
    versionId: string;
    name: string;
    instructions: string;
    parameters: ContractParameter[];
    sections: ContractSection[];
}

/** The members of a `fill_document` step this editor reads and writes. */
interface FillFields {
    documentId?: string;
    documentVersionId?: string;
    values?: Record<string, unknown>;
    sectionOverrides?: Record<string, { value?: string }>;
}

interface DocumentFillFieldsProps {
    step: AppAction & FillFields;
    onChange: (patch: Partial<AppAction>) => void;
    definition: AppDefinition;
    node: AppNode | null;
    formFields: FormFieldRef[];
    disabled: boolean;
}

type Say = ReturnType<typeof useDocumentText>;

/** What to type for a parameter of this type: a list wants JSON, a date a date, text just text. */
function typedPlaceholder(type: string | undefined, d: Say) {
    switch (type) {
        case 'number': return d('A number, e.g. 42', 'Een getal, bijv. 42');
        case 'date': return d('A date, e.g. 2026-01-31', 'Een datum, bijv. 2026-01-31');
        case 'boolean': return d('true or false', 'true of false');
        case 'list': return d('JSON like ["a","b"]', 'JSON zoals ["a","b"]');
        default: return d('Type the value', 'Typ de waarde');
    }
}

export default function DocumentFillFields({ step, onChange, definition, node, formFields, disabled }: DocumentFillFieldsProps) {
    const d = useDocumentText();
    const { locale } = useTranslation();
    const [query, setQuery] = useState('');
    const [documents, setDocuments] = useState<{ id: string; name: string; updatedAt?: string }[]>([]);
    const [contract, setContract] = useState<Contract | null>(null);
    const [proposed, setProposed] = useState<Contract | null>(null);
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let cancelled = false;
        const timer = setTimeout(() => listTemplates({query,limit:100}).then(rows => {
            if (!cancelled) setDocuments(rows);
        }).catch(e => { if (!cancelled) setError(e.message); }), 200);
        return () => {cancelled=true;clearTimeout(timer);};
    }, [query]);
    useEffect(() => {
        let cancelled = false;
        setContract(null); setProposed(null); setError('');
        if (step.documentId) documentRequest(`/${encodeURIComponent(step.documentId)}/contract?versionId=${encodeURIComponent(step.documentVersionId || 'baseline')}`)
            .then(result => { if (!cancelled) setContract(result.contract); })
            .catch(e => { if (!cancelled) setError(e.message); });
        return () => {cancelled=true;};
    }, [step.documentId,step.documentVersionId]);
    const choose = async (id: string) => {
        if (!id) {onChange({documentId:'',documentVersionId:'',values:{},sectionOverrides:{}});return;}
        setBusy(true);setError('');
        try {
            const result=await documentRequest(`/${encodeURIComponent(id)}/contract`);
            onChange({documentId:id,documentVersionId:result.contract.versionId,values:{},sectionOverrides:{}});
        } catch(e) {setError((e as Error).message);} finally {setBusy(false);}
    };
    const summary = (c: Contract) => <div className="space-y-2 text-xs">
        <p>{c.instructions}</p>
        {c.parameters.map(p => <div key={p.key}><strong>{p.label || p.key}{p.required?' *':''}</strong> · {p.type}
            <p>{p.summary}</p><p>{p.instructions}</p>
            {p.default !== undefined && <p>{d('Default','Standaard')}: {JSON.stringify(p.default)}</p>}
            {p.example !== undefined && <p>{d('Example','Voorbeeld')}: {JSON.stringify(p.example)}</p>}
            {p.fields && p.fields.length > 0 && <p>{d('List fields','Lijstvelden')}: {p.fields.map(f => `${f.label || f.key} (${f.type}${f.required?' *':''})`).join(', ')}</p>}
        </div>)}
        {c.sections.map(s => <p key={s.id}><strong>{s.title}</strong>: {s.summary}</p>)}
    </div>;
    return <fieldset disabled={disabled || busy} className="space-y-3 min-w-0">
        <label className="block text-xs">{d('Search document templates','Documentsjablonen zoeken')}
            <input className={INPUT_CLS} value={query} onChange={e=>setQuery(e.target.value)} placeholder={d('Search by name…','Zoeken op naam…')}/></label>
        <label className="block text-xs">{d('Document template','Documentsjabloon')}
            <select className={INPUT_CLS} value={step.documentId || ''} onChange={e=>choose(e.target.value)}>
                <option value="">{d('Choose template','Kies sjabloon')}</option>
                {step.documentId && !documents.some(x=>x.id===step.documentId) && <option value={step.documentId}>{contract?.name || step.documentId}</option>}
                {documents.map(x=><option key={x.id} value={x.id}>{x.name}{duplicateNameSuffix(x, documents, locale)}</option>)}
            </select></label>
        {!step.documentId && !error && <p role="status" className="text-xs text-[var(--warning-ink)]">{d('Pick the document to fill. The app saves without one, but cannot be published until it has one.','Kies het document dat gevuld wordt. De app wordt zonder opgeslagen, maar kan pas gepubliceerd worden als er een gekozen is.')}</p>}
        {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
        {contract && <>
            <p className="text-xs text-[var(--text-secondary)]">{d('Pinned revision','Vastgezette versie')}: <span className="font-mono" title={contract.versionId}>{contract.versionId.slice(0, 8)}</span></p>
            <details><summary className="cursor-pointer text-xs">{d('Parameter instructions and sections','Parameterinstructies en onderdelen')}</summary>{summary(contract)}</details>
            {contract.parameters.map(p=><div className="space-y-1" key={p.key} role="group" aria-label={p.label || p.key}>
                <p className="text-xs font-medium text-[var(--text-primary)]">{p.label || p.key}{p.required?' *':''} <span className="font-normal text-[var(--text-tertiary)]">· {p.type}</span></p>
                {p.summary ? <p className="text-xs text-[var(--text-muted)]">{p.summary}</p> : null}
                <BindingField compact placeholder={typedPlaceholder(p.type, d)} label={null} value={step.values?.[p.key]} onChange={binding=>onChange({values:{...step.values,[p.key]:binding}})} definition={definition} node={node} formFields={formFields} disabled={disabled || busy}/>
            </div>)}
            {contract.sections.map(s=><label key={s.id} className="block text-xs">{s.title}
                <select className={INPUT_CLS} value={(step.sectionOverrides?.[s.id]?.value || step.sectionOverrides?.[s.id] || 'automatic') as string} onChange={e=>onChange({sectionOverrides:{...step.sectionOverrides,[s.id]:e.target.value}})}>
                    <option value="automatic">{d('Automatic (approved rules)','Automatisch (goedgekeurde regels)')}</option>
                    <option value="include">{d('Include','Opnemen')}</option><option value="exclude">{d('Exclude','Weglaten')}</option>
                </select></label>)}
            <button type="button" className="text-xs underline" onClick={async()=>{try{setProposed((await documentRequest(`/${encodeURIComponent(step.documentId as string)}/contract`)).contract);}catch(e){setError((e as Error).message);}}}>{d('Review latest revision','Nieuwste versie controleren')}</button>
        </>}
        {proposed && <div className="rounded border p-3 space-y-2"><p className="text-xs font-semibold">{d('Review before updating','Controleren vóór bijwerken')}</p>{summary(proposed)}
            <button type="button" className="text-xs underline" onClick={()=>{onChange({documentVersionId:proposed.versionId});setProposed(null);}}>{d('Use reviewed revision','Gecontroleerde versie gebruiken')}</button>
        </div>}
    </fieldset>;
}
