import React, { useEffect, useState } from 'react';
import { documentRequest, listTemplates } from '../../../../../pages/documents/documentsApi';
import useDocumentText from '../../../../../pages/documents/useDocumentText';
import BindingField from '../inspector/panels/BindingField';
import { INPUT_CLS } from '../inspector/panels/kit';

export default function DocumentFillFields({ step, onChange, definition, node, formFields, disabled }) {
    const d = useDocumentText();
    const [query, setQuery] = useState('');
    const [documents, setDocuments] = useState([]);
    const [contract, setContract] = useState(null);
    const [proposed, setProposed] = useState(null);
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
    const choose = async id => {
        if (!id) {onChange({documentId:'',documentVersionId:'',values:{},sectionOverrides:{}});return;}
        setBusy(true);setError('');
        try {
            const result=await documentRequest(`/${encodeURIComponent(id)}/contract`);
            onChange({documentId:id,documentVersionId:result.contract.versionId,values:{},sectionOverrides:{}});
        } catch(e) {setError(e.message);} finally {setBusy(false);}
    };
    const summary = c => <div className="space-y-2 text-xs">
        <p>{c.instructions}</p>
        {c.parameters.map(p => <div key={p.key}><strong>{p.label || p.key}{p.required?' *':''}</strong> · {p.type}
            <p>{p.summary}</p><p>{p.instructions}</p>
            {p.default !== undefined && <p>{d('Default','Standaard')}: {JSON.stringify(p.default)}</p>}
            {p.example !== undefined && <p>{d('Example','Voorbeeld')}: {JSON.stringify(p.example)}</p>}
            {p.fields?.length > 0 && <p>{d('List fields','Lijstvelden')}: {p.fields.map(f => `${f.label || f.key} (${f.type}${f.required?' *':''})`).join(', ')}</p>}
        </div>)}
        {c.sections.map(s => <p key={s.id}><strong>{s.title}</strong>: {s.summary}</p>)}
    </div>;
    return <fieldset disabled={disabled || busy} className="space-y-3 min-w-0">
        <label className="block text-xs">{d('Search document templates','Documentsjablonen zoeken')}
            <input className={INPUT_CLS} value={query} onChange={e=>setQuery(e.target.value)}/></label>
        <label className="block text-xs">{d('Document template','Documentsjabloon')}
            <select className={INPUT_CLS} value={step.documentId || ''} onChange={e=>choose(e.target.value)}>
                <option value="">{d('Choose template','Kies sjabloon')}</option>
                {step.documentId && !documents.some(x=>x.id===step.documentId) && <option value={step.documentId}>{contract?.name || step.documentId}</option>}
                {documents.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}
            </select></label>
        {error && <p role="alert" className="text-xs text-red-500">{error}</p>}
        {contract && <>
            <p className="text-xs">{d('Pinned revision','Vastgezette versie')}: {contract.versionId}</p>
            <details><summary className="cursor-pointer text-xs">{d('Parameter instructions and sections','Parameterinstructies en onderdelen')}</summary>{summary(contract)}</details>
            {contract.parameters.map(p=><div className="space-y-1" key={p.key}>
                <p className="text-xs">{p.label || p.key}{p.required?' *':''} · {p.type}</p><p className="text-xs text-[var(--text-muted)]">{p.summary}</p>
                {!Object.hasOwn(step.values || {},p.key) && p.required && p.default===undefined && <p className="text-xs text-amber-600">{d('Binding needed when applicable','Koppeling nodig indien van toepassing')}</p>}
                <BindingField value={step.values?.[p.key]} onChange={binding=>onChange({values:{...step.values,[p.key]:binding}})} definition={definition} node={node} formFields={formFields} disabled={disabled || busy}/>
            </div>)}
            {contract.sections.map(s=><label key={s.id} className="block text-xs">{s.title}
                <select className={INPUT_CLS} value={step.sectionOverrides?.[s.id]?.value || step.sectionOverrides?.[s.id] || 'automatic'} onChange={e=>onChange({sectionOverrides:{...step.sectionOverrides,[s.id]:e.target.value}})}>
                    <option value="automatic">{d('Automatic (approved rules)','Automatisch (goedgekeurde regels)')}</option>
                    <option value="include">{d('Include','Opnemen')}</option><option value="exclude">{d('Exclude','Weglaten')}</option>
                </select></label>)}
            <button type="button" className="text-xs underline" onClick={async()=>{try{setProposed((await documentRequest(`/${encodeURIComponent(step.documentId)}/contract`)).contract);}catch(e){setError(e.message);}}}>{d('Review latest revision','Nieuwste versie controleren')}</button>
        </>}
        {proposed && <div className="rounded border p-3 space-y-2"><p className="text-xs font-semibold">{d('Review before updating','Controleren vóór bijwerken')}</p>{summary(proposed)}
            <button type="button" className="text-xs underline" onClick={()=>{onChange({documentVersionId:proposed.versionId});setProposed(null);}}>{d('Use reviewed revision','Gecontroleerde versie gebruiken')}</button>
        </div>}
    </fieldset>;
}
