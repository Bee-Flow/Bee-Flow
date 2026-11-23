/**
 * Where a filled-in document is kept, chosen on the fill-in form:
 *
 *   - a person's own document: "Save in project" files it into one of the
 *     projects they own or edit (api/documentFilingApi.ts), and into a folder
 *     of that project's Documents tab when they pick one (a customer's
 *     folder, say), or a new folder they name on the spot;
 *   - a document that is a project's already: "Put in a folder" moves it
 *     between that project's folders.
 *
 * The picker opens in place under the buttons, so it is never cut off by the
 * chat column or the editor's side panel. Afterwards it says where the
 * document is, with a link that opens it there.
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderInput } from 'lucide-react';

import { filingApi, projectDocumentUrl, type FilingApi, type FilingTarget } from '@/api/documentFilingApi';
import { useOptionalQueryClient } from '@/api/queries/optionalQueryClient';
import type { DocumentFolder } from '@/api/queries/projectDocumentFolders';
import useTranslation from '@/hooks/useTranslation';
import { messageOf } from '@/utils/caughtError';
import { logger } from '@/utils/logger';

const BUTTON = 'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium border border-[var(--border-subtle)] text-[var(--text-primary)] bg-[var(--bg-primary)] disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent-primary)]';
const SMALL = 'rounded-md px-2 py-1 text-xs font-medium focus:outline-none focus:ring-2 focus:ring-[var(--accent-primary)] disabled:opacity-50';
const ROW = 'flex items-center gap-2 rounded-md px-2 py-1 text-sm text-[var(--text-primary)] hover:bg-[var(--item-hover-bg)]';
const NEW = '__new__';
const NONE = '';
const FOLDER_NAME_MAX = 120;
const SEARCH_FROM = 8;

/** In-app navigation, as DocumentLinkCard does it: the shell listens for popstate. */
function openInApp(path: string) {
    window.history.pushState({ page: 'projects' }, '', path);
    window.dispatchEvent(new PopStateEvent('popstate', { state: { page: 'projects' } }));
}

interface Saved { project: FilingTarget | null; folder: string | null }
type Step =
    | { at: 'closed' }
    | { at: 'loading' }
    | { at: 'projects'; projects: FilingTarget[] }
    | { at: 'folders'; project: FilingTarget | null; folders: DocumentFolder[]; current: string }
    | { at: 'failed'; message: string };

function ProjectList({ projects, onPick }: { projects: FilingTarget[]; onPick: (p: FilingTarget) => void }) {
    const { t } = useTranslation();
    const [search, setSearch] = useState('');
    const needle = search.trim().toLowerCase();
    const shown = needle ? projects.filter((p) => p.name.toLowerCase().includes(needle)) : projects;
    if (projects.length === 0) {
        return <p className="m-0 text-xs text-[var(--text-secondary)]">{t('chat_templates.add_to_project_none', 'You have no project you can add documents to.')}</p>;
    }
    return (
        <div className="flex flex-col gap-1">
            <p className="m-0 text-xs font-semibold text-[var(--text-secondary)]">{t('chat_templates.save_which_project', 'In which project?')}</p>
            {projects.length >= SEARCH_FROM && (
                <input type="search" value={search} onChange={(e) => setSearch(e.target.value)}
                    aria-label={t('chat_templates.save_search', 'Search projects')} placeholder={t('chat_templates.save_search', 'Search projects')}
                    className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]" />
            )}
            <ul className="m-0 flex max-h-48 list-none flex-col overflow-y-auto p-0">
                {shown.map((p) => (
                    <li key={p.id}><button type="button" onClick={() => onPick(p)} className={`${ROW} w-full text-left`}>{p.name}</button></li>
                ))}
            </ul>
        </div>
    );
}

