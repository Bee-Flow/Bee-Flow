import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import CoworkActivity from '@/components/cowork/CoworkActivity';
import { OrbAppearanceContext, orbDefaults } from '@/components/cowork/coworkOrbAppearance';
import { applyThemeToDocument } from '@/components/theme/applyTheme';
import '@/index.css';
import '@/themes.css';
import '@/app.css';
import './demo.css';

const themes = { light: 'Licht', paper: 'Papier', sepia: 'Sepia', glass: 'Glas licht', dark: 'Donker',
    obsidian: 'Obsidiaan', 'glass-dark': 'Glas donker', 'high-contrast': 'Hoog contrast' } as const;
type Theme = keyof typeof themes;
function initialTheme(): Theme {
    const value = new URLSearchParams(location.search).get('theme');
    return value && Object.hasOwn(themes, value) ? value as Theme : 'obsidian';
}

const flow = [
    { id: 'meetings', app: 'fireflies', kind: 'fixed' },
    { id: 'summary', kind: 'ai' },
    { id: 'draft', app: 'nextcloud_mail', kind: 'deliver' },
] as const;
const stages = [
    { action: 'creating', tone: 'thinking', message: 'Ik zet de stappen op een rij.', focus: undefined },
    { action: 'executing', tone: 'executing', message: 'Ik haal je gesprekken op uit Fireflies.', focus: 0 },
    { action: 'thinking', tone: 'thinking', message: 'Ik bundel de besluiten en actiepunten.', focus: 1 },
    { action: 'deliver', tone: 'executing', message: 'Ik maak de conceptmail.', focus: 2 },
    { action: 'rest', tone: 'rest', message: 'Je conceptmail staat klaar.', focus: undefined },
] as const;

function Demo() {
    const [theme, setTheme] = useState(initialTheme);
    const [tempo, setTempo] = useState(orbDefaults.tempo);
    const [auto, setAuto] = useState(true);
    const [index, setIndex] = useState(0);
    const stage = stages[index];
    useEffect(() => {
        applyThemeToDocument({ preset: theme });
    }, [theme]);
    useEffect(() => {
        if (!auto) return;
        const timer = window.setInterval(() => setIndex(i => (i + 1) % stages.length), 4800);
        return () => window.clearInterval(timer);
    }, [auto]);
    function reset() {
        setTempo(orbDefaults.tempo);
        setIndex(0);
        setAuto(true);
    }
    return <main><OrbAppearanceContext.Provider value={{ ...orbDefaults, tempo }}>
        <CoworkActivity title="Weekoverzicht van meetings" message={stage.message} tone={stage.tone}
            work={{ action: stage.action, flow: [...flow], focus: stage.focus }} />
    </OrbAppearanceContext.Provider><aside>
        <h2>Klassieke Canvas-orb</h2>
        <label>Volg thema<select value={theme} onChange={event => setTheme(event.target.value as Theme)}>
            {Object.entries(themes).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select></label>
        <fieldset><legend>Beweging</legend>
            {Object.entries({ 'Zeer rustig': .3, Rustig: orbDefaults.tempo, Normaal: 1 }).map(([label, value]) =>
                <button key={label} aria-pressed={tempo === value} onClick={() => setTempo(value)}>{label}</button>)}
        </fieldset>
        <label>Demostap<select value={auto ? 'auto' : index} onChange={event => {
            const value = event.target.value;
            setAuto(value === 'auto');
            if (value !== 'auto') setIndex(Number(value));
        }}><option value="auto">Automatisch</option>{stages.map((item, i) =>
            <option value={i} key={item.action}>{item.message}</option>)}</select></label>
        <button onClick={reset}>Herstel standaardwaarden</button>
    </aside></main>;
}

createRoot(document.getElementById('root')!).render(<Demo />);
