/**
 * Fixtures for the Notebooks demo.
 *
 * A notebook is sources + a document + a chat that answers from those
 * sources. The demo ships one finished notebook — a tender response assembled
 * from six documents — so a visitor sees the editor with real content and a
 * populated source list rather than an empty page and an upload button.
 *
 * All sources, text and citations are invented.
 */

import { COMMON_ROUTES, DEMO_USER, daysAgo } from './common';
import { pick } from '../lang';

const NOTEBOOK_ID = 'nb_demo_tender';

// The page reads `name`, `type`, `status`, `wordCount` and `hasContent` —
// `title` is carried too because the citation components use that one.
const source = (id: string, name: string, type: string, wordCount: number) => ({
    id, name, title: name, type, status: 'ready',
    wordCount, hasContent: true, error: null, stage: 'ready',
    storageKey: null, metadata: {}, addedAt: daysAgo(12),
});

const SOURCES = () => ([
    source('src_1', pick({ en: 'Tender guidelines 2026-114.pdf', nl: 'Aanbestedingsleidraad 2026-114.pdf' }), 'pdf', 14820),
    source('src_2', pick({ en: 'Requirements specification.docx', nl: 'Programma van eisen.docx' }), 'docx', 6410),
    source('src_3', pick({ en: 'Clarification notes (round 1).pdf', nl: 'Nota van inlichtingen (ronde 1).pdf' }), 'pdf', 3180),
    source('src_4', pick({ en: 'Our reference projects.xlsx', nl: 'Onze referentieprojecten.xlsx' }), 'xlsx', 940),
    source('src_5', pick({ en: 'ISO 27001 certificate.pdf', nl: 'ISO 27001 certificaat.pdf' }), 'pdf', 610),
    source('src_6', pick({ en: 'Data processing agreement (draft).docx', nl: 'Verwerkersovereenkomst (concept).docx' }), 'docx', 4275),
]);

const DOCUMENT_HTML = pick({
    en: `
<h1>Tender 2026-114 — draft response</h1>
<p><em>Compiled from six source documents. Every claim below links back to its source.</em></p>

<h2>1. Understanding the assignment</h2>
<p>The contracting authority asks for a privacy-friendly AI workspace for about 400 employees,
with processing inside the EU and demonstrable control over data processing. The guidelines state this
as a knock-out criterion, not as a wish.</p>

<h2>2. Hard requirements and where we stand</h2>
<ul>
  <li><strong>EU data residency</strong> — required. We run entirely inside the region the customer chooses.</li>
  <li><strong>ISO 27001</strong> — required. Certificate attached, valid until March 2027.</li>
  <li><strong>Data processing agreement</strong> — the draft text differs from our standard on two points;
      see section 6.</li>
  <li><strong>Implementation lead time</strong> — at most eight weeks. Feasible based on the two
      reference projects of comparable size.</li>
</ul>

<h2>3. Open points for the second round of clarifications</h2>
<ol>
  <li>Does “processing inside the EU” also cover backups and logging?</li>
  <li>Is a self-hosted variant allowed, or must it be a SaaS service?</li>
  <li>Who is the data controller for employees’ conversation data?</li>
</ol>

<h2>4. Risks</h2>
<p>The biggest risk is not in the technology but in the schedule: the clarification round closes
eleven days before the submission date, while two of the three open points affect the scope.</p>
`.trim(),
    nl: `
<h1>Tender 2026-114 — conceptantwoord</h1>
<p><em>Samengesteld uit zes brondocumenten. Elke bewering hieronder is aanklikbaar naar de bron.</em></p>

<h2>1. Begrip van de opdracht</h2>
<p>De aanbestedende dienst vraagt om een privacy-vriendelijke AI-werkplek voor circa 400 medewerkers,
met verwerking binnen de EU en aantoonbare controle over de dataverwerking. De leidraad stelt dit als
knock-outcriterium, niet als wens.</p>

<h2>2. Harde eisen en waar wij op staan</h2>
<ul>
  <li><strong>EU-dataresidentie</strong> — vereist. Wij draaien volledig binnen de door de klant gekozen regio.</li>
  <li><strong>ISO 27001</strong> — vereist. Certificaat bijgevoegd, geldig tot maart 2027.</li>
  <li><strong>Verwerkersovereenkomst</strong> — de concepttekst wijkt op twee punten af van onze standaard;
      zie paragraaf 6.</li>
  <li><strong>Doorlooptijd implementatie</strong> — maximaal acht weken. Haalbaar op basis van de twee
      referentieprojecten van vergelijkbare omvang.</li>
</ul>

<h2>3. Open punten voor de tweede nota van inlichtingen</h2>
<ol>
  <li>Wordt onder “verwerking binnen de EU” ook back-up en logging begrepen?</li>
  <li>Is een zelf-gehoste variant toegestaan, of moet het een SaaS-dienst zijn?</li>
  <li>Wie is verwerkingsverantwoordelijke voor de gespreksdata van medewerkers?</li>
</ol>

<h2>4. Risico’s</h2>
<p>Het grootste risico zit niet in de techniek maar in de planning: de nota van inlichtingen sluit
elf dagen vóór de inschrijfdatum, terwijl twee van de drie open punten de scope raken.</p>
`.trim(),
});

