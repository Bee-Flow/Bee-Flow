// @vitest-environment node
import { describe, expect, it } from 'vitest';
import logicRows, {
    assignNotices,
    collectBoundTableIds,
    countWiredLogic,
    eventsForType,
    noticesForRow,
    routineRows,
    routineTouchesTables,
} from './logicRows';

/**
 * De Logica-tab bestaat omdat de oude weergave dingen weg liet vallen. Deze
 * suite bewaakt dus vooral wat er NIET mag verdwijnen: een event dat een
 * component kan dragen maar dat aan niets hangt, een actie waar niets naar
 * wijst, en de vier oppervlakken die de server wél als bereikbaar telt.
 */

const ACTIONS = {
    act_go: { kind: 'navigate', screenId: 'scr_detail' },
    act_run: { kind: 'run_automation', automationId: 'aut_7' },
};

function screen(children, extra = {}) {
    return { id: 'scr_1', name: 'Orders', sections: [{ id: 'sec_1', children }], ...extra };
}

function defOf(children, extra = {}) {
    return {
        screens: [screen(children)],
        actions: ACTIONS,
        ...extra,
    };
}

describe('een event dat aan geen actie hangt blijft staan', () => {
    it('geeft een onbedrade rij per event-slot dat het type kán dragen', () => {
        const rows = logicRows(defOf([
            { id: 'nd_grid', type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_a' } } },
        ]));
        const slots = rows.filter((r) => r.nodeId === 'nd_grid');
        expect(slots.map((r) => r.event)).toEqual(['onRowClick', 'onRowSelect']);
        for (const row of slots) {
            expect(row.wired).toBe(false);
            expect(row.what).toBe('No action yet');
            expect(row.when).not.toContain(row.event);
        }
    });

    it('houdt approval_list.onDecided vast — het enige slot dat vandaag écht stil verdween', () => {
        const rows = logicRows(defOf([{ id: 'nd_ap', type: 'approval_list', props: {} }]));
        const [row] = rows.filter((r) => r.nodeId === 'nd_ap');
        expect(row.event).toBe('onDecided');
        expect(row.wired).toBe(false);
        expect(row.when).toBe('When a decision is made');
    });

    it('zegt bij een bedraad slot wat er gebeurt, niet dát er iets gebeurt', () => {
        const rows = logicRows(defOf([{ id: 'nd_b', type: 'button', onClick: 'act_go' }]));
        const [row] = rows.filter((r) => r.nodeId === 'nd_b');
        expect(row.wired).toBe(true);
        expect(row.when).toBe('When clicked');
        expect(row.what).toBe('Go to screen');
        expect(row.actionId).toBe('act_go');
    });

    it('noemt een slot dat naar een verdwenen actie wijst kapot, niet leeg', () => {
        const rows = logicRows(defOf([{ id: 'nd_b', type: 'button', onClick: 'act_weg' }]));
        const [row] = rows.filter((r) => r.nodeId === 'nd_b');
        expect(row.wired).toBe(true);
        expect(row.what).toMatch(/no longer exists/);
    });

    it('draagt de routinenaam door wanneer de aanroeper er een kan geven', () => {
        const rows = logicRows(
            defOf([{ id: 'nd_b', type: 'button', onClick: 'act_run' }]),
            { titleFor: (id) => (id === 'aut_7' ? 'Offerte berekenen' : null) },
        );
        const [row] = rows.filter((r) => r.nodeId === 'nd_b');
        expect(row.what).toBe('Run routine — Offerte berekenen');
        expect(row.automationId).toBe('aut_7');
    });
});

describe('de oppervlakken die de rolpoort en de oude weergave niet kenden', () => {
    it('telt rowActions, bulkActions, toolbarActions, addRow en kolomacties mee', () => {
        const rows = logicRows(defOf([{
            id: 'nd_grid',
            type: 'data_grid',
            props: {
                rowActions: [{ actionId: 'act_go', label: 'Open' }],
                bulkActions: [{ actionId: 'act_run' }],
                toolbarActions: [{ actionId: 'act_go' }],
                addRowActionId: 'act_run',
                columns: [{ field: 'a' }, { field: 'b', actionId: 'act_go', label: 'Fix' }],
            },
        }]));
        const surfaces = rows.filter((r) => r.surface).map((r) => r.surface);
        expect(surfaces).toEqual([
            'rowActions', 'bulkActions', 'toolbarActions', 'addRowActionId', 'columnAction',
        ]);
        const rowAction = rows.find((r) => r.surface === 'rowActions');
        expect(rowAction.surfaceLabel).toBe('Open');
        expect(rowAction.path).toBe('screens[0].sections[0].children[0].props.rowActions[0].actionId');
    });

    it('behandelt de lege actionId van de inspector als onbedraad, niet als kapot', () => {
        const rows = logicRows(defOf([{
            id: 'nd_grid', type: 'data_grid', props: { rowActions: [{ actionId: '', label: 'Open' }] },
        }]));
        const [row] = rows.filter((r) => r.surface === 'rowActions');
        expect(row.wired).toBe(false);
        expect(row.what).toBe('No action yet');
    });
});

describe('een actie waar niets naar wijst', () => {
    it('krijgt een eigen onbedrade rij in plaats van te verdwijnen', () => {
        const rows = logicRows({ screens: [screen([])], actions: { act_lost: { kind: 'toast', message: 'Hoi' } } });
        const [row] = rows.filter((r) => r.kind === 'orphan_action');
        expect(row.actionId).toBe('act_lost');
        expect(row.wired).toBe(false);
        expect(row.when).toBe('Nothing starts this yet');
        expect(row.what).toMatch(/Hoi/);
    });

    it('laat een actie die ergens aan hangt niet ook nog eens als wees zien', () => {
        const rows = logicRows(defOf([{ id: 'nd_b', type: 'button', onClick: 'act_go' }]));
        const orphans = rows.filter((r) => r.kind === 'orphan_action').map((r) => r.actionId);
        expect(orphans).toContain('act_run');
        expect(orphans).not.toContain('act_go');
    });

    it('telt óók een oppervlak als bereikbaarheid — anders is een rijactie een wees', () => {
        const rows = logicRows(defOf([{
            id: 'nd_grid', type: 'data_grid', props: { rowActions: [{ actionId: 'act_go' }] },
        }]));
        const orphans = rows.filter((r) => r.kind === 'orphan_action').map((r) => r.actionId);
        expect(orphans).not.toContain('act_go');
    });
});

describe('"Scherm wordt geopend" — beschrijvend, afgeleid uit de bindingen', () => {
    it('vertelt hoeveel componenten data laden, en is geen bedraadbaar slot', () => {
        const rows = logicRows(defOf([
            { id: 'nd_g', type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_a' } } },
            { id: 'nd_l', type: 'list', props: { source: { kind: 'records', tableId: 'tbl_b' } } },
        ]));
        const [row] = rows.filter((r) => r.kind === 'screen_open');
        expect(row.descriptive).toBe(true);
        expect(row.when).toBe('When the screen is opened');
        expect(row.what).toBe('2 components load their data');
        expect(row.tableIds.sort()).toEqual(['tbl_a', 'tbl_b']);
        expect(row.event).toBeNull();
    });

    it('zegt "1 component" in het enkelvoud, met de ternary om de sleutel', () => {
        const seen = [];
        const t = (key, en, params) => {
            seen.push(key);
            return String(en).replace(/\{count\}/g, String(params?.count));
        };
        const rows = logicRows(
            defOf([{ id: 'nd_g', type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_a' } } }]),
            { t },
        );
        const [row] = rows.filter((r) => r.kind === 'screen_open');
        expect(row.what).toBe('1 component loads its data');
        expect(seen).toContain('app_studio.logic.screen_loads');
        expect(seen).not.toContain('app_studio.logic.screen_loads_plural');
    });

    it('laat de regel weg als er niets te laden valt', () => {
        const rows = logicRows(defOf([{ id: 'nd_h', type: 'heading', props: { text: 'Hallo' } }]));
        expect(rows.filter((r) => r.kind === 'screen_open')).toHaveLength(0);
    });
});

describe('collectBoundTableIds', () => {
    it('vindt een tableId hoe diep hij ook zit', () => {
        const ids = collectBoundTableIds({
            source: { kind: 'records', tableId: 'tbl_a', filter: [{ value: { tableId: 'tbl_b' } }] },
        });
        expect([...ids].sort()).toEqual(['tbl_a', 'tbl_b']);
    });

    it('overleeft een cyclus in de props', () => {
        const a = { tableId: 'tbl_a' };
        a.self = a;
        expect([...collectBoundTableIds(a)]).toEqual(['tbl_a']);
    });

    it('negeert een tableId die geen string is', () => {
        expect(collectBoundTableIds({ tableId: 12 }).size).toBe(0);
    });
});

describe('eventsForType spiegelt de componentcatalogus', () => {
    it('kent de slots van een data_grid en geeft niets terug voor een type zonder events', () => {
        expect(eventsForType('data_grid')).toEqual(['onRowClick', 'onRowSelect']);
        expect(eventsForType('heading')).toEqual([]);
        expect(eventsForType(undefined)).toEqual([]);
    });
});

describe('routineTouchesTables', () => {
    const tables = new Set(['tbl_a']);

    it('ziet een datatable-stap', () => {
        expect(routineTouchesTables({ definition: { steps: [{ type: 'datatable', datatableId: 'tbl_a' }] } }, tables)).toBe(true);
    });

    it('ziet een stap die in een lus of een tak zit', () => {
        expect(routineTouchesTables({
            definition: { steps: [{ type: 'loop', steps: [{ datatableId: 'tbl_a' }] }] },
        }, tables)).toBe(true);
        expect(routineTouchesTables({
            definition: { steps: [{ type: 'switch', cases: [{ steps: [{ datatableId: 'tbl_a' }] }] }] },
        }, tables)).toBe(true);
    });

    it('ziet een tabeltrigger', () => {
        expect(routineTouchesTables({ definition: { trigger: { filter: { tableId: 'tbl_a' } } } }, tables)).toBe(true);
    });

    it('is onwaar voor een andere tabel en voor een lege verzameling', () => {
        expect(routineTouchesTables({ definition: { steps: [{ datatableId: 'tbl_z' }] } }, tables)).toBe(false);
        expect(routineTouchesTables({ definition: { steps: [{ datatableId: 'tbl_a' }] } }, new Set())).toBe(false);
    });
});

describe('routineRows — afgeleid, en versmallend bij twijfel', () => {
    const rowsById = {
        aut_1: { id: 'aut_1', title: 'Nachtelijke herinnering', projectId: 'prj_1', definition: { trigger: { kind: 'schedule' }, steps: [{ datatableId: 'tbl_a' }] } },
        aut_2: { id: 'aut_2', title: 'Andere oplossing', projectId: 'prj_2', definition: { steps: [{ datatableId: 'tbl_a' }] } },
        aut_3: { id: 'aut_3', title: 'Raakt niets', projectId: 'prj_1', definition: { steps: [{ datatableId: 'tbl_z' }] } },
    };
    const boundTableIds = new Set(['tbl_a']);

    it('houdt alleen routines uit dezelfde oplossing die de gebonden tabel raken', () => {
        const rows = routineRows({ app: { projectId: 'prj_1' }, automationRows: rowsById, boundTableIds });
        expect(rows.map((r) => r.automationId)).toEqual(['aut_1']);
        expect(rows[0].when).toBe('On a schedule');
        expect(rows[0].what).toBe('Nachtelijke herinnering');
        expect(rows[0].kind).toBe('routine');
    });

    it('geeft niets terug voor een app zonder oplossing — "alle routines" is een andere vraag', () => {
        expect(routineRows({ app: { projectId: null }, automationRows: rowsById, boundTableIds })).toEqual([]);
    });

    it('geeft niets terug als de app aan geen enkele tabel gebonden is', () => {
        expect(routineRows({ app: { projectId: 'prj_1' }, automationRows: rowsById, boundTableIds: new Set() })).toEqual([]);
    });

    it('laat een routine weg die hierboven al aan een knop hangt', () => {
        const rows = routineRows({
            app: { projectId: 'prj_1' }, automationRows: rowsById, boundTableIds,
            wiredAutomationIds: new Set(['aut_1']),
        });
        expect(rows).toEqual([]);
    });
});

describe('noticesForRow — gematcht op pad, niet op tekst', () => {
    const row = { path: 'screens[0].sections[0].children[1]' };

    it('pakt de melding op het component zelf', () => {
        const hits = noticesForRow([{ path: 'screens[0].sections[0].children[1]', message: 'inert' }], row);
        expect(hits).toHaveLength(1);
    });

    it('pakt een melding op een dieper pad van hetzelfde component', () => {
        const hits = noticesForRow([{ path: 'screens[0].sections[0].children[1].props.rowActions[0].actionId', message: 'x' }], row);
        expect(hits).toHaveLength(1);
    });

    it('pakt de melding van een buurcomponent niet', () => {
        expect(noticesForRow([{ path: 'screens[0].sections[0].children[2]', message: 'x' }], row)).toEqual([]);
        expect(noticesForRow([{ path: 'screens[0].sections[0].children[10]', message: 'x' }], row)).toEqual([]);
    });

    it('negeert een melding zonder pad — die hoort bij de app, niet bij een rij', () => {
        expect(noticesForRow([{ path: '', message: 'x' }], row)).toEqual([]);
    });
});

describe('assignNotices — één melding, één rij', () => {
    // Een data_grid levert vijf rijen op (twee events + drie rijacties). Vijf
    // keer dezelfde zin eronder is ruis; de meest specifieke rij wint.
    const DEF = {
        screens: [{
            id: 'scr_1',
            name: 'Orders',
            sections: [{
                id: 'sec_1',
                children: [
                    { id: 'nd_g', type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_a' }, rowActions: [{ actionId: '' }] } },
                    { id: 'nd_b', type: 'button', props: { text: 'Go' } },
                ],
            }],
        }],
        actions: {},
    };

    it('hangt een component-melding aan precies één rij van dat component', () => {
        const rows = logicRows(DEF);
        const map = assignNotices(rows, [{
            code: 'component.control_inert',
            path: 'screens[0].sections[0].children[1]',
            message: 'This button is wired to nothing.',
        }]);
        expect([...map.values()].flat()).toHaveLength(1);
        const [key] = [...map.keys()];
        expect(rows.find((r) => r.key === key).nodeId).toBe('nd_b');
    });

    it('laat de "scherm opent"-rij geen melding van een component wegkapen', () => {
        const rows = logicRows(DEF);
        expect(rows.some((r) => r.kind === 'screen_open')).toBe(true);
        const map = assignNotices(rows, [{
            path: 'screens[0].sections[0].children[0].props.rowActions[0].actionId',
            message: 'x',
        }]);
        const [key] = [...map.keys()];
        const hit = rows.find((r) => r.key === key);
        expect(hit.kind).not.toBe('screen_open');
        expect(hit.surface).toBe('rowActions');
    });

    it('negeert een melding die bij geen enkele rij hoort', () => {
        expect(assignNotices(logicRows(DEF), [{ path: 'meta.name', message: 'x' }]).size).toBe(0);
    });
});

describe('een bedraad slot dat de typelijst niet kent, verdwijnt niet', () => {
    // Van de drie lezers (server, canvasbadge, deze tab) liep alleen deze tab
    // per TYPE; de andere twee lopen per NAAM. Een slot dat een type kwijtraakt
    // — of dat langs een install/import binnenkwam — viel hier dus uit de tabel
    // én maakte zijn actie tot "wees": het scherm dat is gebouwd omdat er niets
    // stil mag verdwijnen, verborg de bedrading mét de omgekeerde bewering erbij.
    const OUTSIDE = { id: 'nd_t', type: 'text', props: { text: 'Hallo' }, onClick: 'act_go' };

    it('toont hem als BEDRADE rij, met wat er gebeurt', () => {
        const rows = logicRows(defOf([OUTSIDE]));
        const slots = rows.filter((r) => r.nodeId === 'nd_t');
        expect(slots).toHaveLength(1);
        expect(slots[0].event).toBe('onClick');
        expect(slots[0].wired).toBe(true);
        expect(slots[0].when).toBe('When clicked');
    });

    it('en telt de actie dus als BEREIKT — geen "Nothing starts this yet"', () => {
        const rows = logicRows(defOf([OUTSIDE]));
        const orphans = rows.filter((r) => r.kind === 'orphan_action').map((r) => r.actionId);
        expect(orphans).not.toContain('act_go');
    });

    it('verzint geen leeg slot voor een type dat het event niet heeft', () => {
        // Alleen wat er ECHT staat komt erbij; een text zonder onClick blijft
        // een component zonder logica.
        const rows = logicRows(defOf([{ id: 'nd_t2', type: 'text', props: { text: 'x' } }]));
        expect(rows.filter((r) => r.nodeId === 'nd_t2')).toEqual([]);
    });
});

describe('countWiredLogic — de kop telt wat de tabel toont', () => {
    it('telt de actie-oppervlakken mee, die de oude teller niet kende', () => {
        const def = defOf([{
            id: 'nd_g',
            type: 'data_grid',
            props: {
                source: { kind: 'records', tableId: 'tbl_a' },
                rowActions: [{ actionId: 'act_go' }, { actionId: '' }],
                toolbarActions: [{ actionId: 'act_run' }],
            },
        }]);
        // Twee bedrade oppervlakken, nul bedrade events: de oude teller
        // (countLogicMarks) gaf hier 0 en het segment liet het getal helemaal
        // weg — het signaal "hier valt niets te zien" — boven een tabel met
        // vier regels.
        expect(countWiredLogic(def)).toBe(2);
        expect(logicRows(def).filter((r) => r.kind !== 'screen_open')).toHaveLength(5);
    });

    it('telt de beschrijvende "scherm opent"-rij niet mee', () => {
        const def = defOf([{ id: 'nd_g', type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_a' } } }]);
        expect(logicRows(def).some((r) => r.kind === 'screen_open')).toBe(true);
        expect(countWiredLogic(def)).toBe(0);
    });

    it('is per definitie hetzelfde getal als de tabel eronder', () => {
        const def = defOf([
            { id: 'nd_b', type: 'button', onClick: 'act_go' },
            { id: 'nd_g', type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_a' }, rowActions: [{ actionId: 'act_run' }] } },
        ]);
        const fromRows = logicRows(def).filter((r) => r.wired && !r.descriptive).length;
        expect(countWiredLogic(def)).toBe(fromRows);
    });

    it('verdraagt een lege of kapotte definitie', () => {
        expect(countWiredLogic(null)).toBe(0);
        expect(countWiredLogic({})).toBe(0);
    });
});

describe('een melding over een component ZONDER logica-rijen', () => {
    // De "scherm opent"-rij draagt het pad van het SCHERM, en dat is een
    // voorvader van élk component erop. Zonder uitzondering landde een melding
    // over een input_text (geen events, geen oppervlakken) op die ene regel: de
    // bouwer las "input_text sits outside a form" onder "When the screen is
    // opened / 2 components load their data".
    const DEF_MIXED = {
        screens: [{
            id: 'scr_1',
            name: 'Orders',
            sections: [{
                id: 'sec_1',
                children: [
                    { id: 'nd_g', type: 'data_grid', props: { source: { kind: 'records', tableId: 'tbl_a' } } },
                    { id: 'nd_i', type: 'input_text', props: { name: 'naam' } },
                    { id: 'nd_h', type: 'heading', props: { text: 'Klanten' } },
                ],
            }],
        }],
        actions: {},
    };

    it('landt nergens en blijft dus in de save-pill staan', () => {
        const rows = logicRows(DEF_MIXED);
        expect(rows.some((r) => r.kind === 'screen_open')).toBe(true);
        const map = assignNotices(rows, [{
            code: 'input.outside_form',
            path: 'screens[0].sections[0].children[1]',
            message: 'input_text sits outside a form — its value is never submitted',
        }]);
        expect(map.size).toBe(0);
    });

    it('en twee zulke meldingen stapelen niet op die ene regel', () => {
        const rows = logicRows(DEF_MIXED);
        const map = assignNotices(rows, [
            { path: 'screens[0].sections[0].children[1]', message: 'a' },
            { path: 'screens[0].sections[0].children[2]', message: 'b' },
        ]);
        expect(map.size).toBe(0);
    });

    it('maar een melding over het scherm ZELF hoort er wel bij', () => {
        const rows = logicRows(DEF_MIXED);
        const map = assignNotices(rows, [{ path: 'screens[0]', message: 'screen is empty' }]);
        const [key] = [...map.keys()];
        expect(rows.find((r) => r.key === key).kind).toBe('screen_open');
    });

    it('en een melding over een component MET rijen landt op zijn EERSTE rij', () => {
        const rows = logicRows(DEF_MIXED);
        const map = assignNotices(rows, [{
            path: 'screens[0].sections[0].children[0]',
            message: 'this grid does nothing',
        }]);
        const [key] = [...map.keys()];
        const hit = rows.find((r) => r.key === key);
        expect(hit.nodeId).toBe('nd_g');
        expect(hit.event).toBe('onRowClick');
    });
});
