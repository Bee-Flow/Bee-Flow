import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * De overdrachtstabel. Drie beloften worden hier vastgezet:
 *
 *   1. de soort→sectie-wandeling komt UIT HET REGISTER (studioNav), niet uit
 *      een tweede tabel die morgen uit de pas loopt;
 *   2. `run` opent dezelfde deur als het "Nieuw"-menu — en draagt de naam mee
 *      waar de bouwer daar iets mee doet;
 *   3. een gelockte of afwezige sectie is een bordje, geen deur;
 *   4. "de brief komt aan" en "de naam komt aan" zijn TWEE vlaggen, want ze
 *      zijn vandaag verschillend waar.
 */

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('../../../../utils/helpers', () => ({ API_BASE: '', authFetch: (...a) => fetchMock(...a) }));
// De formulier-trigger komt uit de builder-chunk; die hoeft hier niet echt te
// laden om te bewijzen dat createFormAutomation wordt aangeroepen.
vi.mock('../../../automation/Builder/flow/settings/FormBuilderFields', () => ({
    defaultFormDeclaration: () => ({ pages: [] }),
}));

import { STUDIO_APPS, resolveStudioNav } from '../studioApps';
import { destinationForKind, kindLabel, parkSeed, takeSeed, SEED_KEY, SEED_SUPPORT, NAME_SUPPORT } from './handoff';

const t = (key, fallback, params) => {
    let value = typeof fallback === 'string' ? fallback : key;
    const p = typeof fallback === 'string' ? params : fallback;
    if (p && typeof p === 'object') for (const [k, v] of Object.entries(p)) value = value.replace(`{${k}}`, String(v));
    return value;
};

const allOpen = () => resolveStudioNav(STUDIO_APPS, {
    user: {}, hasLicenseFeature: () => true, canUse: () => true, hasPermission: () => true,
    can: () => true, lockReason: () => null,
});

const withLocked = (id, reason) => allOpen().map((s) => (s.id === id ? { ...s, locked: reason } : s));
const without = (id) => allOpen().filter((s) => s.id !== id);

const created = (id = 'a1') => ({ ok: true, status: 200, json: async () => ({ automation: { id } }), text: async () => '' });

beforeEach(() => { fetchMock.mockReset(); try { window.sessionStorage.clear(); } catch { /* geen storage */ } });

describe('destinationForKind — de sectie komt uit het register', () => {
    // Het label is het woord dat het "Nieuw"-menu voor die soort gebruikt —
    // letterlijk uit de create-rij van het register, niet uit een tweede
    // woordenlijst hier.
    it.each([
        ['automation', 'aiTasks', 'Automation'],
        ['form', 'forms', 'Form'],
        ['kb', 'knowledge', 'Knowledge base'],
        ['agent', 'agents', 'Agent'],
        ['skill', 'skills', 'Skill'],
        ['app', 'apps', 'App'],
        ['webpage', 'webpages', 'Webpage'],
        ['datatable', 'datatables', 'Table'],
        ['solution', 'solutions', 'Solution'],
        ['meeting', 'meetingNotes', 'Record or upload a meeting'],
    ])('%s landt in sectie %s en heet "%s"', (kind, sectionId, label) => {
        const dest = destinationForKind(kind, { sections: allOpen(), t });
        expect(dest.section.id).toBe(sectionId);
        expect(dest.available).toBe(true);
        expect(dest.label).toBe(label);
        expect(kindLabel(kind, t)).toBe(label);
    });

    it('een soort die het register niet kent is geen deur', () => {
        const dest = destinationForKind('unicorn', { sections: allOpen(), t });
        expect(dest.available).toBe(false);
        expect(dest.section).toBe(null);
    });

    it('zonder soort ook niet', () => {
        expect(destinationForKind(null, { sections: allOpen(), t }).available).toBe(false);
    });
});

describe('destinationForKind — run opent dezelfde deur als het "Nieuw"-menu', () => {
    it('een kennisbank navigeert naar de aanmaakroute van zijn eigen sectie', async () => {
        const onNavigate = vi.fn();
        await destinationForKind('kb', { sections: allOpen(), t }).run({ onNavigate, t });
        expect(onNavigate).toHaveBeenCalledWith('studio/knowledge/new');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('een automation draagt de NAAM uit de schema-kaart', async () => {
        fetchMock.mockResolvedValue(created('auto-9'));
        const onNavigate = vi.fn();
        await destinationForKind('automation', { sections: allOpen(), t }).run({ onNavigate, t, name: '  Weekrapport  ' });
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe('/api/automation');
        expect(JSON.parse(init.body).title).toBe('Weekrapport');
        expect(onNavigate).toHaveBeenCalledWith('studio/automations/auto-9');
    });

    it('zonder naam blijft de eigen standaardtitel van de bouwer staan', async () => {
        fetchMock.mockResolvedValue(created());
        await destinationForKind('automation', { sections: allOpen(), t }).run({ onNavigate: vi.fn(), t, name: '   ' });
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).title).toBe('Untitled automation');
    });

    it('een formulier komt als VERZAMELEND formulier binnen, onder zijn naam, en opent op de Vragen-tab van de Form-pagina', async () => {
        fetchMock.mockResolvedValue(created('f1'));
        const onNavigate = vi.fn();
        await destinationForKind('form', { sections: allOpen(), t }).run({ onNavigate, t, name: 'Aanmelding', seed: 'een aanmeldformulier voor de open dag' });
        const body = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(body.definition.trigger.kind).toBe('form');
        expect(body.definition.trigger.form.collect).toBe(true);
        expect(body.title).toBe('Aanmelding');
        expect(NAME_SUPPORT.form).toBe(true);
        expect(destinationForKind('form', { sections: allOpen(), t }).carriesName).toBe(true);
        // niet de automation-bouwer: de Form-pagina
        expect(onNavigate).toHaveBeenCalledWith('studio/forms/f1/questions');
        // de brief staat geparkeerd ONDER HET ID — een kale 'form'-brief zou
        // door de eerstvolgende Vragen-tab van elk formulier worden opgepakt
        expect(takeSeed('form')).toBe(null);
        expect(takeSeed('form:f1')).toBe(null); // takeSeed('form') hierboven wiste hem al: één keer lezen
        await destinationForKind('form', { sections: allOpen(), t }).run({ onNavigate, t, name: 'Aanmelding', seed: 'nog eens' });
        expect(takeSeed('form:f1')).toBe('nog eens');
    });
});

