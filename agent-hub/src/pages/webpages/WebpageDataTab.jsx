import React, { useState } from 'react';
import WebpageActionsPanel from './WebpageActionsPanel';
import WebpageAudiencePanel from './WebpageAudiencePanel';
import WebpageDataCards from './WebpageDataCards';
import WebpageDbViewer from './WebpageDbViewer';
import WebpageSources from './WebpageSources';
import SegmentedControl from '../../components/shared/SegmentedControl';
import useTranslation from '../../hooks/useTranslation';

/**
 * "Data & links" — the header tab that gives a page's data surfaces a home of
 * their own (plan W2). The grants list, Sources and Database already existed as
 * sidebar panes of the IDE, reachable only after switching to the developer
 * view; those are not new panels, only a new way in that does not require the
 * code editor. Overview and Actions (W3) ARE new; Overview is the default.
 *
 *   Overview  the W3 cards: which datatables this page is bound to (rows,
 *             column chips, a dashed "not used" when the page's own code never
 *             names it), which routines feed those tables, the page's own
 *             knowledge sources, and a warning per routine that writes straight
 *             into a bound table.
 *   Actions   what the page SETS OFF: the static scan of its own code for calls
 *             that go around Studio, the forms and agent blocks that arrive
 *             with `bf-*` (W4), and — promoted from the IDE sidebar into this
 *             surface — the bridge grants (WebpageAppsPanel): which routines
 *             and integrations this page's script may call.
 *   Audience  WHO can see it and WHERE it lives (W3 step 4): the three shared
 *             audience rows plus a fourth, Public — one canonical unlisted
 *             share at /w/<slug> — with the column gate that decides what a
 *             bound table may put on that public page, the address card with
 *             "All options" (password, email, expiry), and the solution this
 *             page belongs to.
 *   Sources   the documents and URLs the AI reads when building the page.
 *   Database  the page's own SQLite table viewer.
 *
 * The sub-nav is the shared SegmentedControl rather than a second tab strip:
 * the header's strip says WHICH SECTION of the page you are in, this says
 * which of the section's five surfaces — a different question, and it must
 * not look like the same one.
 */
export default function WebpageDataTab({
    webpageId, sources, onSourcesChange, readOnly = false, theme = 'light', onNavigate = null,
    // Voor het Audience-segment: de pagina-rij en de drie schrijfacties van de
    // interne rijen. Ze komen ONGEWIJZIGD van WebpageEditorHeader's capsule —
    // dezelfde handlers, dezelfde PATCH /:id/publish — zodat er geen tweede weg
    // naar `is_published` / `shared_groups` ontstaat.
    page = null, orgGroups = [], onSetPersonal = null, onSetEntireOrg = null, onToggleGroup = null,
}) {
    const { t } = useTranslation();
    // 'overview' is de default: de kaarten zijn het antwoord op "wat hangt er
    // aan deze pagina", en dat is de vraag waarmee iemand deze tab opent.
    const [pane, setPane] = useState('overview');

    return (
        <div className="flex flex-col h-full min-h-0" style={{ background: 'var(--bg-primary)' }}>
            <div className="shrink-0 px-3 py-2 border-b" style={{ borderColor: 'var(--border-subtle)' }}>
                <SegmentedControl
                    size="sm"
                    ariaLabel={t('webpages.data.panes', 'Data surfaces')}
                    value={pane}
                    onChange={setPane}
                    options={[
                        { value: 'overview', label: t('webpages.data.overview', 'Overview') },
                        { value: 'actions', label: t('common.actions', 'Actions') },
                        { value: 'audience', label: t('webpages.data.audience', 'Who can see it') },
                        { value: 'sources', label: t('webpages.data.sources', 'Sources'), badge: { count: (sources || []).length || undefined } },
                        { value: 'database', label: t('webpages.data.database', 'Database') },
                    ]}
                />
            </div>
            <div className="flex-1 min-h-0 overflow-auto custom-scrollbar">
                {pane === 'overview' && (
                    <WebpageDataCards webpageId={webpageId} sources={sources} onNavigate={onNavigate} />
                )}
                {pane === 'actions' && (
                    <WebpageActionsPanel webpageId={webpageId} readOnly={readOnly} onNavigate={onNavigate} />
                )}
                {pane === 'audience' && (
                    <WebpageAudiencePanel
                        webpageId={webpageId}
                        page={page}
                        orgGroups={orgGroups}
                        readOnly={readOnly}
                        onSetPersonal={onSetPersonal}
                        onSetEntireOrg={onSetEntireOrg}
                        onToggleGroup={onToggleGroup}
                    />
                )}
                {pane === 'sources' && (
                    <WebpageSources webpageId={webpageId} sources={sources} onSourcesChange={onSourcesChange} />
                )}
                {pane === 'database' && <WebpageDbViewer webpageId={webpageId} theme={theme} />}
            </div>
        </div>
    );
}
