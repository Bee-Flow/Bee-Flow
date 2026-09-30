import React, { useEffect, useEffectEvent, useState, useRef, useImperativeHandle, forwardRef } from 'react';
import { Plus, Trash2, Loader2 } from 'lucide-react';
import { documentRequest, getHouseStyle } from './documentsApi';
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
    const { t } = useTranslation(); const set = (key,value)=>onChange({...p,[key]:value});
    return <details className="rounded-lg border border-[var(--border-subtle)] p-3" open={!p.key}>
        <summary className="cursor-pointer text-sm font-medium">{p.label || p.key || t('documents.workspace.new_parameter', 'New parameter')} {p.required?'*':''}<span className="block text-xs font-normal text-[var(--text-muted)]">{p.summary || p.key}</span>{!p.instructions && <span className="block text-xs font-normal text-amber-600">{t('documents.workspace.instructions_need_review', 'Instructions need review')}</span>}</summary>
        <div className="space-y-3 mt-3">
            {field(t('documents.workspace.parameter_key', 'Parameter key'),<input className={input} value={p.key} onChange={e=>set('key',e.target.value)}/>)}
            {field(t('documents.workspace.label', 'Label'),<input className={input} value={p.label || ''} onChange={e=>set('label',e.target.value)}/>)}
            {field(t('documents.workspace.type', 'Type'),<select className={input} value={p.type} onChange={e=>onChange({...p,type:e.target.value,...(e.target.value==='choice'?{options:['Option 1']}:{}),...(e.target.value==='list'?{fields:[]}: {})})}>{TYPES.filter(t=>!nested || t!=='list').map(t=><option key={t}>{t}</option>)}</select>)}
            <label className="flex gap-2 items-center text-sm"><input type="checkbox" checked={!!p.required} onChange={e=>set('required',e.target.checked)}/>{t('documents.workspace.required_when_applicable', 'Required when applicable')}</label>
            {field(t('documents.workspace.short_explanation', 'Short explanation'),<input className={input} value={p.summary || ''} onChange={e=>set('summary',e.target.value)}/>)}
            {field(t('documents.workspace.instructions_for_people_and_ai', 'Instructions for people and AI'),<textarea className={input} rows={3} value={p.instructions || ''} onChange={e=>set('instructions',e.target.value)}/>)}
            {p.type==='choice' && field(t('documents.workspace.choices_one_per_line', 'Choices (one per line)'),<textarea className={input} value={(p.options || []).join('\n')} onChange={e=>set('options',e.target.value.split('\n'))}/>)}
            {field(t('documents.workspace.example', 'Example'),<input className={input} value={typeof p.example==='object'?JSON.stringify(p.example):p.example ?? ''} onChange={e=>set('example',e.target.value)}/>)}
            {p.type!=='list' && field(t('documents.workspace.default_optional', 'Default (optional)'),p.type==='boolean'?<select className={input} value={p.default===undefined?'':String(p.default)} onChange={e=>set('default',e.target.value===''?undefined:e.target.value==='true')}><option value="">—</option><option value="true">{t('documents.workspace.yes', 'Yes')}</option><option value="false">{t('documents.workspace.no', 'No')}</option></select>:<input className={input} type={p.type==='number'?'number':p.type==='date'?'date':'text'} value={p.default ?? ''} onChange={e=>set('default',e.target.value===''?undefined:p.type==='number'?Number(e.target.value):e.target.value)}/>)}
            {p.type==='list' && <div className="space-y-2">{(p.fields || []).map((f,i)=><Parameter key={i} nested parameter={f} onChange={next=>set('fields',p.fields.map((x,j)=>j===i?next:x))} onDelete={()=>set('fields',p.fields.filter((_,j)=>i!==j))}/>)}<button className={button} onClick={()=>set('fields',[...(p.fields || []),{key:'',type:'text',label:'',required:false}])}>{t('documents.workspace.add_list_field', 'Add list field')}</button></div>}
            <div className="flex gap-2">{onInsert && <button className={button} disabled={!p.key} onClick={()=>onInsert(p)}>{t('documents.workspace.insert_into_document', 'Insert into document')}</button>}<button className={button} onClick={onDelete} aria-label={t('documents.workspace.remove_parameter', 'Remove parameter')}><Trash2 size={14}/></button></div>
        </div>
    </details>;
}
function Rule({rule,onChange,parameters,depth=0}) {
    const { t } = useTranslation();
    const first = parameters[0];
    const newRule = () => ({parameter:first?.key || '',operator:'equals',value:first?.type==='boolean'?true:first?.type==='number'?0:''});
    if (!rule) return <button className={button} onClick={()=>onChange({all:[newRule()]})}>{t('documents.workspace.add_condition', 'Add condition')}</button>;
    if (rule.all || rule.any) {
        const key = rule.all?'all':'any'; const rows = rule[key];
        return <div className="border-l-2 border-[var(--border-subtle)] pl-2 space-y-2">
            <select aria-label={t('documents.workspace.condition_group', 'Condition group')} className={input} value={key} onChange={e=>onChange({[e.target.value]:rows})}><option value="all">{t('documents.workspace.all_conditions', 'All conditions')}</option><option value="any">{t('documents.workspace.any_condition', 'Any condition')}</option></select>
            {rows.map((r,i)=><div key={i} className="space-y-1"><Rule rule={r} depth={depth+1} parameters={parameters} onChange={next=>{const changed=rows.flatMap((x,j)=>j===i?(next?[next]:[]):[x]);onChange(changed.length?{[key]:changed}:null);}}/><button className="text-xs underline" onClick={()=>onChange(rows.length===1?null:{[key]:rows.filter((_,j)=>i!==j)})}>{t('documents.workspace.remove_condition', 'Remove condition')}</button></div>)}
            <div className="flex gap-1"><button className={button} onClick={()=>onChange({[key]:[...rows,newRule()]})}>+ {t('documents.workspace.rule', 'Rule')}</button>{depth<4 && <button className={button} onClick={()=>onChange({[key]:[...rows,{all:[newRule()]}]})}>+ {t('documents.workspace.group', 'Group')}</button>}</div>
        </div>;
    }
    const p = parameters.find(x=>x.key===rule.parameter);
    return <div className="space-y-1"><select aria-label={t('documents.workspace.condition_parameter', 'Condition parameter')} className={input} value={rule.parameter} onChange={e=>{const next=parameters.find(x=>x.key===e.target.value);onChange({...rule,parameter:e.target.value,value:next?.type==='boolean'?true:next?.type==='number'?0:''});}}><option value="">{t('documents.workspace.choose_parameter', 'Choose parameter')}</option>{parameters.map(p=><option key={p.key} value={p.key}>{p.label || p.key}</option>)}</select><select aria-label={t('documents.workspace.comparison', 'Comparison')} className={input} value={rule.operator} onChange={e=>onChange({...rule,operator:e.target.value})}>{[['equals',t('documents.workspace.equals', 'Equals')],['not_equals',t('documents.workspace.does_not_equal', 'Does not equal')],['contains',t('documents.workspace.contains', 'Contains')],['greater_than',t('documents.workspace.greater_than', 'Greater than')],['less_than',t('documents.workspace.less_than', 'Less than')],['is_set',t('documents.workspace.is_set', 'Is set')]].map(([key,label])=><option key={key} value={key}>{label}</option>)}</select>{rule.operator!=='is_set' && <ValueInput parameter={p || {type:'text'}} value={rule.value} onChange={value=>onChange({...rule,value})}/>}</div>;
}
function ValueInput({parameter:p,value,onChange}) {
    const { t } = useTranslation();
    if (p.type==='boolean' || p.type==='choice') return <select className={input} value={value===undefined?'':String(value)} onChange={e=>onChange(e.target.value===''?undefined:p.type==='boolean'?e.target.value==='true':e.target.value)}><option value="">—</option>{(p.type==='boolean'?['true','false']:p.options || []).map(v=><option key={v} value={v}>{v==='true'?t('documents.workspace.yes', 'Yes'):v==='false'?t('documents.workspace.no', 'No'):v}</option>)}</select>;
    if (p.type==='list') {
        const items=Array.isArray(value)?value:[];
        return <div className="space-y-2">{items.map((item,i)=><div key={i} className="border rounded p-2 space-y-2">{(p.fields || []).map(f=>field(f.label || f.key,<ValueInput key={f.key} parameter={f} value={item[f.key]} onChange={v=>onChange(items.map((x,j)=>i===j?{...x,[f.key]:v}:x))}/>))}<button className={button} onClick={()=>onChange(items.filter((_,j)=>j!==i))}>{t('documents.workspace.remove_row', 'Remove row')}</button></div>)}<button className={button} onClick={()=>onChange([...items,{}])}>+ {t('documents.workspace.row', 'Row')}</button></div>;
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
            <p className="text-xs text-[var(--text-muted)]">{t('documents.workspace.every_choice_here_applies_to_this', 'Every choice here applies to this presentation only; anything left on “House style” follows the organisation’s style. The slides redraw as you choose.')}</p>
            <DeckLookFields deck={deck} setDeck={setDeck} style={(house && house.style) || {}} options={house && house.deck} disabled={disabled} t={t} mode="document" testPrefix="document-deck" />
        </>
    );
}