// Twee vragen, twee tabellen. Ze in één vlag vouwen was de fout van de eerste
// ronde: automation droeg de NAAM mee, stond daarom op "seedable", en het
// scherm verzweeg daar de BRIEF.
describe('destinationForKind — de brief en de naam zijn twee beloften', () => {
    it('alleen form draagt de brief naar zijn bouwer', () => {
        const seedable = Object.entries(SEED_SUPPORT).filter(([, v]) => v).map(([k]) => k);
        expect(seedable).toEqual(['form']);
        expect(destinationForKind('form', { sections: allOpen(), t }).seedable).toBe(true);
        for (const kind of ['automation', 'kb', 'agent', 'skill', 'app', 'webpage', 'datatable', 'solution']) {
            expect(destinationForKind(kind, { sections: allOpen(), t }).seedable).toBe(false);
        }
    });

    it('automation en form dragen de naam mee — en dat is een ANDERE vlag', () => {
        const named = Object.entries(NAME_SUPPORT).filter(([, v]) => v).map(([k]) => k);
        expect(named).toEqual(['automation', 'form']);
        const auto = destinationForKind('automation', { sections: allOpen(), t });
        expect(auto.carriesName).toBe(true);
        expect(auto.seedable).toBe(false);
        for (const kind of ['kb', 'skill', 'agent', 'app']) {
            expect(destinationForKind(kind, { sections: allOpen(), t }).carriesName).toBe(false);
        }
    });

    it('een gelockte bestemming belooft allebei niets', () => {
        const dest = destinationForKind('app', { sections: withLocked('apps', 'ceiling'), t });
        expect(dest.seedable).toBe(false);
        expect(dest.carriesName).toBe(false);
    });
});

describe('destinationForKind — een gelockte soort is een bordje', () => {
    it('een LOCKED sectie geeft geen deur maar een hint', async () => {
        const dest = destinationForKind('app', { sections: withLocked('apps', 'ceiling'), t });
        expect(dest.available).toBe(false);
        expect(dest.locked).toBe('ceiling');
        expect(dest.lockHint).toBe('Available on a higher plan');
        const onNavigate = vi.fn();
        await dest.run({ onNavigate, t });
        expect(onNavigate).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('not_granted krijgt zijn eigen hint', () => {
        const dest = destinationForKind('app', { sections: withLocked('apps', 'not_granted'), t });
        expect(dest.lockHint).toBe('Not switched on for your organisation — ask an admin');
    });

    it('een sectie die er helemaal niet in staat is óók geen deur', async () => {
        const dest = destinationForKind('agent', { sections: without('agents'), t });
        expect(dest.available).toBe(false);
        expect(dest.lockHint).toBeTruthy();
        const onNavigate = vi.fn();
        await dest.run({ onNavigate, t });
        expect(onNavigate).not.toHaveBeenCalled();
    });

    it('zonder sections-lijst is niets beschikbaar (onbekend versmalt)', () => {
        expect(destinationForKind('kb', { t }).available).toBe(false);
    });
});

describe('parkSeed / takeSeed — het zaaikanaal', () => {
    it('parkeert de brief en geeft hem één keer terug', () => {
        expect(parkSeed('agent', ' een agent voor offertes ')).toBe(true);
        expect(takeSeed('agent')).toBe('een agent voor offertes');
        expect(takeSeed('agent')).toBe(null);
    });

    it('een brief voor een andere soort komt niet mee — en blijft ook niet liggen', () => {
        parkSeed('agent', 'hallo');
        expect(takeSeed('kb')).toBe(null);
        expect(window.sessionStorage.getItem(SEED_KEY)).toBe(null);
    });

    it('een lege brief parkeert niets en wist wat er stond', () => {
        parkSeed('agent', 'hallo');
        expect(parkSeed('agent', '   ')).toBe(false);
        expect(takeSeed('agent')).toBe(null);
    });

    it('rommel in de opslag leidt niet tot een worp', () => {
        window.sessionStorage.setItem(SEED_KEY, 'geen json');
        expect(takeSeed('agent')).toBe(null);
    });

    describe('met een opslag die gooit (privémodus)', () => {
        let original;
        beforeEach(() => {
            original = Object.getOwnPropertyDescriptor(window, 'sessionStorage');
            Object.defineProperty(window, 'sessionStorage', {
                configurable: true,
                get() { throw new DOMException('denied', 'SecurityError'); },
            });
        });
        afterEach(() => {
            if (original) Object.defineProperty(window, 'sessionStorage', original);
            else delete window.sessionStorage;
        });

        it('overleeft parkeren en ophalen zonder te gooien', () => {
            expect(() => parkSeed('agent', 'hallo')).not.toThrow();
            expect(parkSeed('agent', 'hallo')).toBe(false);
            expect(takeSeed('agent')).toBe(null);
        });
    });
});
