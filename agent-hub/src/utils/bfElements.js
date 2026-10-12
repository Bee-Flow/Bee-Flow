/**
 * Het bf-*-elementvocabulaire, zoals de CLIENT het kent.
 *
 * Het vocabulaire leeft op drie plekken: deze client-kant (de preview en een
 * ingelogde lezer, via composeWebpageDocument.js en buildWebpagePreview.js),
 * server/services/publicBridgeScript.js (de publieke react-share) en
 * server/services/webpageSnapshot.js (de snapshot die vóór DOMPurify uitklapt).
 * De twee serverplekken requiren server/core/webpages/bfElements.js rechtstreeks.
 * Dit bestand kan dat niet — het is ESM-frontendcode buiten die build, dezelfde
 * reden waarom publicBridgeScript.js en reactBundleServer.js hun eigen kopie van
 * de client-brug houden — dus staat hier een SPIEGEL.
 *
 * Die spiegel wordt NIET met de hand bijgehouden. Ze is gegenereerd, en
 * server/core/webpages/bfElements.drift.test.js legt het blok hieronder teken
 * voor teken naast renderClientMirror(); wijkt het af, dan zet de foutmelding de
 * vervangende tekst erbij. Regenereren:
 *
 *   cd server && node -e "console.log(require('./core/webpages/bfElements').renderClientMirror())"
 *
 * Dit is de datastructuur, niet de weergave: de renderer die eruit leest komt in
 * de volgende stap. Wat elk veld betekent, staat in de kop van de servermodule.
 */