function FolderPicker({ step, busy, onSave, onBack }: {
    step: Extract<Step, { at: 'folders' }>; busy: boolean; onSave: (folderId: string, newName: string) => void; onBack: () => void;
}) {
    const { t } = useTranslation();
    const [picked, setPicked] = useState(step.current);
    const [newName, setNewName] = useState('');
    const option = (value: string, label: string) => (
        <label key={value || 'none'} className={ROW}>
            <input type="radio" name="fill-folder" checked={picked === value} onChange={() => setPicked(value)} />{label}
        </label>
    );
    return (
        <div className="flex flex-col gap-1" data-testid="save-to-project-folders">
            <p className="m-0 text-xs font-semibold text-[var(--text-secondary)]">
                {step.project
                    ? t('chat_templates.save_which_folder_in', 'Where in {project}?', { project: step.project.name })
                    : t('chat_templates.save_which_folder', 'In which folder of this project?')}
            </p>
            <div role="radiogroup" className="flex max-h-48 flex-col overflow-y-auto">
                {option(NONE, t('chat_templates.save_no_folder', 'No folder (with the project’s other documents)'))}
                {step.folders.map((f) => option(f.id, f.name))}
                {option(NEW, t('chat_templates.save_new_folder', 'A new folder…'))}
            </div>
            {picked === NEW && (
                <input type="text" value={newName} maxLength={FOLDER_NAME_MAX} onChange={(e) => setNewName(e.target.value)}
                    aria-label={t('chat_templates.save_new_folder_name', 'Name of the new folder')}
                    placeholder={t('chat_templates.save_new_folder_hint', 'For example the customer’s name')}
                    className="rounded-md border border-[var(--border-subtle)] bg-[var(--bg-primary)] px-2 py-1 text-sm text-[var(--text-primary)]" />
            )}
            <div className="flex gap-2 pt-1">
                <button type="button" disabled={busy || (picked === NEW && !newName.trim())} onClick={() => onSave(picked, newName)} data-testid="save-to-project-confirm"
                    className={`${SMALL} bg-[var(--accent-primary)] text-[var(--accent-primary-fg,#fff)]`}>
                    {step.project ? t('chat_templates.save_here', 'Save here') : t('chat_templates.save_move', 'Move here')}
                </button>
                <button type="button" onClick={onBack} className={`${SMALL} text-[var(--text-secondary)]`}>
                    {step.project ? t('chat_templates.save_back', 'Back') : t('doc_value_requests.cancel', 'Cancel')}
                </button>
            </div>
        </div>
    );
}

/** Where the document was saved, as a link that opens it there. */
function SavedLine({ saved, href }: { saved: Saved; href: string }) {
    const { t } = useTranslation();
    let text = t('chat_templates.saved_no_folder', 'Not in a folder');
    if (saved.project && saved.folder) text = t('chat_templates.saved_in_project_folder', 'In project {name}, folder {folder}', { name: saved.project.name, folder: saved.folder });
    else if (saved.project) text = t('chat_templates.added_to_project', 'In project {name}', { name: saved.project.name });
    else if (saved.folder) text = t('chat_templates.saved_in_folder', 'In folder {folder}', { folder: saved.folder });
    return (
        <a href={href} data-testid="template-fill-added-to-project" onClick={(e) => { e.preventDefault(); openInApp(href); }}
            className="text-sm text-[var(--accent-primary)] underline">{text}</a>
    );
}

/** What was picked, as the save takes it. A "new" folder by the name of one that exists is that folder: no second one of the same name. */
function folderChoice(folders: DocumentFolder[], picked: string, newName: string): { folderId: string | null; newName?: string } {
    if (picked !== NEW) return { folderId: picked || null };
    const wanted = newName.trim().toLowerCase();
    const existing = folders.find((f) => f.name.trim().toLowerCase() === wanted);
    return existing ? { folderId: existing.id } : { folderId: null, newName };
}