const DocumentWorkspacePanel = forwardRef(function DocumentWorkspacePanel({doc,tab,onSave,onInsert,onSection,onRefresh,onBeforeAction,onPreviewDraft},ref) {
    const { t } = useTranslation();
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
        <h2 className="font-semibold">{({parameters:t('documents.workspace.parameters', 'Parameters'),sections:t('documents.workspace.sections', 'Sections'),design:isDeck?t('documents.workspace.look', 'Look'):t('documents.workspace.design', 'Design'),assistant:t('documents.workspace.ai_assistant', 'AI assistant'),preview:t('documents.workspace.customer_preview', 'Customer preview')})[tab]}</h2>
        {error && <p role="alert" className="text-sm bg-red-500/10 p-2 rounded">{error}</p>}
        {recovered && <div className="text-xs bg-amber-500/10 p-3 rounded space-y-2"><p>{t('documents.workspace.unsaved_settings_recovered_review', 'Unsaved settings recovered. Review them before saving.')}</p>
            <button className={button} onClick={()=>action(async()=>{const r=await documentRequest('',{name:doc.name+' — recovered',kind:'document',bodyHtml:recovered.bodyHtml || doc.bodyHtml,css:recovered.css || doc.css,settings});setResult({message:t('documents.workspace.recovered_copy_saved', 'Recovered copy saved')+': '+r.document.name});})}>{t('documents.workspace.save_recovered_copy', 'Save recovered copy')}</button>
            <button className={button} onClick={()=>{const next=currentSettings();setSettings(next);setKind(doc.kind || 'document');setVisibility(doc.visibility || 'private');savedState.current=JSON.stringify({settings:next,kind:doc.kind || 'document',visibility:doc.visibility || 'private'});setRecovered(null);try{sessionStorage.removeItem(`document-settings-draft:${doc.id}`);}catch{/* unavailable */}}}>{t('documents.workspace.discard_recovered_changes', 'Discard recovered changes')}</button>
        </div>}
        <fieldset disabled={busy || doc.editable===false} className="space-y-4 min-w-0">
        {tab==='parameters' && <>
            {field(t('documents.workspace.document_instructions', 'Document instructions'),<textarea className={input} rows={4} value={contract.instructions || ''} onChange={e=>setContract({instructions:e.target.value})}/>)}
            {parameters.map((p,i)=><Parameter key={i} parameter={p} onChange={next=>setContract({parameters:parameters.map((x,j)=>j===i?next:x)})} onDelete={()=>setContract({parameters:parameters.filter((_,j)=>i!==j)})} onInsert={key=>action(async()=>{await save();onInsert(key);})}/>)}
            <button className={button} onClick={()=>setContract({parameters:[...parameters,{key:'',type:'text',label:'',summary:'',instructions:'',required:false}]})}><Plus size={14} className="inline"/> {t('documents.workspace.add_parameter', 'Add parameter')}</button>
            {field(t('documents.workspace.library_type', 'Library type'),<select className={input} value={kind} onChange={e=>{setKind(e.target.value);if(e.target.value==='document')setVisibility('private');}}><option value="document">{isDeck?t('documents.workspace.presentation', 'Presentation'):t('documents.workspace.document', 'Document')}</option><option value="template">{t('documents.workspace.template', 'Template')}</option>{!isDeck && <option value="section">{t('documents.workspace.reusable_section', 'Reusable section')}</option>}</select>)}
            {kind!=='document' && field(t('documents.workspace.visibility', 'Visibility'),<select className={input} value={visibility} onChange={e=>setVisibility(e.target.value)}><option value="private">{t('documents.workspace.private', 'Private')}</option><option value="team">{t('documents.workspace.team_library', 'Team library')}</option></select>)}
            <button className={button} onClick={()=>action(async()=>{await save();const r=await documentRequest(`/${doc.id}/duplicate`,{kind:'template'});setResult({message:t('documents.workspace.template_saved', 'Template saved')+': '+r.document.name});})}>{t('documents.workspace.save_a_copy_as_template', 'Save a copy as template')}</button>
        </>}
        {tab==='sections' && <>
            <p className="text-xs text-[var(--text-muted)]">{t('documents.workspace.choose_when_each_section_applies', 'Choose when each section applies. Unknown customer data needs input before a final PDF.')}</p>
            {sections.map((s,i)=><details key={s.id} className="border rounded-lg p-3"><summary className="cursor-pointer text-sm font-medium">{s.title}</summary><div className="space-y-3 mt-3"><button className={button} onClick={()=>onSection(s.id)}>{t('documents.workspace.find_in_document', 'Find in document')}</button>{field(t('documents.workspace.title', 'Title'),<input className={input} value={s.title} onChange={e=>setContract({sections:sections.map((x,j)=>i===j?{...x,title:e.target.value}:x)})}/>)}{field(t('documents.workspace.summary', 'Summary'),<textarea className={input} value={s.summary || ''} onChange={e=>setContract({sections:sections.map((x,j)=>i===j?{...x,summary:e.target.value}:x)})}/>)}<Rule rule={s.condition} parameters={parameters} onChange={condition=>setContract({sections:sections.map((x,j)=>i===j?{...x,condition}:x)})}/><button className={button} onClick={()=>action(async()=>{await save();await documentRequest(`/${doc.id}/sections/${s.id}/save`,{});setResult({message:t('documents.workspace.section_saved_to_your_library', 'Section saved to your library')});})}>{t('documents.workspace.save_to_section_library', 'Save to section library')}</button>{s.source && <p className="text-xs">{t('documents.workspace.linked_revision', 'Linked revision')}: {s.source.versionId.slice(0,8)}</p>}</div></details>)}
            <button className={button} onClick={()=>action(async()=>{await onBeforeAction();const current=(await documentRequest(`/${doc.id}`)).document;const id='section-'+crypto.randomUUID();const next={...settings,contract:{...contract,sections:[...sections,{id,title:t('documents.workspace.new_section', 'New section'),summary:'',condition:null}]}};await onSave({settings:next,bodyHtml:current.bodyHtml+`<section data-doc-section="${id}"><h2>${t('documents.workspace.new_section', 'New section')}</h2><p>${t('documents.workspace.write_your_content_here', 'Write your content here.')}</p></section>`});acceptSettings(next);})}>{t('documents.workspace.add_section', 'Add section')}</button>
            {field(t('documents.workspace.insert_reusable_content', 'Insert reusable content'),<select className={input} value="" onChange={e=>{const sourceId=e.target.value;if(sourceId)action(async()=>{await save();await onBeforeAction();const latest=await documentRequest(`/${doc.id}`);const out=await documentRequest(`/${doc.id}/insert-section`,{sourceId,expectedVersionId:latest.document.versionId});acceptSettings({...out.document.settings,contract:out.document.contract || out.document.settings.contract});onRefresh();});}}><option value="">{t('documents.workspace.choose_section', 'Choose section…')}</option>{library.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select>)}
            {updates.map(u=><div className="rounded border p-3 space-y-2" key={u.sectionId || 'template'}><p className="text-sm">{t('documents.workspace.update_available', 'Update available')}: {u.name}</p><button className={button} onClick={()=>action(async()=>{await save();const r=await documentRequest(`/${doc.id}/review-update`,{sectionId:u.sectionId});setProposal(r);})}>{t('documents.workspace.review_changes', 'Review changes')}</button></div>)}
        </>}
        {tab==='design' && isDeck && <DeckLookTab settings={settings} setSettings={setSettings} onPreviewDraft={onPreviewDraft} disabled={busy || doc.editable===false}/>}
        {tab==='design' && !isDeck && <>
            {field(t('documents.workspace.preset', 'Preset'),<select className={input} value={settings.design?.preset || 'neutral'} onChange={e=>setSettings(s=>({...s,design:{...PRESETS[e.target.value],preset:e.target.value}}))}>{Object.keys(PRESETS).map(k=><option key={k}>{k}</option>)}</select>)}
            {['accent','ink'].map(k=>field(k==='accent'?t('documents.workspace.accent_color', 'Accent color'):t('documents.workspace.text_color', 'Text color'),<input key={k} className={input+' h-10'} type="color" value={settings.design?.[k] || PRESETS.neutral[k]} onChange={e=>setDesign(k,e.target.value)}/>))}
            {field(t('documents.workspace.font', 'Font'),<select className={input} value={settings.design?.font || 'sans'} onChange={e=>setDesign('font',e.target.value)}><option value="sans">Sans serif</option><option value="serif">Serif</option><option value="mono">Monospace</option></select>)}
            {[['fontSize',t('documents.workspace.font_size', 'Font size'),8,24,1,11],['lineHeight',t('documents.workspace.line_spacing', 'Line spacing'),1,2.5,0.1,1.5],['margin',t('documents.workspace.page_margins_mm', 'Page margins (mm)'),0,40,1,18],['logoWidth',t('documents.workspace.logo_width_mm', 'Logo width (mm)'),10,80,1,24]].map(([key,label,min,max,step,fallback])=>field(label,<input key={key} className={input} type="number" min={min} max={max} step={step} value={settings.design?.[key] ?? fallback} onChange={e=>setDesign(key,Number(e.target.value))}/>))}
            {field(t('documents.workspace.paper_size', 'Paper size'),<select className={input} value={settings.design?.pageSize || 'A4'} onChange={e=>setDesign('pageSize',e.target.value)}><option>A4</option><option>Letter</option></select>)}
            {field(t('documents.workspace.logo_position', 'Logo position'),<select className={input} value={settings.design?.logoPosition || 'left'} onChange={e=>setDesign('logoPosition',e.target.value)}>{['left','center','right'].map(x=><option key={x}>{x}</option>)}</select>)}
            {['showHeader','showFooter'].map(key=><label className="flex gap-2 text-sm" key={key}><input type="checkbox" checked={settings.design?.[key]!==false} onChange={e=>setDesign(key,e.target.checked)}/>{key==='showHeader'?t('documents.workspace.show_header', 'Show header'):t('documents.workspace.show_footer', 'Show footer')}</label>)}
            <button className={button} onClick={()=>action(async()=>{await onBeforeAction();setProposal(await documentRequest(`/${doc.id}/preview-changes`,{design:settings.design}));})}>{t('documents.workspace.preview_design_changes', 'Preview design changes')}</button>
            <p className="text-xs text-[var(--text-muted)]">{t('documents.workspace.for_custom_layouts_ask_the_ai', 'For custom layouts, ask the AI assistant to convert the stylesheet to these controls. Review the preview before applying.')}</p>
        </>}
        {tab==='preview' && <>
            <p className="text-xs">{doc.kind==='document'?t('documents.workspace.customer_values_are_stored_on_this', 'Customer values are stored on this private document.'):t('documents.workspace.sample_data_is_used_only_for_this', 'Sample data is used only for this preview and is never saved to a shared template.')}</p>
            {parameters.map(p=><div key={p.key}>{field((p.label || p.key)+(p.required?' *':''),<ValueInput parameter={p} value={settings.sampleValues?.[p.key]} onChange={v=>setSettings(s=>({...s,sampleValues:{...s.sampleValues,[p.key]:v}}))}/>)}<p className="text-xs text-[var(--text-muted)] mt-1">{p.summary}</p>{p.instructions && <details className="text-xs mt-1"><summary>{t('documents.workspace.instructions', 'Instructions')}</summary>{p.instructions}</details>}</div>)}
            {sections.map(s=>field(s.title,<select key={s.id} className={input} value={settings.sectionOverrides?.[s.id] || 'automatic'} onChange={e=>setSettings(x=>({...x,sectionOverrides:{...x.sectionOverrides,[s.id]:e.target.value}}))}><option value="automatic">{t('documents.workspace.automatic_rules', 'Automatic (rules)')}</option><option value="include">{t('documents.workspace.include', 'Include')}</option><option value="exclude">{t('documents.workspace.exclude', 'Exclude')}</option></select>))}
            <button className={button} onClick={()=>action(async()=>{await save();setResult(await documentRequest(`/${doc.id}/validate`,{values:settings.sampleValues,sectionOverrides:settings.sectionOverrides}));})}>{t('documents.workspace.validate_preview', 'Validate & preview')}</button>
        </>}
        {tab==='assistant' && <>
            {history.map((m,i)=><p key={i} className={'text-sm p-2 rounded '+(m.role==='user'?'bg-[var(--bg-tertiary)]':'')}>{m.content}</p>)}
            {field(t('documents.workspace.what_would_you_like_to_change', 'What would you like to change?'),<textarea className={input} rows={5} value={message} onChange={e=>setMessage(e.target.value)} placeholder={t('documents.workspace.make_this_more_professional_with_a', 'Make this more professional, with a clear cover and compact tables…')}/>)}
            <select className={input} value={mode} onChange={e=>setMode(e.target.value)} aria-label={t('documents.workspace.assistant_mode', 'Assistant mode')}><option value="design">{isDeck?t('documents.workspace.look_only', 'Look only'):t('documents.workspace.design_only', 'Design only')}</option><option value="content">{isDeck?t('documents.workspace.slides_and_outline', 'Slides and outline'):t('documents.workspace.content_and_template', 'Content and template')}</option>{!isDeck && <option value="applicability">{t('documents.workspace.suggest_applicable_sections', 'Suggest applicable sections')}</option>}</select>
            <button className={button} disabled={!message.trim() || busy} onClick={()=>action(async()=>{await save();await onBeforeAction();const next=await documentRequest(`/${doc.id}/ai-proposal`,{message,mode,values:settings.sampleValues,history});setProposal(next);setHistory(h=>[...h,{role:'user',content:message},{role:'assistant',content:next.explanation}]);setMessage('');})}>{t('documents.workspace.prepare_a_proposal', 'Prepare a proposal')}</button>
        </>}
        {tab!=='assistant' && <button className={button+' w-full font-semibold'} onClick={()=>action(save)}>{busy?<Loader2 size={15} className="animate-spin mx-auto"/>:t('documents.workspace.save_changes', 'Save changes')}</button>}
        </fieldset>
        {result && <div className="space-y-2"><p role="status" className="text-sm font-medium">{result.message || (result.valid?t('documents.workspace.ready_to_generate', 'Ready to generate'):t('documents.workspace.draft_input_required', 'Draft — input required'))}</p>{result.issues?.map((issue,i)=><p key={i} className="text-xs text-red-600">{issue.message}</p>)}{result.sections?.map(s=><p key={s.id} className="text-xs"><strong>{s.title}: {({included:t('documents.workspace.included', 'Included'),excluded:t('documents.workspace.excluded', 'Excluded'),unresolved:t('documents.workspace.needs_input', 'Needs input')})[s.state]}</strong><br/>{s.reason}</p>)}{result.html && <button className={button} onClick={()=>setProposal({html:result.html,previewOnly:true,validation:result,explanation:result.valid?t('documents.workspace.customer_preview', 'Customer preview'):t('documents.workspace.draft_input_required', 'Draft — input required')})}>{t('documents.workspace.open_preview', 'Open preview')}</button>}</div>}
        {proposal && <Modal open onClose={()=>setProposal(null)} title={t('documents.workspace.review_proposal', 'Review proposal')} size="xl"><div className="space-y-3"><p className="font-medium">{proposal.explanation}</p>{proposal.html && <iframe title={t('documents.workspace.proposed_document', 'Proposed document')} sandbox={isDeck?'allow-scripts':''} srcDoc={proposal.html} className="w-full h-[55vh] border rounded"/>}{proposal.suggestions?.map(s=><p key={s.sectionId} className="text-sm">{s.sectionId}: {s.choice} — {s.reason}</p>)}{proposal.validation?.issues?.map((i,n)=><p className="text-xs text-red-600" key={n}>{i.message}</p>)}<div className="flex gap-2"><button className={button} onClick={()=>setProposal(null)}>{t('documents.workspace.close', 'Close')}</button>{!proposal.previewOnly && <button className={button} disabled={busy} onClick={()=>action(async()=>{const patch={...proposal.patch};if(proposal.suggestions?.length)patch.settings={...(patch.settings || settings),sectionOverrides:{...settings.sectionOverrides,...Object.fromEntries(proposal.suggestions.map(s=>[s.sectionId,s.choice]))}};await onSave({...patch,expectedVersionId:proposal.expectedVersionId,summary:'Applied reviewed proposal'});if(patch.settings)acceptSettings(patch.settings);setProposal(null);setUpdates([]);})}>{t('documents.workspace.apply_reviewed_changes', 'Apply reviewed changes')}</button>}</div></div></Modal>}
    </aside>;
});
export default DocumentWorkspacePanel;
