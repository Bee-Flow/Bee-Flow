import { AlertCircle, ClipboardList } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import EmptyState from '../../components/shared/EmptyState';
import useAutomationApi from '../../hooks/useAutomationApi';
import { rememberFormOpened } from '../../utils/formRecents';

/**
 * FormsHomePage — the directory at /app/forms.
 *
 * Every form published in the organisation. A published form has a public URL,
 * so it belongs to the organisation rather than to whoever built the automation
 * behind it — it used to be findable only by opening that automation and knowing
 * which panel held the link, which meant a colleague on holiday took the only
 * copy of the address with them.
 *
 * A tile is the form, not a record about the form: the whole card is a link
 * that opens it, and nothing else is on show. The address, the submission
 * count and the way through to the automation were all here at first and were
 * taken out — they turn a directory you scan into a table you read. The
 * address is still one click away, in the browser's own address bar, which is
 * also where you copy it from.
 *
 * The card mirrors AppsHomePage's, because a form and an app are the same kind
 * of thing to the person looking for one.
 */

const CARD_CLASSES = 'group relative rounded-xl border p-3.5 transition-all hover:shadow-md text-left block no-underline';
const CARD_STYLE = { borderColor: 'var(--border-subtle)', background: 'var(--bg-card)' };
const GRID_CLASSES = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3';

const ACCENT = '#0F766E';
const accentTile = () => ({ background: `${ACCENT}1a`, color: ACCENT });

/**
 * Where a tile goes: the in-app view, not the form's own /f/<token> address.
 *
 * Forms are signed-in only for now, so /f/<token> is a redirect to exactly
 * this. Pointing at the destination keeps the sidebar, and makes the address
 * bar show something a colleague can be sent.
 */
export function formViewPath(form) {
    return `/app/forms/${form?.id}`;
}

function FormCard({ form, onNavigate }) {
    // A real href, so the row can be middle-clicked, copied and read in the
    // status bar — but an in-app navigation on a plain left click, so opening
    // a form does not reload the workspace.
    const go = (e) => {
        rememberFormOpened(form.id);
        if (!onNavigate || e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        onNavigate(`forms/${form.id}`);
    };
    return (
        <a href={formViewPath(form)} className={CARD_CLASSES} style={CARD_STYLE} onClick={go}>
            <div className="flex items-start gap-2.5">
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg shrink-0" style={accentTile()}>
                    <ClipboardList className="w-4.5 h-4.5" />
                </span>
                <div className="flex-1 min-w-0 pt-0.5">
                    <div className="text-sm font-semibold truncate" style={{ color: 'var(--text-primary)' }}>
                        {form.title}
                    </div>
                    {form.description ? (
                        <div className="text-xs mt-0.5 line-clamp-2" style={{ color: 'var(--text-secondary)' }}>
                            {form.description}
                        </div>
                    ) : null}
                    {/* A form whose automation is paused or still a draft answers
                        404 to its visitors (formPublic.js's loadForm). The one
                        piece of state worth keeping on the tile: without it the
                        card promises something the link will not deliver. */}
                    {!form.live && (
                        <div
                            className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded-full border"
                            style={{ color: 'var(--text-tertiary)', borderColor: 'var(--border-subtle)' }}
                        >
                            Not live — the automation is paused or still a draft
                        </div>
                    )}
                </div>
            </div>
        </a>
    );
}

function SkeletonGrid() {
    return (
        <div className={GRID_CLASSES} role="status" aria-label="Loading forms">
            {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className={`${CARD_CLASSES} animate-pulse`} style={CARD_STYLE}>
                    <div className="flex items-start gap-2.5">
                        <div className="h-9 w-9 rounded-lg" style={{ background: 'var(--bg-secondary)' }} />
                        <div className="flex-1 pt-0.5">
                            <div className="h-3.5 w-2/3 rounded mb-2" style={{ background: 'var(--bg-secondary)' }} />
                            <div className="h-2.5 w-full rounded" style={{ background: 'var(--bg-secondary)' }} />
                        </div>
                    </div>
                </div>
            ))}
            <span className="sr-only">Loading…</span>
        </div>
    );
}

export default function FormsHomePage({ onNavigate = null }) {
    const api = useAutomationApi();
    const [forms, setForms] = useState([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const load = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            const res = await api.listOrgForms();
            // A tile is a form this person can FILL IN. `canOpen` is the
            // visitor gate's own verdict per row (a form shared with specific
            // people and groups is not for everyone); a row that predates
            // the flag is one the gate lets through.
            setForms((Array.isArray(res?.forms) ? res.forms : []).filter(f => f && f.canOpen !== false));
        } catch (err) {
            setError(err?.message || 'Could not load the forms.');
        } finally {
            setLoading(false);
        }
    }, [api]);

    useEffect(() => { load(); }, [load]);

    const isEmpty = !loading && !error && forms.length === 0;

    return (
        <div className="flex flex-col h-full" style={{ background: 'var(--bg-primary)' }}>
            <div className="shrink-0 px-4 py-3 border-b flex items-center gap-3" style={{ borderColor: 'var(--border-subtle)' }}>
                <div className="flex-1 flex items-center gap-2 min-w-0">
                    <ClipboardList className="w-5 h-5 shrink-0" style={{ color: 'var(--accent-primary)' }} />
                    <h1 className="text-lg font-semibold truncate" style={{ color: 'var(--text-primary)' }}>Forms</h1>
                </div>
            </div>

            {error && (
                <div
                    className="shrink-0 px-4 py-2 text-xs flex items-center gap-2"
                    style={{ background: 'rgba(239,68,68,0.1)', color: '#991b1b' }}
                    role="alert"
                >
                    <AlertCircle className="w-3.5 h-3.5 shrink-0" /> {error}
                    <button type="button" onClick={load} className="ml-auto underline font-medium">Retry</button>
                </div>
            )}

            <div className="flex-1 overflow-y-auto custom-scrollbar p-4">
                {loading ? (
                    <SkeletonGrid />
                ) : isEmpty ? (
                    <EmptyState
                        icon={<ClipboardList className="w-12 h-12" />}
                        title="No forms yet"
                        description="A form is a page the colleagues it is shared with can fill in. Build one in Studio and it will appear here."
                    />
                ) : (
                    <div className={GRID_CLASSES}>
                        {forms.map((form) => <FormCard key={form.id} form={form} onNavigate={onNavigate} />)}
                    </div>
                )}
            </div>
        </div>
    );
}
