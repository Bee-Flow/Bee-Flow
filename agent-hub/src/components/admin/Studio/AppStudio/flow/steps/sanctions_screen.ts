import { ShieldAlert } from 'lucide-react';
import type { StepKindModule } from '../stepKinds';

/**
 * The editor's entry for the `sanctions_screen` step (server/appStudio/componentSpecs/steps/sanctions_screen.js):
 * a name screened against the official sanctions lists on the server, and optionally a job title checked
 * against the lists of prominent public functions (PEP). Its fields are drawn from the spec by StepSettings.
 */
const NS = 'studio_apps_step_sanctions';

const entry: StepKindModule = {
    kind: 'sanctions_screen',
    meta: {
        label: 'Screen against sanctions lists', labelKey: `${NS}.label`, group: 'Data', icon: ShieldAlert,
        blurb: 'Check a name against the EU, UN, Dutch, OFAC and UK sanctions lists, and a job title for a PEP function.',
        blurbKey: `${NS}.blurb`,
        server: true,
    },
    newStep: () => ({ kind: 'sanctions_screen', resultVar: 'screening' }),
    fields: {
        name: { hint: [`${NS}.hint_name`, 'The full name of the person or organisation.'] },
        birthDate: { label: [`${NS}.field_birth_date`, 'Birth date'], hint: [`${NS}.hint_birth_date`, 'Optional. Lowers the score of namesakes born in another year.'] },
        country: { hint: [`${NS}.hint_country`, 'Optional. Nationality or country, such as NL or Netherlands.'] },
        function: { label: [`${NS}.field_function`, 'Job title or function'], hint: [`${NS}.hint_function`, 'Optional. Checked against the Dutch and EU lists of prominent public functions.'] },
        lists: { hint: [`${NS}.hint_lists`, 'Leave empty to screen against every list.'] },
        minScore: { label: [`${NS}.field_min_score`, 'Lowest score'], hint: [`${NS}.hint_min_score`, 'From 0.5 to 1. Lower finds more spellings, and more namesakes.'] },
        maxResults: { label: [`${NS}.field_max_results`, 'Most candidates'] },
        resultVar: { hint: [`${NS}.hint_result_var`, 'The variable that gets the result: vars.<name>.candidates, vars.<name>.candidateCount and vars.<name>.pep.'] },
    },
};

export default entry;