/** The picker's steps: the projects, then the folders, then the save. */
function usePicker({ documentId, projectId, filing, onFiled }: { documentId: string; projectId: string | null; filing: FilingApi; onFiled?: (projectId: string) => void }) {
    const { t } = useTranslation();
    const [step, setStep] = useState<Step>({ at: 'closed' });
    const [busy, setBusy] = useState(false);
    const [saved, setSaved] = useState<Saved | null>(null);
    const fail = (err: unknown) => {
        logger.debug('saving the document in a project failed', err);
        setStep({ at: 'failed', message: messageOf(err, t('chat_templates.add_to_project_failed', 'Could not add it to the project. Try again.')) });
    };
    const showFolders = async (project: FilingTarget | null, inProject: string) => {
        setStep({ at: 'loading' });
        try {
            const { folders, placements } = await filing.folders(inProject);
            setStep({ at: 'folders', project, folders, current: placements[documentId] || NONE });
        } catch (err) { fail(err); }
    };
    const open = async () => {
        if (projectId) { await showFolders(null, projectId); return; }
        setStep({ at: 'loading' });
        try { setStep({ at: 'projects', projects: await filing.targets() }); } catch (err) { fail(err); }
    };
    const save = async (at: Extract<Step, { at: 'folders' }>, folderId: string, newName: string) => {
        const target = at.project?.id || projectId;
        if (!target) return;
        setBusy(true);
        try {
            if (at.project) await filing.add(at.project.id, documentId);
            const placed = await filing.place(target, documentId, folderChoice(at.folders, folderId, newName));
            const folder = placed ? placed.name || at.folders.find((f) => f.id === placed.id)?.name || null : null;
            setSaved({ project: at.project, folder });
            setStep({ at: 'closed' });
            if (at.project) onFiled?.(at.project.id);
        } catch (err) { fail(err); } finally { setBusy(false); }
    };
    return { step, busy, saved, open, save, showFolders, close: () => setStep({ at: 'closed' }) };
}

type Picker = ReturnType<typeof usePicker>;

/** The folder a project's document is in now, by name; null for none, or while that is not known. */
function useCurrentFolder(filing: FilingApi, projectId: string | null, documentId: string): string | null {
    const { client, attached } = useOptionalQueryClient();
    const query = useQuery({
        queryKey: ['projects', projectId, 'document-folders', 'of', documentId],
        enabled: attached && !!projectId,
        queryFn: () => filing.folders(projectId || ''),
        staleTime: 15_000,
        retry: false,
    }, client);
    const folderId = query.data?.placements[documentId];
    return folderId ? query.data?.folders.find((f) => f.id === folderId)?.name ?? null : null;
}

/** The open picker: what went wrong, the projects, or the folders of the chosen one. */
function PickerPanel({ picker }: { picker: Picker }) {
    const { step } = picker;
    if (step.at === 'closed' || step.at === 'loading') return null;
    return (
        <div className="order-last basis-full rounded-lg border border-[var(--border-default)] bg-[var(--bg-primary)] p-2" data-testid="save-to-project-panel">
            {step.at === 'failed' && <p role="alert" className="m-0 text-xs text-[var(--error)]">{step.message}</p>}
            {step.at === 'projects' && <ProjectList projects={step.projects} onPick={(p) => { void picker.showFolders(p, p.id); }} />}
            {step.at === 'folders' && (
                <FolderPicker step={step} busy={picker.busy} onSave={(folderId, newName) => { void picker.save(step, folderId, newName); }}
                    onBack={() => (step.project ? void picker.open() : picker.close())} />
            )}
        </div>
    );
}

export default function SaveToProject({ documentId, projectId, filing = filingApi, onFiled }: {
    documentId: string;
    filing?: FilingApi;
    /** The project the document is in already; null for a person's own document, which is filed first. */
    projectId: string | null;
    onFiled?: (projectId: string) => void;
}) {
    const { t } = useTranslation();
    const picker = usePicker({ documentId, projectId, filing, onFiled });
    const current = useCurrentFolder(filing, projectId, documentId);
    const { step } = picker;
    // Where it is: what was just chosen here, else the folder the project's document is in already.
    const saved = picker.saved ?? (current ? { project: null, folder: current } : null);
    const filedIn = saved?.project?.id || projectId;
    const isOpen = step.at !== 'closed';
    const label = saved?.folder ? t('chat_templates.move_folder', 'Move to another folder') : t('chat_templates.put_in_folder', 'Put in a folder');
    return (
        <>
            {saved && filedIn && <SavedLine saved={saved} href={projectDocumentUrl(filedIn, documentId)} />}
            {!(saved?.project) && (
                <button type="button" className={BUTTON} data-testid="template-fill-add-to-project" aria-expanded={isOpen}
                    disabled={step.at === 'loading' || picker.busy} onClick={() => (isOpen ? picker.close() : void picker.open())}>
                    <FolderInput size={14} aria-hidden="true" />
                    {projectId ? label : t('chat_templates.save_in_project', 'Save in project')}
                </button>
            )}
            <PickerPanel picker={picker} />
        </>
    );
}