// >>> BF-ELEMENTS: BEGIN GEGENEREERDE SPIEGEL <<<
// Gegenereerd uit server/core/webpages/bfElements.js — NIET met de hand
// bijwerken. bfElements.drift.test.js vergelijkt dit blok teken voor teken
// met renderClientMirror() en zet de vervangende tekst in zijn foutmelding.
export const BF_ELEMENTS = [
    {
        "tag": "bf-table",
        "summary": "Rows from a datatable the page is bound to, rendered as a plain table.",
        "needsJs": false,
        "attributes": [
            {
                "name": "source",
                "required": true,
                "aliases": [
                    "datatable"
                ],
                "means": "Id of the datatable. It must be bound to this page in bridge_grants.tables."
            },
            {
                "name": "limit",
                "required": false,
                "max": 100,
                "means": "How many rows to show. Clamped to 100; a missing or unreadable value means 100."
            }
        ],
        "binding": {
            "kind": "datatable",
            "from": "source",
            "gate": "bridge_grants.tables[].publicColumns"
        },
        "surfaces": {
            "clientComposer": {
                "state": "live",
                "why": "De ingelogde lezer haalt de rijen zelf op via window.beeflowTables, als zichzelf, met zijn eigen graad."
            },
            "reactShare": {
                "state": "refused",
                "message": "bf-table is not expanded on a shared React page",
                "notice": "This table cannot be shown on a shared link.",
                "why": "writeReactSnapshot bundelt de app en draait GEEN uitklappass; beeflowTables weigert bovendien op een share."
            },
            "vanillaSnapshot": {
                "state": "static",
                "why": "Eenmalig uitgelezen bij publiceren en tot gewone <table>-HTML gerenderd, VÓÓR DOMPurify (services/webpageBfTable.js)."
            },
            "headlessRender": {
                "state": "refused",
                "message": "bf-table is not expanded in the preview image",
                "notice": "This table is not shown in the preview image.",
                "why": "services/webpageRender.js schiet een plaatje in de bf-browser, die van de API is afgesneden; buildStubBridgeScript weigert daar beeflowTables. Er valt niets te lezen, en de bouwer-AI die naar dat plaatje kijkt moet dat kunnen ZIEN in plaats van een lege plek voor \"geen rijen\" aan te zien."
            }
        }
    },
    {
        "tag": "bf-stat",
        "summary": "A single number derived from a bound datatable (a count, sum, average, minimum or maximum).",
        "needsJs": false,
        "attributes": [
            {
                "name": "source",
                "required": true,
                "aliases": [
                    "datatable"
                ],
                "means": "Id of the datatable. It must be bound to this page in bridge_grants.tables."
            },
            {
                "name": "agg",
                "required": false,
                "values": [
                    "count",
                    "sum",
                    "avg",
                    "min",
                    "max"
                ],
                "default": "count",
                "means": "Which number to show. Defaults to counting the rows."
            },
            {
                "name": "column",
                "required": false,
                "requiredWhen": {
                    "attr": "agg",
                    "notOneOf": [
                        "count"
                    ]
                },
                "means": "Column to aggregate. Required for every agg except count, and it must be one of the public columns."
            },
            {
                "name": "label",
                "required": false,
                "means": "Caption shown next to the number."
            }
        ],
        "reads": {
            "rowsMax": 500
        },
        "binding": {
            "kind": "datatable",
            "from": "source",
            "gate": "bridge_grants.tables[].publicColumns"
        },
        "surfaces": {
            "clientComposer": {
                "state": "live",
                "why": "Wordt net als bf-table door de lezer zelf berekend via window.beeflowTables."
            },
            "reactShare": {
                "state": "refused",
                "message": "bf-stat is not expanded on a shared React page",
                "notice": "This number cannot be calculated on a shared link.",
                "why": "Zelfde reden als bf-table: een react-share kent geen server-side uitklappass."
            },
            "vanillaSnapshot": {
                "state": "static",
                "why": "Eenmalig berekend bij publiceren en als gewone tekst neergezet, VÓÓR DOMPurify."
            },
            "headlessRender": {
                "state": "refused",
                "message": "bf-stat is not calculated in the preview image",
                "notice": "This number is not calculated for the preview image.",
                "why": "Zelfde reden als bf-table: geen tabelbrug in de headless render."
            }
        }
    },
    {
        "tag": "bf-button",
        "summary": "A button that runs one of the automations this page is allowed to run.",
        "needsJs": true,
        "attributes": [
            {
                "name": "run",
                "required": true,
                "means": "Id of the automation to run. It must be granted to this page in bridge_grants.automations."
            },
            {
                "name": "label",
                "required": false,
                "means": "Button text. Falls back to the text inside the element."
            },
            {
                "name": "confirm",
                "required": false,
                "means": "Ask the reader to confirm before running. Any non-empty value turns it on."
            }
        ],
        "binding": {
            "kind": "automation",
            "from": "run",
            "gate": "bridge_grants.automations"
        },
        "surfaces": {
            "clientComposer": {
                "state": "live",
                "why": "window.beeflowAutomations.run draait acts-as-author voor een ingelogde lezer."
            },
            "reactShare": {
                "state": "refused",
                "message": "bf-button cannot run an automation on a shared link",
                "notice": "This button cannot run anything on a shared link.",
                "why": "De anonieme brug stubt beeflowAutomations.run als no-op; de server weigert dat oppervlak sowieso. Een no-op die RESOLVET is hier het gevaarlijkst van allemaal: de knop meldt dan succes zonder iets te doen. Daarom moet dit element zijn weigering ZELF tonen, niet op de brug wachten."
            },
            "vanillaSnapshot": {
                "state": "inert",
                "notice": "This button is not active in the published copy of this page.",
                "why": "De vanilla snapshot bevat geen JS, dus er valt niets te starten. Uitklappen tot een zichtbaar uitgeschakelde knop MET deze tekst, vóór DOMPurify — anders pakt de sanitizer het element stil uit en blijft er alleen de losse tekst over. harden() sloopt daarna elke on*= alsnog."
            },
            "headlessRender": {
                "state": "refused",
                "message": "bf-button cannot run an automation in the preview image",
                "notice": "This button is not active in the preview image.",
                "why": "De stub-brug maakt van beeflowAutomations.run een weigering; een automatisering starten vanuit een screenshot mag sowieso niet."
            }
        }
    },
    {
        "tag": "bf-form",
        "summary": "A form whose submission is handed to one of the automations this page is allowed to run.",
        "needsJs": true,
        "attributes": [
            {
                "name": "automation",
                "required": true,
                "means": "Id of the automation that receives the submitted fields. It must be granted to this page in bridge_grants.automations."
            },
            {
                "name": "submit-label",
                "required": false,
                "means": "Text on the submit button."
            },
            {
                "name": "confirm",
                "required": false,
                "means": "Ask the reader to confirm before submitting. Any non-empty value turns it on."
            }
        ],
        "binding": {
            "kind": "automation",
            "from": "automation",
            "gate": "bridge_grants.automations"
        },
        "surfaces": {
            "clientComposer": {
                "state": "live",
                "why": "De ingelogde lezer verstuurt via window.beeflowAutomations.run."
            },
            "reactShare": {
                "state": "refused",
                "message": "bf-form cannot submit to an automation on a shared link",
                "notice": "This form cannot be submitted on a shared link.",
                "why": "Zelfde no-op-stub als bf-button, met hetzelfde gevaar: stil \"verzonden\" zonder ontvanger."
            },
            "vanillaSnapshot": {
                "state": "inert",
                "notice": "This form is not active in the published copy of this page.",
                "why": "LET OP: NIET uitklappen tot een echte <form>. DOMPurify heeft `form` in FORBID_TAGS staan, dus het formulier zelf verdwijnt en KEEP_CONTENT laat de losse velden staan — een half formulier zonder knop. Uitklappen tot een gewoon blok met deze tekst en uitgeschakelde velden."
            },
            "headlessRender": {
                "state": "refused",
                "message": "bf-form cannot submit to an automation in the preview image",
                "notice": "This form is not active in the preview image.",
                "why": "Zelfde weigering als bf-button, en om dezelfde reden."
            }
        }
    },
    {
        "tag": "bf-agent",
        "summary": "An inline chat block backed by one of your agents.",
        "needsJs": true,
        "attributes": [
            {
                "name": "agent",
                "required": false,
                "means": "Id of the agent. Leave it out to use the agent bound to this page (bridge_grants.agent)."
            },
            {
                "name": "placeholder",
                "required": false,
                "means": "Placeholder text in the input."
            }
        ],
        "binding": {
            "kind": "agent",
            "from": "agent",
            "fallback": "bridge_grants.agent",
            "gate": "bridge_grants.agent"
        },
        "surfaces": {
            "clientComposer": {
                "state": "live",
                "why": "window.beeflowAI.ask draait de agentische gereedschapslus voor een ingelogde lezer."
            },
            "reactShare": {
                "state": "refused",
                "message": "bf-agent is not available on a shared link",
                "notice": "The assistant is not available on a shared link.",
                "why": "ai.ask is bewust uit de anonieme brug gehouden (alleen /ai/chat en /ai/stream); een publieke agent vereist eerst het bevestigingsbeleid en krijgt dán zijn eigen expliciete veld."
            },
            "vanillaSnapshot": {
                "state": "inert",
                "notice": "The assistant is not available in the published copy of this page.",
                "why": "Geen JS én geen agent-brug: dubbel dood. Uitklappen tot een blok met deze tekst."
            },
            "headlessRender": {
                "state": "refused",
                "message": "bf-agent is not available in the preview image",
                "notice": "The assistant is not available in the preview image.",
                "why": "De stub-brug kent geen ask; en een screenshot laten wachten op een agentische lus zou de render laten aflopen."
            }
        }
    }
];
// >>> BF-ELEMENTS: EINDE GEGENEREERDE SPIEGEL <<<
