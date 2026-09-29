import { useState } from 'react';
import Tabs from '../../../../shared/Tabs';
import AccessMatrix from '../rbac/AccessMatrix';
import RolesManager from '../rbac/RolesManager';
import RowRuleEditor from '../rbac/RowRuleEditor';
import { listVariables } from '../state/definitionOps';
import TablesManager from '../tables/TablesManager';
import VariablesManager from '../variables/VariablesManager';
import useTranslation from '../../../../../hooks/useTranslation';

/**
 * App Studio editor — the VIEWS the header's segments open in place of the
 * canvas (Studio artboard 1b: `Bewerken · Voorvertoning · Data · Logica n ·
 * Rollen`). Data and Roles used to be modals launched from header buttons;
 * they are full-height views now, mounted by EditorHeader right after its own
 * row, so the shell only has to hide the canvas while one is open (it learns
 * which through `onViewChange`). The Logica segment is its own module
 * (editor/LogicaTab.jsx) — it fetches, so it does not belong beside two views
 * that read nothing but the definition.
 *
 *   DataView   Tables | Variables. Tables is TablesManager — it runs
 *              react-query (useAppTables), so it is mounted only while the
 *              view is open and the QueryClient stays optional for the rest of
 *              the editor chrome. Variables is a SUBTAB here — a deviation
 *              from the artboard, which dropped it from the bar: the named
 *              values exist and formulas read them as vars.<name>. It stages
 *              nothing (every edit commits through definitionOps), so it
 *              needs no guard.
 *   RolesView  Roles | Screen access | Row rules. The panels stay MOUNTED and
 *              are toggled with `hidden`: RolesManager and RowRuleEditor hold
 *              their edits in local draft state that only their own Save
 *              persists, so unmounting a subtab would silently throw that work
 *              away. They report through onDirtyChange so the header can
 *              guard LEAVING the view (the same "Close without saving?" the
 *              modal had).
 */

export function DataView({ app, definition, screenId, onCommit, dispatch, disabled = false, onLeave, initialTab = 'tables' }) {
    const { t } = useTranslation();
    const [tab, setTab] = useState(initialTab);
    // The table designer opens with the view (it IS the Tables subtab), but
    // closing it must not close the view — see the comment at its mount.
    const [designerOpen, setDesignerOpen] = useState(initialTab === 'tables');
    const variableCount = listVariables(definition).length;
    return (
        <div className="flex min-h-0 flex-1 flex-col" data-editor-view="data">
            <div className="border-b px-3" style={{ borderColor: 'var(--border-default)' }}>
                <Tabs
                    size="sm"
                    value={tab}
                    onChange={setTab}
                    ariaLabel={t('app_studio.views.data_tabs_aria', 'Data')}
                    items={[
                        { id: 'tables', label: t('app_studio.views.tables', 'Tables') },
                        { id: 'variables', label: t('app_studio.views.variables', 'Variables'), badge: variableCount || null },
                    ]}
                />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
                <div hidden={tab !== 'tables'} className="p-4">
                    <p className="mb-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {t('app_studio.views.tables_desc', 'The tables this app stores its rows in — fields, relationships and the rows themselves.')}
                    </p>
                    <button
                        type="button"
                        onClick={() => setDesignerOpen(true)}
                        className="rounded-lg px-3 py-1.5 text-xs font-medium transition-opacity hover:opacity-90"
                        style={{ background: 'var(--accent-primary)', color: 'var(--accent-primary-fg)' }}
                    >
                        {t('app_studio.views.open_table_designer', 'Open the table designer')}
                    </button>
                    {/* TablesManager is still its own MODAL (it runs react-query
                        through useAppTables, so it is mounted only while this
                        subtab is shown). `inline` asks it to drop that chrome
                        and lay itself out in the view — it ignores the prop
                        today and Track P3 lands it; until then, closing the
                        designer leaves you IN the Data view rather than
                        bouncing back to the canvas, so Variables stays
                        reachable. */}
                    {tab === 'tables' ? (
                        <TablesManager
                            inline
                            open={designerOpen}
                            onClose={() => setDesignerOpen(false)}
                            appId={app?.id}
                            definition={definition}
                            screenId={screenId}
                            onCommit={onCommit}
                            dispatch={dispatch}
                        />
                    ) : null}
                </div>
                <div hidden={tab !== 'variables'} className="p-4">
                    <p className="mb-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                        {t('app_studio.views.variables_desc', 'Named values your screens and actions share — formulas read them as vars.<name>.')}
                    </p>
                    <VariablesManager
                        definition={definition}
                        onCommit={onCommit}
                        disabled={disabled}
                        onRevealNode={({ nodeId, screenId: target }) => {
                            if (target) dispatch({ type: 'set_screen', screenId: target });
                            if (nodeId) dispatch({ type: 'select_node', nodeId });
                            onLeave?.();
                        }}
                    />
                </div>
            </div>
        </div>
    );
}

export function RolesView({ app, definition, onCommit, onDirtyChange }) {
    const { t } = useTranslation();
    const [tab, setTab] = useState('roles');
    return (
        <div className="flex min-h-0 flex-1 flex-col" data-editor-view="roles">
            <div className="border-b px-3" style={{ borderColor: 'var(--border-default)' }}>
                <Tabs
                    size="sm"
                    value={tab}
                    onChange={setTab}
                    ariaLabel={t('app_studio.views.roles_tabs_aria', 'Roles and access')}
                    items={[
                        { id: 'roles', label: t('app_studio.views.roles', 'Roles') },
                        { id: 'access', label: t('app_studio.views.screen_access', 'Screen access') },
                        { id: 'rules', label: t('app_studio.views.row_rules', 'Row rules') },
                    ]}
                />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-4">
                <p className="mb-3 text-xs" style={{ color: 'var(--text-tertiary)' }}>
                    {t('app_studio.views.roles_desc', 'Decide who gets which role, what each role sees, and which rows they can touch.')}
                </p>
                <div hidden={tab !== 'roles'}>
                    <RolesManager
                        appId={app?.id}
                        definition={definition}
                        onCommit={onCommit}
                        onDirtyChange={(d) => onDirtyChange?.('roles', d)}
                    />
                </div>
                <div hidden={tab !== 'access'}>
                    <AccessMatrix appId={app?.id} definition={definition} onCommit={onCommit} />
                </div>
                <div hidden={tab !== 'rules'}>
                    <RowRuleEditor
                        appId={app?.id}
                        onDirtyChange={(d) => onDirtyChange?.('rules', d)}
                    />
                </div>
            </div>
        </div>
    );
}