interface Citation { index: number; sourceId: string; title: string; page: number }
interface ChatMessage { id: string; role: string; content: string; createdAt: string; citations?: Citation[] }

const CHAT = (): ChatMessage[] => ([
    {
        id: 'msg_1',
        role: 'user',
        content: pick({ en: 'Which requirements are knock-out and which are wishes?', nl: 'Welke eisen zijn knock-out en welke zijn wensen?' }),
        createdAt: daysAgo(4),
    },
    {
        id: 'msg_2',
        role: 'assistant',
        createdAt: daysAgo(4),
        content: pick({
            en: [
                'Four requirements are knock-out (grounds for exclusion if not met):',
                '',
                '1. Processing inside the EU — guidelines §3.2 [1]',
                '2. ISO 27001 or equivalent — guidelines §3.4 [1]',
                '3. Signed data processing agreement before award — requirements §7 [2]',
                '4. Implementation within eight weeks after award — requirements §9 [2]',
                '',
                'The rest of §4 of the requirements is worded as a wish and is scored, not excluded. ',
                'Note: in the clarification notes, question 14 was answered with “EU includes backup and ',
                'logging” — which makes the backup region part of the knock-out. [3]',
            ].join('\n'),
            nl: [
            'Vier eisen zijn knock-out (uitsluitingsgrond bij niet-voldoen):',
            '',
            '1. Verwerking binnen de EU — leidraad §3.2 [1]',
            '2. ISO 27001 of gelijkwaardig — leidraad §3.4 [1]',
            '3. Ondertekende verwerkersovereenkomst vóór gunning — PvE §7 [2]',
            '4. Implementatie binnen acht weken na gunning — PvE §9 [2]',
            '',
            'De rest van §4 van het PvE is geformuleerd als wens en wordt gescoord, niet uitgesloten. ',
            'Let op: in de nota van inlichtingen is vraag 14 beantwoord met “EU omvat ook back-up en ',
            'logging” — dat maakt back-upregio onderdeel van de knock-out. [3]',
        ].join('\n'),
        }),
        citations: [
            { index: 1, sourceId: 'src_1', title: SOURCES()[0].name, page: 11 },
            { index: 2, sourceId: 'src_2', title: SOURCES()[1].name, page: 6 },
            { index: 3, sourceId: 'src_3', title: SOURCES()[2].name, page: 4 },
        ],
    },
]);

type NotebookSource = ReturnType<typeof source>;

