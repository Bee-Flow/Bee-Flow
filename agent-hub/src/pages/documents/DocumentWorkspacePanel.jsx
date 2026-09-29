import React, { useEffect, useEffectEvent, useState, useRef, useImperativeHandle, forwardRef } from 'react';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { documentRequest, getHouseStyle } from './documentsApi';
import useDocumentText from './useDocumentText';
import useTranslation from '../../hooks/useTranslation';
import Modal from '../../components/shared/Modal';
import DeckLookFields from './DeckLookFields';

const input = 'w-full rounded border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2 py-1.5 text-sm';
const button = 'rounded border border-[var(--border-subtle)] px-2.5 py-1.5 text-sm hover:bg-[var(--bg-tertiary)] disabled:opacity-50';
const field = (label, child) => <label key={label} className="block space-y-1 text-xs font-medium">{label}{child}</label>;
const TYPES = ['text','number','boolean','date','choice','list'];
const PRESETS = {neutral:{accent:'#334155',ink:'#172033',font:'sans',fontSize:11,lineHeight:1.5,margin:18},branded:{accent:'#d97706',ink:'#172033',font:'sans',fontSize:11,lineHeight:1.6,margin:18},formal:{accent:'#1e3a5f',ink:'#172033',font:'serif',fontSize:12,lineHeight:1.6,margin:22}};
function readDraft(id) {
    try { return JSON.parse(sessionStorage.getItem(`document-settings-draft:${id}`) || 'null'); }
    catch { return null; }
}
function Parameter({ parameter:p, onChange, onDelete, onInsert, nested=false }) {
    const d = useDocumentText(); const set = (key,value)=>onChange({...p,[key]:value});
    return <details className="rounded-lg border border-[var(--border-subtle)] p-3" open={!p.key}>
        <summary className="cursor-pointer text-sm font-medium">{p.label || p.key || d('New parameter','Nieuwe parameter')} {p.required?'*':''}<span className="block text-xs font-normal text-[var(--text-muted)]">{p.summary || p.key}</span>{!p.instructions && <span className="block text-xs font-normal text-amber-600">{d('Instructions need review','Instructies moeten worden gecontroleerd')}</span>}</summary>
        <div className="space-y-3 mt-3">
            {field(d('Parameter key','Parametersleutel'),<input className={input} value={p.key} onChange={e=>set('key',e.target.value)}/>)}
            {field(d('Label','Label'),<input className={input} value={p.label || ''} onChange={e=>set('label',e.target.value)}/>)}
            {field(d('Type','Type'),<select className={input} value={p.type} onChange={e=>onChange({...p,type:e.target.value,...(e.target.value==='choice'?{options:['Option 1']}:{}),...(e.target.value==='list'?{fields:[]}: {})})}>{TYPES.filter(t=>!nested || t!=='list').map(t=><option key={t}>{t}</option>)}</select>)}
            <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={!!p.required} onChange={e=>set('required',e.target.checked)}/>{d('Required when applicable','Verplicht indien van toepassing')}</label>
            {field(d('Short explanation','Korte uitleg'),<input className={input} value={p.summary || ''} onChange={e=>set('summary',e.target.value)}/>)}
            {field(d('Instructions for people and AI','Instructies voor mensen en AI'),<textarea className={input} rows={3} value={p.instructions || ''} onChange={e=>set('instructions',e.target.value)}/>)}
            {p.type==='choice' && field(d('Choices (one per line)','Keuzes (één per regel)'),<textarea className={input} value={(p.options || []).join('\n')} onChange={e=>set('options',e.target.value.split('\n'))}/>)}
            {field(d('Example','Voorbeeld'),<input className={input} value={typeof p.example==='object'?JSON.stringify(p.example):p.example ?? ''} onChange={e=>set('example',e.target.value)}/>)}
            {p.type!=='list' && field(d('Default (optional)','Standaardwaarde (optioneel)'),p.type==='boolean'?<select className={input} value={p.default===undefined?'':String(p.default)} onChange={e=>set('default',e.target.value===''?undefined:e.target.value==='true')}><option value="">—</option><option value="true">{d('Yes','Ja')}</option><option value="false">{d('No','Nee')}</option></select>:<input className={input} type={p.type==='number'?'number':p.type==='date'?'date':'text'} value={p.default ?? ''} onChange={e=>set('default',e.target.value===''?undefined:p.type==='number'?Number(e.target.value):e.target.value)}/>)}
            {p.type==='list' && <div className="space-y-2">{(p.fields || []).map((f,i)=><Parameter key={i} nested parameter={f} onChange={next=>set('fields',p.fields.map((x,j)=>j===i?next:x))} onDelete={()=>set('fields',p.fields.filter((_,j)=>i!==j))}/>)}<button className={button} onClick={()=>set('fields',[...(p.fields || []),{key:'',type:'text',label:'',required:false}])}>{d('Add list field','Lijstveld toevoegen')}</button></div>}
            <div className="flex gap-2">{onInsert && <button className={button} disabled={!p.key} onClick={()=>onInsert(p)}>{d('Insert into document','Invoegen in document')}</button>}<button className={button} onClick={onDelete} aria-label={d('Remove parameter','Parameter verwijderen')}><Trash2 size={14}/></button></div>
        </div>
    </details>;
}
function Rule({rule,onChange,parameters,depth=0}) {
    const d = useDocumentText();
    const first = parameters[0];
    const newRule = () => ({parameter:first?.key || '',operator:'equals',value:first?.type==='boolean'?true:first?.type==='number'?0:''});
    if (!rule) return <button className={button} onClick={()=>onChange({all:[newRule()]})}>{d('Add condition','Voorwaarde toevoegen')}</button>;
    if (rule.all || rule.any) {
        const key = rule.all?'all':'any'; const rows = rule[key];
        return <div className="border-l-2 border-[var(--border-subtle)] pl-2 space-y-2">
            <select aria-label={d('Condition group','Voorwaardengroep')} className={input} value={key} onChange={e=>onChange({[e.target.value]:rows})}><option value="all">{d('All conditions','Alle voorwaarden')}</option><option value="any">{d('Any condition','Een van de voorwaarden')}</option></select>
            {rows.map((r,i)=><div key={i} className="space-y-1"><Rule rule={r} depth={depth+1} parameters={parameters} onChange={next=>{const changed=rows.flatMap((x,j)=>j===i?(next?[next]:[]):[x]);onChange(changed.length?{[key]:changed}:null);}}/><button className="text-xs underline" onClick={()=>onChange(rows.length===1?null:{[key]:rows.filter((_,j)=>i!==j)})}>{d('Remove condition','Voorwaarde verwijderen')}</button></div>)}
            <div className="flex gap-1"><button className={button} onClick={()=>onChange({[key]:[...rows,newRule()]})}>+ {d('Rule','Regel')}</button>{depth<4 && <button className={button} onClick={()=>onChange({[key]:[...rows,{all:[newRule()]}]})}>+ {d('Group','Groep')}</button>}</div>
        </div>;
    }
    const p = parameters.find(x=>x.key===rule.parameter);
    return <div className="space-y-1"><select aria-label={d('Condition parameter','Voorwaardeparameter')} className={input} value={rule.parameter} onChange={e=>{const next=parameters.find(x=>x.key===e.target.value);onChange({...rule,parameter:e.target.value,value:next?.type==='boolean'?true:next?.type==='number'?0:''});}}><option value="">{d('Choose parameter','Kies parameter')}</option>{parameters.map(p=><option key={p.key} value={p.key}>{p.label || p.key}</option>)}</select><select aria-label={d('Comparison','Vergelijking')} className={input} value={rule.operator} onChange={e=>onChange({...rule,operator:e.target.value})}>{[['equals',d('Equals','Is gelijk aan')],['not_equals',d('Does not equal','Is niet gelijk aan')],['contains',d('Contains','Bevat')],['greater_than',d('Greater than','Groter dan')],['less_than',d('Less than','Kleiner dan')],['is_set',d('Is set','Is ingevuld')]].map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>{rule.operator!=='is_set' && <ValueInput parameter={p || {type:'text'}} value={rule.value} onChange={value=>onChange({...rule,value})}/>}</div>;
}
function ValueInput({parameter:p,value,onChange}) {
    const d=useDocumentText();
    if (p.type==='boolean' || p.type==='choice') return <select className={input} value={value===undefined?'':String(value)} onChange={e=>onChange(e.target.value===''?undefined:p.type==='boolean'?e.target.value==='true':e.target.value)}><option value="">—</option>{(p.type==='boolean'?['true','false']:p.options || []).map(v=><option key={v} value={v}>{v==='true'?d('Yes','Ja'):v==='false'?d('No','Nee'):v}</option>)}</select>;
    if (p.type==='list') {
        const items=Array.isArray(value)?value:[];
        return <div className="space-y-2">{items.map((item,i)=><div key={i} className="border rounded p-2 space-y-2">{(p.fields || []).map(f=>field(f.label || f.key,<ValueInput key={f.key} parameter={f} value={item[f.key]} onChange={v=>onChange(items.map((x,j)=>i===j?{...x,[f.key]:v}:x))}/>))}<button className={button} onClick={()=>onChange(items.filter((_,j)=>j!==i))}>{d('Remove row','Rij verwijderen')}</button></div>)}<button className={button} onClick={()=>onChange([...items,{}])}>+ {d('Row','Rij')}</button></div>;
    }
    return <input className={input} type={p.type==='number'?'number':p.type==='date'?'date':'text'} value={value ?? ''} onChange={e=>onChange(e.target.value===''?undefined:p.type==='number'?Number(e.target.value):e.target.value)}/>;
}
/**
 * The Look tab of a presentation: the deck overrides on `settings.deck`, on
 * the shared form, with the house style fetched for fallbacks and the option
 * catalog. Every change is handed up as a draft so the canvas redraws the
 * slides live; the panel's Save button persists it like any other setting.
 */
const NO_DECK = Object.freeze({});
function DeckLookTab({ settings, setSettings, onPreviewDraft, disabled }) {
    const { t } = useTranslation();
    const d = useDocumentText();
    const [house, setHouse] = useState(null);
    const first = useRef(true);
    useEffect(() => {
        let alive = true;
        getHouseStyle().then((body) => { if (alive) setHouse(body); }).catch(() => { if (alive) setHouse({ style: {}, deck: null }); });
        return () => { alive = false; };
    }, []);
    // A stable empty object: a fresh `{}` per render would re-fire the effect
    // below on every render and redraw the slides for nothing.
    const deck = settings.deck || NO_DECK;
    const previewDeck = useEffectEvent(() => onPreviewDraft?.({ settings: { deck } }));
    useEffect(() => {
        // The stored look is already on screen; only a change redraws.
        if (first.current) { first.current = false; return; }
        previewDeck();
    }, [deck]);
    const setDeck = (key, value) => setSettings((s) => {
        const next = { ...(s.deck || {}) };
        if (value === undefined || value === null || value === '') delete next[key];
        else next[key] = value;
        return { ...s, deck: next };
    });
    return (
        <>
            <p className="text-xs text-[var(--text-muted)]">{d('Every choice here applies to this presentation only; anything left on “House style” follows the organisation’s style. The slides redraw as you choose.', 'Elke keuze hier geldt alleen voor deze presentatie; wat op “Huisstijl” blijft staan volgt de stijl van de organisatie. De slides worden meteen opnieuw getekend.')}</p>
            <DeckLookFields deck={deck} setDeck={setDeck} style={(house && house.style) || {}} options={house && house.deck} disabled={disabled} t={t} mode="document" testPrefix="document-deck" />
        </>
    );
}

const DocumentWorkspacePanel = forwardRef(function DocumentWorkspacePanel({doc,tab,onSave,onInsert,onSection,onRefresh,onBeforeAction,onPreviewDraft},ref) {
    const d=useDocumentText();
    const isDeck = doc.docType === 'presentation';
    const currentSettings=()=>({...doc.settings,contract:doc.contract || doc.settings?.contract || {parameters:[],sections:[],instructions:''}});
    const [recovered,setRecovered]=useState(()=>readDraft(doc.id));
    const openedVersion=useRef(doc.versionId);
    const [settings,setSettings]=useState(()=>recovered?.settings || currentSettings());
    const [busy,setBusy]=useState(false); const [error,setError]=useState('');
    const [history,setHistory]=useState([]);
    const [result,setResult]=useState(null); const [message,setMessage]=useState(''); const [mode,setMode]=useState('design'); const [proposal,setProposal]=useState(null);
    const [library,setLibrary]=useState([]); const [updates,setUpdates]=useState([]); const [kind,setKind]=useState(recovered?.kind || doc.kind || 'document'); const [visibility,setVisibility]=useState(recovered?.visibility || doc.visibility || 'private');
    const contract=settings.contract; const parameters=contract.parameters || []; const sections=contract.sections || [];
    const setContract=next=>setSettings(s=>({...s,contract:{...s.contract,...next}}));
    const setDesign=(key,value)=>setSettings(s=>({...s,design:{...PRESETS.neutral,...s.design,[key]:value}}));
    const action=async fn=>{setBusy(true);setError('');try{await fn();}catch(e){setError(e.message);}finally{setBusy(false);}};
    const savedState=useRef(JSON.stringify({settings:currentSettings(),kind:doc.kind || 'document',visibility:doc.visibility || 'private'}));
    const latestState=useRef(null);latestState.current={settings,kind,visibility};
    const saving=useRef(null);
    const acceptSettings=next=>{
        latestState.current={settings:next,kind,visibility};
        savedState.current=JSON.stringify({settings:next,kind,visibility});setSettings(next);setRecovered(null);
        try{sessionStorage.removeItem(`document-settings-draft:${doc.id}`);}catch{/* memory copy remains */}
    };
    const save=async()=>{
        if(saving.current) await saving.current;
        const run=async()=>{
            let result;
            let expectedVersionId=recovered && recovered.versionId!==openedVersion.current ? recovered.versionId : undefined;
            while(JSON.stringify(latestState.current)!==savedState.current) {
                const snapshot=latestState.current;
                result=await onSave({...snapshot,...(expectedVersionId?{expectedVersionId}:{})});
                savedState.current=JSON.stringify(snapshot);expectedVersionId=undefined;setRecovered(null);
            }
            try {sessionStorage.removeItem(`document-settings-draft:${doc.id}`);}catch{/* memory draft remains */}
            return result;
        };
        saving.current=run();
        try{return await saving.current;}finally{saving.current=null;}
    };
    useImperativeHandle(ref,()=>({flush:save}));
    useEffect(()=>{
        if (JSON.stringify({settings,kind,visibility})!==savedState.current) {
            try {sessionStorage.setItem(`document-settings-draft:${doc.id}`,JSON.stringify({settings,kind,visibility,versionId:recovered?.versionId || doc.versionId,bodyHtml:doc.bodyHtml,css:doc.css}));}catch{/* memory draft remains */}
        }
        const warn=e=>{if(JSON.stringify({settings,kind,visibility})!==savedState.current){e.preventDefault();e.returnValue='';}};
        window.addEventListener('beforeunload',warn);return()=>window.removeEventListener('beforeunload',warn);
    },[settings,kind,visibility,doc.id,doc.bodyHtml,doc.css,doc.versionId,recovered?.versionId]);
    useEffect(()=>{if(tab==='sections') {documentRequest('?kind=section&limit=200').then(r=>setLibrary(r.documents)).catch(e=>setError(e.message));documentRequest(`/${doc.id}/updates`).then(r=>setUpdates(r.updates || [])).catch(e=>setError(e.message));}},[tab,doc.id]);
    return <aside className="w-full sm:w-80 shrink-0 overflow-y-auto border-l border-[var(--border-subtle)] bg-[var(--bg-secondary)] p-4 space-y-4 text-[var(--text-primary)]">
        <h2 className="font-semibold">{({parameters:d('Parameters','Parameters'),sections:d('Sections','Onderdelen'),design:isDeck?d('Look','Uiterlijk'):d('Design','Vormgeving'),assistant:d('AI assistant','AI-assistent'),preview:d('Customer preview','Klantvoorbeeld')})[tab]}</h2>
        {error && <p role="alert" className="text-sm bg-red-500/10 p-2 rounded">{error}</p>}
        {recovered && <div className="text-xs bg-amber-500/10 p-3 rounded space-y-2"><p>{d('Unsaved settings recovered. Review them before saving.','Niet-opgeslagen instellingen hersteld. Controleer ze vóór opslaan.')}</p>
            <button className={button} onClick={()=>action(async()=>{const r=await documentRequest('',{name:doc.name+' — recovered',kind:'document',bodyHtml:recovered.bodyHtml || doc.bodyHtml,css:recovered.css || doc.css,settings});setResult({message:d('Recovered copy saved','Herstelde kopie opgeslagen')+': '+r.document.name});})}>{d('Save recovered copy','Herstelde kopie opslaan')}</button>
            <button className={button} onClick={()=>{const next=currentSettings();setSettings(next);setKind(doc.kind || 'document');setVisibility(doc.visibility || 'private');savedState.current=JSON.stringify({settings:next,kind:doc.kind || 'document',visibility:doc.visibility || 'private'});setRecovered(null);try{sessionStorage.removeItem(`document-settings-draft:${doc.id}`);}catch{/* unavailable */}}}>{d('Discard recovered changes','Herstelde wijzigingen verwerpen')}</button>
        </div>}
        <fieldset disabled={busy || doc.editable===false} className="space-y-4 min-w-0">
        {tab==='parameters' && <>
            {field(d('Document instructions','Documentinstructies'),<textarea className={input} rows={4} value={contract.instructions || ''} onChange={e=>setContract({instructions:e.target.value})}/>)}
            {parameters.map((p,i)=><Parameter key={i} parameter={p} onChange={next=>setContract({parameters:parameters.map((x,j)=>j===i?next:x)})} onDelete={()=>setContract({parameters:parameters.filter((_,j)=>i!==j)})} onInsert={key=>action(async()=>{await save();onInsert(key);})}/>)}
            <button className={button} onClick={()=>setContract({parameters:[...parameters,{key:'',type:'text',label:'',summary:'',instructions:'',required:false}]})}><Plus size={14} className="inline"/> {d('Add parameter','Parameter toevoegen')}</button>
            {field(d('Library type','Bibliotheektype'),<select className={input} value={kind} onChange={e=>{setKind(e.target.value);if(e.target.value==='document')setVisibility('private');}}><option value="document">{isDeck?d('Presentation','Presentatie'):d('Document','Document')}</option><option value="template">{d('Template','Sjabloon')}</option>{!isDeck && <option value="section">{d('Reusable section','Herbruikbaar onderdeel')}</option>}</select>)}
            {kind!=='document' && field(d('Visibility','Zichtbaarheid'),<select className={input} value={visibility} onChange={e=>setVisibility(e.target.value)}><option value="private">{d('Private','Privé')}</option><option value="team">{d('Team library','Teambibliotheek')}</option></select>)}
            <button className={button} onClick={()=>action(async()=>{await save();const r=await documentRequest(`/${doc.id}/duplicate`,{kind:'template'});setResult({message:d('Template saved','Sjabloon opgeslagen')+': '+r.document.name});})}>{d('Save a copy as template','Kopie opslaan als sjabloon')}</button>
        </>}
        {tab==='sections' && <>
            <p className="text-xs text-[var(--text-muted)]">{d('Choose when each section applies. Unknown customer data needs input before a final PDF.','Bepaal wanneer elk onderdeel van toepassing is. Onbekende klantgegevens moeten vóór de definitieve PDF worden ingevuld.')}</p>
            {sections.map((s,i)=><details key={s.id} className="border rounded-lg p-3"><summary className="cursor-pointer text-sm font-medium">{s.title}</summary><div className="space-y-3 mt-3"><button className={button} onClick={()=>onSection(s.id)}>{d('Find in document','Toon in document')}</button>{field(d('Title','Titel'),<input className={input} value={s.title} onChange={e=>setContract({sections:sections.map((x,j)=>i===j?{...x,title:e.target.value}:x)})}/>)}{field(d('Summary','Samenvatting'),<textarea className={input} value={s.summary || ''} onChange={e=>setContract({sections:sections.map((x,j)=>i===j?{...x,summary:e.target.value}:x)})}/>)}<Rule rule={s.condition} parameters={parameters} onChange={condition=>setContract({sections:sections.map((x,j)=>i===j?{...x,condition}:x)})}/><button className={button} onClick={()=>action(async()=>{await save();await documentRequest(`/${doc.id}/sections/${s.id}/save`,{});setResult({message:d('Section saved to your library','Onderdeel opgeslagen in je bibliotheek')});})}>{d('Save to section library','Opslaan in onderdelenbibliotheek')}</button>{s.source && <p className="text-xs">{d('Linked revision','Gekoppelde versie')}: {s.source.versionId.slice(0,8)}</p>}</div></details>)}
            <button className={button} onClick={()=>action(async()=>{await onBeforeAction();const current=(await documentRequest(`/${doc.id}`)).document;const id='section-'+crypto.randomUUID();const next={...settings,contract:{...contract,sections:[...sections,{id,title:d('New section','Nieuw onderdeel'),summary:'',condition:null}]}};await onSave({settings:next,bodyHtml:current.bodyHtml+`<section data-doc-section="${id}"><h2>${d('New section','Nieuw onderdeel')}</h2><p>${d('Write your content here.','Schrijf hier de inhoud.')}</p></section>`});acceptSettings(next);})}>{d('Add section','Onderdeel toevoegen')}</button>
            {field(d('Insert reusable content','Herbruikbare inhoud invoegen'),<select className={input} value="" onChange={e=>{const sourceId=e.target.value;if(sourceId)action(async()=>{await save();await onBeforeAction();const latest=await documentRequest(`/${doc.id}`);const out=await documentRequest(`/${doc.id}/insert-section`,{sourceId,expectedVersionId:latest.document.versionId});acceptSettings({...out.document.settings,contract:out.document.contract || out.document.settings.contract});onRefresh();});}}><option value="">{d('Choose section…','Kies onderdeel…')}</option>{library.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select>)}
            {updates.map(u=><div className="rounded border p-3 space-y-2" key={u.sectionId || 'template'}><p className="text-sm">{d('Update available','Update beschikbaar')}: {u.name}</p><button className={button} onClick={()=>action(async()=>{await save();const r=await documentRequest(`/${doc.id}/review-update`,{sectionId:u.sectionId});setProposal(r);})}>{d('Review changes','Wijzigingen bekijken')}</button></div>)}
        </>}
        {tab==='design' && isDeck && <DeckLookTab settings={settings} setSettings={setSettings} onPreviewDraft={onPreviewDraft} disabled={busy || doc.editable===false}/>}
        {tab==='design' && !isDeck && <>
            {field(d('Preset','Voorinstelling'),<select className={input} value={settings.design?.preset || 'neutral'} onChange={e=>setSettings(s=>({...s,design:{...PRESETS[e.target.value],preset:e.target.value}}))}>{Object.keys(PRESETS).map(k=><option key={k}>{k}</option>)}</select>)}
            {['accent','ink'].map(k=>field(k==='accent'?d('Accent color','Accentkleur'):d('Text color','Tekstkleur'),<input key={k} className={input+' h-10'} type="color" value={settings.design?.[k] || PRESETS.neutral[k]} onChange={e=>setDesign(k,e.target.value)}/>))}
            {field(d('Font','Lettertype'),<select className={input} value={settings.design?.font || 'sans'} onChange={e=>setDesign('font',e.target.value)}><option value="sans">Sans serif</option><option value="serif">Serif</option><option value="mono">Monospace</option></select>)}
            {[['fontSize',d('Font size','Lettergrootte'),8,24,1,11],['lineHeight',d('Line spacing','Regelafstand'),1,2.5,0.1,1.5],['margin',d('Page margins (mm)','Paginamarges (mm)'),0,40,1,18],['logoWidth',d('Logo width (mm)','Logobreedte (mm)'),10,80,1,24]].map(([key,label,min,max,step,fallback])=>field(label,<input key={key} className={input} type="number" min={min} max={max} step={step} value={settings.design?.[key] ?? fallback} onChange={e=>setDesign(key,Number(e.target.value))}/>))}
            {field(d('Paper size','Papierformaat'),<select className={input} value={settings.design?.pageSize || 'A4'} onChange={e=>setDesign('pageSize',e.target.value)}><option>A4</option><option>Letter</option></select>)}
            {field(d('Logo position','Logopositie'),<select className={input} value={settings.design?.logoPosition || 'left'} onChange={e=>setDesign('logoPosition',e.target.value)}>{['left','center','right'].map(x=><option key={x}>{x}</option>)}</select>)}
            {['showHeader','showFooter'].map(key=><label className="flex gap-2 text-sm" key={key}><input type="checkbox" checked={settings.design?.[key]!==false} onChange={e=>setDesign(key,e.target.checked)}/>{key==='showHeader'?d('Show header','Koptekst tonen'):d('Show footer','Voettekst tonen')}</label>)}
            <button className={button} onClick={()=>action(async()=>{await onBeforeAction();setProposal(await documentRequest(`/${doc.id}/preview-changes`,{design:settings.design}));})}>{d('Preview design changes','Vormgeving vooraf bekijken')}</button>
            <p className="text-xs text-[var(--text-muted)]">{d('For custom layouts, ask the AI assistant to convert the stylesheet to these controls. Review the preview before applying.','Vraag de AI-assistent om aangepaste vormgeving naar deze instellingen om te zetten. Controleer het voorbeeld vóór toepassen.')}</p>
        </>}
        {tab==='preview' && <>
            <p className="text-xs">{doc.kind==='document'?d('Customer values are stored on this private document.','Klantgegevens worden opgeslagen in dit privédocument.'):d('Sample data is used only for this preview and is never saved to a shared template.','Voorbeeldgegevens worden alleen voor dit voorbeeld gebruikt en nooit in een gedeeld sjabloon opgeslagen.')}</p>
            {parameters.map(p=><div key={p.key}>{field((p.label || p.key)+(p.required?' *':''),<ValueInput parameter={p} value={settings.sampleValues?.[p.key]} onChange={v=>setSettings(s=>({...s,sampleValues:{...s.sampleValues,[p.key]:v}}))}/>)}<p className="text-xs text-[var(--text-muted)] mt-1">{p.summary}</p>{p.instructions && <details className="text-xs mt-1"><summary>{d('Instructions','Instructies')}</summary>{p.instructions}</details>}</div>)}
            {sections.map(s=>field(s.title,<select key={s.id} className={input} value={settings.sectionOverrides?.[s.id] || 'automatic'} onChange={e=>setSettings(x=>({...x,sectionOverrides:{...x.sectionOverrides,[s.id]:e.target.value}}))}><option value="automatic">{d('Automatic (rules)','Automatisch (regels)')}</option><option value="include">{d('Include','Opnemen')}</option><option value="exclude">{d('Exclude','Weglaten')}</option></select>))}
            <button className={button} onClick={()=>action(async()=>{await save();setResult(await documentRequest(`/${doc.id}/validate`,{values:settings.sampleValues,sectionOverrides:settings.sectionOverrides}));})}>{d('Validate & preview','Controleren en bekijken')}</button>
        </>}
        {tab==='assistant' && <>
            {history.map((m,i)=><p key={i} className={'text-sm p-2 rounded '+(m.role==='user'?'bg-[var(--bg-tertiary)]':'')}>{m.content}</p>)}
            {field(d('What would you like to change?','Wat wil je aanpassen?'),<textarea className={input} rows={5} value={message} onChange={e=>setMessage(e.target.value)} placeholder={d('Make this more professional, with a clear cover and compact tables…','Maak dit professioneler, met een duidelijk voorblad en compacte tabellen…')}/>)}
            <select className={input} value={mode} onChange={e=>setMode(e.target.value)} aria-label={d('Assistant mode','Assistentmodus')}><option value="design">{isDeck?d('Look only','Alleen uiterlijk'):d('Design only','Alleen vormgeving')}</option><option value="content">{isDeck?d('Slides and outline','Slides en outline'):d('Content and template','Inhoud en sjabloon')}</option>{!isDeck && <option value="applicability">{d('Suggest applicable sections','Toepasselijke onderdelen voorstellen')}</option>}</select>
            <button className={button} disabled={!message.trim() || busy} onClick={()=>action(async()=>{await save();await onBeforeAction();const next=await documentRequest(`/${doc.id}/ai-proposal`,{message,mode,values:settings.sampleValues,history});setProposal(next);setHistory(h=>[...h,{role:'user',content:message},{role:'assistant',content:next.explanation}]);setMessage('');})}>{d('Prepare a proposal','Voorstel maken')}</button>
        </>}
        {tab!=='assistant' && <button className={button+' w-full font-semibold'} onClick={()=>action(save)}>{busy?<Loader2 size={15} className="animate-spin mx-auto"/>:d('Save changes','Wijzigingen opslaan')}</button>}
        </fieldset>
        {result && <div className="space-y-2"><p role="status" className="text-sm font-medium">{result.message || (result.valid?d('Ready to generate','Klaar om te genereren'):d('Draft — input required','Concept — invoer nodig'))}</p>{result.issues?.map((issue,i)=><p key={i} className="text-xs text-red-600">{issue.message}</p>)}{result.sections?.map(s=><p key={s.id} className="text-xs"><strong>{s.title}: {({included:d('Included','Opgenomen'),excluded:d('Excluded','Weggelaten'),unresolved:d('Needs input','Invoer nodig')})[s.state]}</strong><br/>{s.reason}</p>)}{result.html && <button className={button} onClick={()=>setProposal({html:result.html,previewOnly:true,validation:result,explanation:result.valid?d('Customer preview','Klantvoorbeeld'):d('Draft — input required','Concept — invoer nodig')})}>{d('Open preview','Voorbeeld openen')}</button>}</div>}
        {proposal && <Modal open onClose={()=>setProposal(null)} title={d('Review proposal','Voorstel controleren')} size="xl"><div className="space-y-3"><p className="font-medium">{proposal.explanation}</p>{proposal.html && <iframe title={d('Proposed document','Voorgesteld document')} sandbox={isDeck?'allow-scripts':''} srcDoc={proposal.html} className="w-full h-[55vh] border rounded"/>}{proposal.suggestions?.map(s=><p key={s.sectionId} className="text-sm">{s.sectionId}: {s.choice} — {s.reason}</p>)}{proposal.validation?.issues?.map((i,n)=><p className="text-xs text-red-600" key={n}>{i.message}</p>)}<div className="flex gap-2"><button className={button} onClick={()=>setProposal(null)}>{d('Close','Sluiten')}</button>{!proposal.previewOnly && <button className={button} disabled={busy} onClick={()=>action(async()=>{const patch={...proposal.patch};if(proposal.suggestions?.length)patch.settings={...(patch.settings || settings),sectionOverrides:{...settings.sectionOverrides,...Object.fromEntries(proposal.suggestions.map(s=>[s.sectionId,s.choice]))}};await onSave({...patch,expectedVersionId:proposal.expectedVersionId,summary:'Applied reviewed proposal'});if(patch.settings)acceptSettings(patch.settings);setProposal(null);setUpdates([]);})}>{d('Apply reviewed changes','Gecontroleerde wijzigingen toepassen')}</button>}</div></div></Modal>}
    </aside>;
});
export default DocumentWorkspacePanel;
