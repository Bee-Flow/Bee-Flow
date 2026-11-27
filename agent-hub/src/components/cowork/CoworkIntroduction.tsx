import { useEffect, useState } from 'react';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useTranslation } from '@/hooks/useTranslation';
import MarkdownRenderer from '@/components/renderers/MarkdownRenderer';
import CoworkOrb from './CoworkOrb';
import CoworkStepRail from './task/CoworkStepRail';
import type { TaskStep } from './task/coworkTaskModel';
import type { CoworkMode } from './coworkDisplayMode';
import { BUTTON_PRIMARY, BUTTON_SECONDARY, LINK_INLINE } from './coworkUi';

const actions = ['creating', 'testing', 'rest'] as const;

export default function CoworkIntroduction({ choose }: {choose: (mode: CoworkMode) => void}) {
    const { t, locale } = useTranslation();
    const [scene, setScene] = useState(0);
    const [selected, select] = useState('collect');
    const [listen, setListen] = useState(false);
    const reducedMotion = useReducedMotion();
    const [interacting, setInteracting] = useState(false);
    useEffect(() => {
        if (scene >= 3 || reducedMotion || listen || interacting) return;
        const timer = window.setTimeout(() => setScene(scene + 1), 10000);
        return () => window.clearTimeout(timer);
    }, [scene, reducedMotion, listen, interacting]);
    const messages = [
        t('cowork_home.intro.start', 'Hi, I’m Bee. Tell me what you need. Let me show you a weekly meeting digest.'),
        t('cowork_home.intro.steps', 'I turn your request into steps and test them. Select a step to see what it does.'),
        t('cowork_home.intro.result', 'Here’s the result. You can ask me to change the summary, share it or open another task.'),
        t('cowork_home.intro.choose', 'How would you like to use Cowork?'),
    ];
    const message = messages[scene];
    useEffect(() => {
        if (!listen || !window.speechSynthesis) return;
        const speech = new SpeechSynthesisUtterance(message);
        speech.lang = locale;
        window.speechSynthesis.speak(speech);
        return () => window.speechSynthesis.cancel();
    }, [listen, message, locale]);
    const sample = {helper: false, changed: false, to: null, app: null, integrationId: null};
    const steps: TaskStep[] = [
        {...sample, id: 'collect', sort: 'read', title: t('cowork_home.intro.collect', 'Collect meeting notes')},
        {...sample, id: 'write', sort: 'ai', title: t('cowork_home.intro.write', 'Write the weekly digest')},
    ];
    return <main className="cowork-intro" onFocus={() => setInteracting(true)}>
        <small>{t('cowork_home.intro.example', 'Cowork 2.0 · Interactive example')}</small>
        <CoworkOrb work={{action: actions[scene] ?? 'rest'}} tone={scene === 1 ? 'executing' : 'rest'} />
        <h1 key={scene} className="cowork-intro-line" aria-live="polite">{message}</h1>
        {scene === 1 && <div className="cowork-intro-sample"><CoworkStepRail steps={steps} selected={[selected]} toggle={select} t={t}/>
            <p role="status">{selected === 'collect' ? t('cowork_home.intro.read_hint', 'I found two example meeting notes from last week.') : t('cowork_home.intro.write_hint', 'I group the decisions and list who owns each action.')}</p></div>}
        {scene === 2 && <div className="cowork-intro-sample"><MarkdownRenderer content={t('cowork_home.intro.digest', '### Weekly digest\n\n- **Decision** — Start the pilot on Monday.\n- **Action** — Alex will share the checklist on Friday.')} /></div>}
        {scene < 3 ? <div className="cowork-intro-controls">
            <button className={BUTTON_PRIMARY} onClick={() => setScene(scene + 1)}>{t('cowork_home.intro.next', 'Continue')}</button>
            <button className={LINK_INLINE} onClick={() => setScene(3)}>{t('cowork_home.intro.skip', 'Choose my view')}</button>
            {'speechSynthesis' in window && <button className={LINK_INLINE} aria-pressed={listen} onClick={() => setListen(!listen)}>{t('cowork_home.intro.listen', 'Read aloud')}</button>}
        </div> : <div className="cowork-intro-controls">
            <button className={BUTTON_PRIMARY} onClick={() => choose('orb')}>{t('cowork_home.intro.orb', 'Chat with the orb')}</button>
            <button className={BUTTON_SECONDARY} onClick={() => choose('chat')}>{t('cowork_home.intro.chat', 'Chat only')}</button>
            <button className={BUTTON_SECONDARY} onClick={() => choose('advanced')}>{t('cowork_overview.advanced', 'Advanced')}</button>
        </div>}
    </main>;
}
