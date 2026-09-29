import { FileText, Folder, Plus, Search, Stamp, Copy, Trash2, ChevronRight, Loader2, Presentation } from 'lucide-react';
import React, { useCallback, useEffect, useState } from 'react';
import DocumentEditor from './DocumentEditor';
import { documentsRefusalText, useDocumentsLock } from './documentsLock';
import DocumentsLockNote from './DocumentsLockNote';
import HouseStylePanel from './HouseStylePanel';
import useDocumentText from './useDocumentText';
import useTranslation from '../../hooks/useTranslation';
import Modal from '../../components/shared/Modal';
import { listDocuments, createDocument, deleteDocument, updateDocument, documentRequest } from './documentsApi';

const button = 'inline-flex items-center gap-2 rounded-lg border border-[var(--border-subtle)] px-3 py-2 text-sm hover:bg-[var(--bg-tertiary)] disabled:opacity-50';
const input = 'rounded-lg border border-[var(--border-subtle)] bg-[var(--bg-secondary)] px-3 py-2 text-sm min-w-0';
export default function DocumentsPage({ initialDocumentId = null, onDocumentChange }) {
    const d = useDocumentText();
    const { locale } = useTranslation();
    // Studio Documents is Enterprise (`studio_documents`). Without it the
    // library stays readable: open, download, archive and delete a folder all
    // keep working, and only what MAKES or CHANGES a document is left out.
    const docsLock = useDocumentsLock();
    const [selectedId, setSelectedId] = useState(initialDocumentId);
    const [documents,setDocuments] = useState([]);
    const [folders,setFolders] = useState([]);
    const [kind,setKind] = useState('document');
    const [query,setQuery] = useState('');
    const [folderId,setFolderId] = useState(undefined);
    const [visibility,setVisibility] = useState('');
    const [format,setFormat] = useState('');   // '' = pages and presentations, 'page', 'presentation'
    const [category,setCategory] = useState('');
    const [sort,setSort] = useState('updated');
    const [offset,setOffset] = useState(0);
    const [loading,setLoading] = useState(true);
    const [error,setError] = useState('');
    const [showHouseStyle,setShowHouseStyle] = useState(false);
    const [gallery,setGallery] = useState(null);
    const [selection,setSelection] = useState([]);
    const [folderName,setFolderName] = useState('');
    const [bulkCategory,setBulkCategory] = useState('');
    const [refreshKey,setRefreshKey] = useState(0);
    const [confirmDelete,setConfirmDelete] = useState(null);
    const [busy,setBusy] = useState(false);
    const refresh = useCallback(() => setRefreshKey(k=>k+1),[]);
    useEffect(()=>setSelectedId(initialDocumentId),[initialDocumentId]);
    useEffect(()=> { setOffset(0); setSelection([]); },[query,kind,folderId,category,visibility,sort,format]);
    useEffect(()=> {
        let cancelled = false;
        setLoading(true);
        const timer = setTimeout(async()=> {
            try {
                const [docs,tree] = await Promise.all([listDocuments({kind,query,folderId,category:category || undefined,visibility:visibility || undefined,docType:format || undefined,sort,offset,limit:30}),documentRequest('/folders')]);
                if (!cancelled) {setDocuments(docs);setFolders(tree.folders);setError('');}
            } catch(e) {if (!cancelled) setError(e.message);} finally {if (!cancelled) setLoading(false);}
        },180);
        return ()=>{cancelled=true;clearTimeout(timer);};
    },[kind,query,folderId,category,visibility,format,sort,offset,refreshKey]);
    useEffect(()=> {window.addEventListener('beeflow:document-updated',refresh);return ()=>window.removeEventListener('beeflow:document-updated',refresh);},[refresh]);
    const select = id => {setSelectedId(id);onDocumentChange?.(id);};
    const act = async fn => {setBusy(true);try {await fn();refresh();}catch(e){setError(documentsRefusalText(e,d) || e.message);}finally{setBusy(false);}};
    const create = starter => act(async()=> {
        // `deck` = a blank presentation: no starter, the presentation type, an
        // empty outline the editor opens straight into.
        const blankDeck = starter && starter.deck === true;
        const doc = await createDocument({
            name: blankDeck ? d('Untitled presentation','Naamloze presentatie') : (starter?.name || d('Untitled document','Naamloos document')),
            ...(blankDeck ? { docType:'presentation', bodyHtml:'', css:'' } : { starterId:starter?.id }),
            // A presentation is never a reusable section.
            locale, kind: (blankDeck || starter?.docType === 'presentation') && kind === 'section' ? 'document' : kind, folderId,
        });
        setGallery(null);select(doc.id);
    });
    const typeLabel = doc => doc.docType === 'presentation' ? d('Presentation','Presentatie') : doc.docType;
    const bulk = patch => act(async()=> {
        for (const doc of documents.filter(x=>selection.includes(x.id))) await updateDocument(doc.id,{...patch,expectedVersionId:doc.versionId});
        setSelection([]);
    });
    if (showHouseStyle) return <HouseStylePanel onBack={()=>setShowHouseStyle(false)}/>;
    if (selectedId) return <DocumentEditor key={selectedId} documentId={selectedId} onBack={()=>{select(null);refresh();}} onRenamed={refresh}/>;
    const parent = folders.find(f=>f.id===folderId);
    const visibleFolders = folders.filter(f=>(f.parentId || null)===(folderId || null));
    return <div className="h-full overflow-auto text-[var(--text-primary)] bg-[var(--bg-primary)]">
        <div className="max-w-7xl mx-auto p-5 md:p-8 space-y-5">
            <header className="flex flex-wrap items-start gap-3">
                <div className="flex-1"><h1 className="text-2xl font-bold">{d('Documents','Documenten')}</h1><p className="text-sm text-[var(--text-muted)] mt-1">{d('Documents and presentations. Design once. Adapt to every customer.','Documenten en presentaties. Eenmaal ontwerpen. Aanpassen aan iedere klant.')}</p></div>
                <button className={button} data-testid="documents-house-style" onClick={()=>setShowHouseStyle(true)}><Stamp size={16}/>{d('House style','Huisstijl')}</button>
                {!docsLock && <button className={button+' bg-[var(--accent-primary)] text-white'} disabled={busy} onClick={()=>act(async()=>setGallery((await documentRequest('/starters?locale='+encodeURIComponent(locale || 'en'))).starters))}><Plus size={16}/>{d('New document','Nieuw document')}</button>}
            </header>
            <DocumentsLockNote reason={docsLock} d={d} iconSize={15} className="p-3 rounded-lg text-sm border border-[var(--border-subtle)] bg-[var(--bg-secondary)]"/>
            <nav className="flex gap-2 border-b border-[var(--border-subtle)] pb-3" aria-label={d('Library views','Bibliotheekweergaven')}>
                {[['document',d('Documents','Documenten')],['template',d('Templates','Sjablonen')],['section',d('Reusable sections','Herbruikbare onderdelen')]].map(([key,label])=><button key={key} aria-pressed={kind===key} onClick={()=>setKind(key)} className={button+(kind===key?' bg-[var(--bg-tertiary)] font-semibold':'')}>{label}</button>)}
            </nav>
            <div className="flex flex-wrap gap-2">
                <label className="flex items-center gap-2 flex-1 min-w-48"><Search size={17}/><input className={input+' w-full'} value={query} onChange={e=>setQuery(e.target.value)} placeholder={d('Search documents…','Documenten zoeken…')} aria-label={d('Search documents','Documenten zoeken')}/></label>
                <select className={input} value={format} onChange={e=>setFormat(e.target.value)} aria-label={d('Document type','Documenttype')} data-testid="documents-format-filter"><option value="">{d('Pages & presentations','Pagina’s en presentaties')}</option><option value="page">{d('Pages','Pagina’s')}</option><option value="presentation">{d('Presentations','Presentaties')}</option></select>
                <select className={input} value={visibility} onChange={e=>setVisibility(e.target.value)} aria-label={d('Visibility','Zichtbaarheid')}><option value="">{d('Private & team','Privé en team')}</option><option value="private">{d('Private','Privé')}</option><option value="team">Team</option></select>
                <input className={input} value={category} onChange={e=>setCategory(e.target.value)} placeholder={d('Filter category','Categorie filteren')} aria-label={d('Category filter','Categoriefilter')}/>
                <select className={input} value={sort} onChange={e=>setSort(e.target.value)} aria-label={d('Sort','Sorteren')}><option value="updated">{d('Recently updated','Recent gewijzigd')}</option><option value="name">{d('Name','Naam')}</option></select>
            </div>
            {error && <div role="alert" className="p-3 rounded-lg bg-red-500/10">{error}</div>}
            <div className="grid md:grid-cols-[220px_1fr] gap-6">
                <aside className="space-y-2">
                    <button className={button+' w-full'} onClick={()=>setFolderId(undefined)}>{d('All documents','Alle documenten')}</button>
                    <button className={button+' w-full'} onClick={()=>setFolderId('')}>{d('Root folder','Hoofdmap')}</button>
                    {parent && <div className="flex items-center gap-1 text-sm"><button onClick={()=>setFolderId(parent.parentId || '')}>{d('Back','Terug')}</button><ChevronRight size={14}/>{parent.name}<button className="ml-auto p-1" aria-label={d('Delete folder','Map verwijderen')} onClick={()=>act(async()=>{await documentRequest(`/folders/${parent.id}`,undefined,'DELETE');setFolderId(parent.parentId || '');})}><Trash2 size={13}/></button></div>}
                    {visibleFolders.map(f=><button className={button+' w-full text-left'} key={f.id} onClick={()=>setFolderId(f.id)}><Folder size={15}/>{f.name}</button>)}
                    {!docsLock && <form className="flex gap-1 pt-2" onSubmit={e=>{e.preventDefault();act(async()=>{await documentRequest('/folders',{name:folderName,parentId:folderId || null});setFolderName('');});}}><input className={input+' w-full'} value={folderName} onChange={e=>setFolderName(e.target.value)} placeholder={d('New folder','Nieuwe map')} aria-label={d('New folder name','Nieuwe mapnaam')}/><button className={button} disabled={!folderName.trim() || busy} aria-label={d('Create folder','Map maken')}><Plus size={14}/></button></form>}
                </aside>
                <main className="space-y-3 min-w-0">
                    {!!selection.length && <div className="flex flex-wrap gap-2 p-3 rounded-lg bg-[var(--bg-tertiary)]"><span className="self-center text-sm">{selection.length} {d('selected','geselecteerd')}</span><select className={input} value="" aria-label={d('Move selected','Selectie verplaatsen')} onChange={e=>bulk({folderId:e.target.value==='root'?null:e.target.value})}><option value="">{d('Move to…','Verplaatsen naar…')}</option><option value="root">{d('Root','Hoofdmap')}</option>{folders.map(f=><option key={f.id} value={f.id}>{f.name}</option>)}</select><input className={input} value={bulkCategory} onChange={e=>setBulkCategory(e.target.value)} placeholder={d('Categories, separated by commas','Categorieën, gescheiden door komma’s')}/><button className={button} disabled={busy} onClick={()=>bulk({categories:bulkCategory.split(',').map(x=>x.trim()).filter(Boolean)})}>{d('Set categories','Categorieën instellen')}</button></div>}
                    {loading ? <Loader2 className="animate-spin mx-auto my-16"/> : !documents.length ? <div className="border border-dashed rounded-xl p-12 text-center"><FileText className="mx-auto mb-3"/><p>{d('No documents here yet. Start from a template or create your own.','Nog geen documenten. Begin met een sjabloon of maak er zelf een.')}</p></div> : <ul className="space-y-2">{documents.map(doc=><li key={doc.id} className="flex gap-3 items-center p-4 rounded-xl border border-[var(--border-subtle)] bg-[var(--bg-secondary)]">
                        {!docsLock && <input type="checkbox" checked={selection.includes(doc.id)} aria-label={`${d('Select','Selecteer')} ${doc.name}`} onChange={e=>setSelection(prev=>e.target.checked?[...prev,doc.id]:prev.filter(x=>x!==doc.id))}/>}{doc.docType==='presentation' ? <Presentation size={20} className="shrink-0 text-[var(--accent-primary)]" data-testid="document-deck-icon"/> : <FileText size={20} className="shrink-0 text-[var(--accent-primary)]"/>}
                        <button className="flex-1 min-w-0 text-left" onClick={()=>select(doc.id)}><span className="block font-medium truncate">{doc.name}</span><span className="block text-xs text-[var(--text-muted)] mt-1">{typeLabel(doc)} · {new Date(doc.updatedAt).toLocaleDateString()} · {doc.visibility==='team'?'Team':d('Private','Privé')}</span>{!!doc.categories?.length && <span className="block text-xs mt-1">{doc.categories.join(' · ')}</span>}</button>
                        {!docsLock && <button className={button} title={d('Duplicate / use template','Dupliceren / sjabloon gebruiken')} aria-label={d('Duplicate / use template','Dupliceren / sjabloon gebruiken')} onClick={()=>act(async()=>select((await documentRequest(`/${doc.id}/duplicate`,{kind:'document'})).document.id))}><Copy size={15}/></button>}
                        {confirmDelete===doc.id ? <><button className={button} onClick={()=>act(async()=>{await deleteDocument(doc.id);setConfirmDelete(null);})}>{d('Archive','Archiveren')}</button><button className={button} onClick={()=>setConfirmDelete(null)}>{d('Cancel','Annuleren')}</button></> : <button className={button} aria-label={d('Archive document','Document archiveren')} onClick={()=>setConfirmDelete(doc.id)}><Trash2 size={15}/></button>}
                    </li>)}</ul>}
                    <div className="flex justify-end items-center gap-3"><button className={button} disabled={!offset || loading} onClick={()=>setOffset(Math.max(0,offset-30))}>{d('Previous','Vorige')}</button><span className="text-sm">{Math.floor(offset/30)+1}</span><button className={button} disabled={documents.length<30 || loading} onClick={()=>setOffset(offset+30)}>{d('Next','Volgende')}</button></div>
                </main>
            </div>
            {gallery && <Modal open onClose={()=>setGallery(null)} title={d('Choose a template','Kies een sjabloon')} size="lg"><div className="space-y-4"><div className="flex justify-between"><h2 className="text-xl font-semibold">{d('Start a document','Begin een document')}</h2><button className={button} onClick={()=>setGallery(null)}>{d('Close','Sluiten')}</button></div>
                <div className="grid sm:grid-cols-2 gap-3"><button className={button+' p-6'} disabled={busy} onClick={()=>create(null)}><Plus/>{d('Blank document','Leeg document')}</button>{gallery.filter(s=>s.docType!=='presentation').map(starter=><button key={starter.id} className={button+' p-5 text-left flex-col items-start'} disabled={busy} onClick={()=>create(starter)}><FileText/><strong>{starter.name}</strong><span className="text-xs text-[var(--text-muted)]">{starter.settings.contract.parameters.length} {d('parameters','parameters')}</span></button>)}</div>
                <h3 className="text-sm font-semibold pt-2">{d('Presentations','Presentaties')}</h3>
                <p className="text-xs text-[var(--text-muted)]">{d('Slides in the house style: an outline you type, viewed here and downloaded as PowerPoint or PDF. Placeholders make it a template a routine can fill.','Slides in de huisstijl: een outline die je typt, hier te bekijken en te downloaden als PowerPoint of PDF. Met invulvelden wordt het een sjabloon dat een routine kan invullen.')}</p>
                <div className="grid sm:grid-cols-2 gap-3"><button className={button+' p-6'} disabled={busy} onClick={()=>create({deck:true})} data-testid="documents-new-presentation"><Plus/>{d('Blank presentation','Lege presentatie')}</button>{gallery.filter(s=>s.docType==='presentation').map(starter=><button key={starter.id} className={button+' p-5 text-left flex-col items-start'} disabled={busy} onClick={()=>create(starter)}><Presentation/><strong>{starter.name}</strong><span className="text-xs text-[var(--text-muted)]">{starter.settings.contract.parameters.length} {d('parameters','parameters')}</span></button>)}</div></div></Modal>}
        </div>
    </div>;
}