interface Notebook {
    id: string;
    name: string;
    title: string;
    description: string;
    documentContent: string;
    content: string;
    html: string;
    sources: NotebookSource[];
    messages: ChatMessage[];
    ownerId: string;
    isOwner: boolean;
    version: number;
    pinnedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

function notebook(): Notebook {
    return {
        id: NOTEBOOK_ID,
        // NotebooksPage filters on `nb.name` and renders `selected.name`;
        // a `title`-only fixture crashed the list with
        // "Cannot read properties of undefined (reading 'toLowerCase')".
        name: pick({ en: 'Tender 2026-114 — privacy-friendly AI workspace', nl: 'Tender 2026-114 — privacy-vriendelijke AI-werkplek' }),
        title: pick({ en: 'Tender 2026-114 — privacy-friendly AI workspace', nl: 'Tender 2026-114 — privacy-vriendelijke AI-werkplek' }),
        description: pick({ en: 'Six source documents, one draft response, with a source for every claim.', nl: 'Zes brondocumenten, één conceptantwoord, met bronvermelding per bewering.' }),
        // NotebooksPage reads `data.notebook.documentContent` when it opens a
        // notebook; `content`/`html` are carried for the list preview only. A
        // fixture without documentContent opens to a blank editor and the
        // preview says "This notebook is empty".
        documentContent: DOCUMENT_HTML,
        content: DOCUMENT_HTML,
        html: DOCUMENT_HTML,
        sources: SOURCES(),
        messages: CHAT(),
        ownerId: 'demo-user',
        isOwner: true,
        version: 1,
        pinnedAt: null,
        createdAt: daysAgo(12),
        updatedAt: daysAgo(4),
    };
}

function siblings(): Notebook[] {
    const base = notebook();
    const research = pick({ en: 'Market survey of EU AI vendors', nl: 'Marktverkenning EU AI-leveranciers' });
    const dpia = pick({ en: 'DPIA — AI assistant for customer service', nl: 'DPIA — AI-assistent voor de klantenservice' });
    return [
        // Exactly one sibling is pinned so the pin affordance is visible on
        // the demo grid without every card carrying it.
        { ...base, id: 'nb_demo_research', name: research, title: research, description: pick({ en: 'Who supplies what, and under which licence.', nl: 'Wie levert wat, en onder welke licentie.' }), sources: SOURCES().slice(0, 3), messages: [], pinnedAt: daysAgo(3), createdAt: daysAgo(60), updatedAt: daysAgo(21) },
        { ...base, id: 'nb_demo_dpia', name: dpia, title: dpia, description: pick({ en: 'Risk analysis and mitigations.', nl: 'Risico-analyse en mitigaties.' }), sources: SOURCES().slice(2, 5), messages: [], createdAt: daysAgo(120), updatedAt: daysAgo(45) },
    ];
}

// Fixtures are trusted, compile-time content, so a regex strip is enough here
// (the product derives preview/word counts server-side; see the API contract).
const stripTags = (html: string | null | undefined) => String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// The full card shape the overview grid consumes — exported so the parity
// test can catch this fixture drifting behind the real list endpoint.
export const toListItem = (n: Notebook) => {
    const docText = stripTags(n.documentContent);
    return {
        id: n.id, name: n.name, title: n.title, description: n.description,
        type: 'notebook', version: n.version || 1,
        sourceCount: (n.sources || []).length,
        processingCount: 0, failedCount: 0,
        sourceWordCount: (n.sources || []).reduce((sum: number, s: NotebookSource) => sum + (s.wordCount || 0), 0),
        docWordCount: docText ? docText.split(/\s+/).length : 0,
        messageCount: (n.messages || []).length,
        preview: docText.slice(0, 300),
        pinned: Boolean(n.pinnedAt),
        pinnedAt: n.pinnedAt || null,
        lastActivityAt: n.updatedAt, lastActivityKind: 'edit',
        createdAt: n.createdAt, updatedAt: n.updatedAt,
        ownerId: n.ownerId, isOwner: true,
    };
};

type State = { notebooks: Notebook[] };
type Body = { name?: string; pinned?: boolean; expectedVersion?: number } & Record<string, unknown>;
type Ctx = { state: State; params: Record<string, string>; body: Body | null; query: URLSearchParams };

export function createState(): State {
    return { notebooks: [notebook(), ...siblings()] };
}

const find = (state: State, id: string) => state.notebooks.find((n: Notebook) => n.id === id) || null;
const notFound = () => new Response(JSON.stringify({ error: 'Not found' }), { status: 404, headers: { 'Content-Type': 'application/json' } });

export const ROUTES = {
    ...COMMON_ROUTES,

    // A notebook opens in Studio → Documents: the library around it reads
    // its list (the notebook as a document of type 'notebook'), the folders
    // and who is signed in, also while the notebook is open.
    'GET /auth/user': () => ({ user: DEMO_USER }),
    'GET /api/studio-documents/folders': () => ({ folders: [] }),
    'GET /api/studio-documents': ({ state }: Ctx) => ({
        documents: state.notebooks.map((n: Notebook) => ({
            id: n.id, userId: DEMO_USER.id, name: n.name, docType: 'notebook', kind: 'document', visibility: 'private',
            folderId: null, categories: [], sourceCount: (n.sources || []).length, updatedAt: n.updatedAt, createdAt: n.createdAt,
        })),
        total: state.notebooks.length,
        people: {},
        notebooks: true,
    }),

    // Honours `search` and `sort=name` minimally; pinned floats first, same
    // as the real endpoint's `pinned_at DESC NULLS LAST`.
    'GET /api/notebooks': ({ state, query }: Ctx) => {
        let items = state.notebooks.map(toListItem);
        const search = (query?.get('search') || '').trim().toLowerCase();
        if (search) items = items.filter((n: ReturnType<typeof toListItem>) => (n.name || '').toLowerCase().includes(search));
        if (query?.get('sort') === 'name') items.sort((a: ReturnType<typeof toListItem>, b: ReturnType<typeof toListItem>) => a.name.localeCompare(b.name));
        items.sort((a: ReturnType<typeof toListItem>, b: ReturnType<typeof toListItem>) => Number(b.pinned) - Number(a.pinned));
        return { notebooks: items, hasMore: false };
    },
    // Envelope, not the bare record: the page reads `data.notebook.…`.
    /**
     * Opening a notebook is ONE call: NotebooksPage reads `data.notebook` AND
     * `data.sources` off this single response and does not fetch the sources
     * separately. A bare `{ notebook }` opened a notebook advertised as "six
     * documents deep" onto "0 sources · 0 words / Add your first source" —
     * the sources route below existed and was simply never called.
     */
    'GET /api/notebooks/:id': ({ state, params }: Ctx) => {
        const n = find(state, params.id);
        return n ? { notebook: n, sources: n.sources || [] } : notFound();
    },
    'PUT /api/notebooks/:id': ({ state, params, body }: Ctx) => {
        const n = find(state, params.id);
        if (!n) return notFound();
        // `pinned` maps to pinnedAt and — like the server — bumps neither
        // version nor updatedAt; `expectedVersion` is CAS input, not a field.
        const { pinned, expectedVersion: _ignored, ...rest } = body || {};
        if (pinned !== undefined) n.pinnedAt = pinned ? new Date().toISOString() : null;
        if (Object.keys(rest).length > 0) {
            Object.assign(n, rest);
            n.version = (n.version || 1) + 1;
            n.updatedAt = new Date().toISOString();
        }
        return { success: true, version: n.version || 1, notebook: n };
    },
    'POST /api/notebooks': ({ state, body }: Ctx) => {
        const created = { ...notebook(), id: `nb_demo_new_${state.notebooks.length + 1}`, name: body?.name || 'Untitled notebook', title: body?.name || 'Untitled notebook', documentContent: '', content: '', html: '', sources: [], messages: [] };
        state.notebooks.unshift(created);
        return { success: true, notebook: created };
    },
    'DELETE /api/notebooks/:id': ({ state, params }: Ctx) => {
        state.notebooks = state.notebooks.filter((n: Notebook) => n.id !== params.id);
        return { success: true };
    },
    'GET /api/notebooks/:id/sources': ({ state, params }: Ctx) => ({ sources: find(state, params.id)?.sources || [] }),
    'GET /api/notebooks/:id/messages': ({ state, params }: Ctx) => ({ messages: find(state, params.id)?.messages || [] }),
    'GET /api/notebooks/:id/conversation': ({ state, params }: Ctx) => ({ messages: find(state, params.id)?.messages || [] }),

    // Generation is scripted and says so — the demo calls no model.
    'POST /api/notebooks/:id/generate': () => ({
        demo: true,
        message: 'In the product this drafts a briefing, FAQ, mind map or data table from your sources. The demo does not call a model.',
    }),
};
