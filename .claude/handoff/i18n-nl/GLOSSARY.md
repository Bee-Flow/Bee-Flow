# Dutch UI glossary (nl)

This is the single source for how Bee Flow is written in Dutch. Every new `add-nl-*` catalogue follows it. It is derived from the existing Dutch migrations, and where those disagree it settles the term.

## Register
- **Address the reader as "je" / "jouw"**, never "u" / "uw". The existing Dutch uses "je" about 1,100 times and "u" 38 times.
- **Short and plain**, with one idea per sentence, in the same tone as the English.
- **Buttons:** an infinitive or a short command, the way Dutch apps do it: "Opslaan", "Annuleren", "Naam wijzigen", "Stap testen".
- **Headings and labels:** sentence case. Only the first word and names take a capital: "Gedeeld met mij", not "Gedeeld Met Mij".
- **Plurals and placeholders:** "{n} rijen", "{n} stappen". Placeholders stay exactly as they are.

## Leave untouched
- Placeholders: `{name}`, `{{name}}`, `%s`, `{n, plural, ...}`. Inside an ICU plural, translate only the text parts.
- HTML tags, Markdown (`**`, backticks, links), `\n`, ellipses `…`, emoji.
- Code, keys, URLs, e-mail addresses, file names, JSON and field names in backticks.
- Technical acronyms: API, URL, SSO, MFA, OAuth, SAML, SCIM, JSON, CSV, PDF, LLM, PII, DPIA, ISO 27001, GDPR (use **AVG** in running text), AI Act, DLP, MCP, OCR, WebDAV.

## Names that stay English (they are names, not words)
Bee Flow, Studio, Cowork, Privacy Shield, Compliance Center, Flowlet, Playbook / Playbooks, Skills / Skill, Agents / Agent, Apps / App, Trigger, Live, Nextcloud, Microsoft 365, Google, Teams, Outlook, GitHub, Mistral, Claude, OpenAI, Azure, Scaleway, EU GPT, Ollama.

## Fixed translations
| English | Dutch |
|---|---|
| Automation / Automations | Automatisering / Automatiseringen |
| Datatable / Datatables | Datatabel / Datatabellen |
| Webpage / Webpages | Webpagina / Webpagina's |
| Form / Forms | Formulier / Formulieren |
| Knowledge | Kennis |
| Knowledge base(s) | Kennisbank / Kennisbanken |
| Solution / Solutions | Oplossing / Oplossingen |
| Meeting Notes / Meeting notes | Vergadernotities |
| New Chat | Nieuwe chat |
| Chats | Chats |
| Approval / Approvals | Goedkeuring / Goedkeuringen |
| Run / Runs | Uitvoering / Uitvoeringen |
| Runs & log | Uitvoeringen & log |
| Memory (personal) | Geheugen |
| Conversation Memory | Gespreksgeheugen |
| Notebook / Notebooks | Notitieboek / Notitieboeken |
| Learning Center | Leercentrum |
| Building blocks | Bouwstenen |
| Step / Steps | Stap / Stappen |
| AI step | AI-stap |
| Condition | Voorwaarde |
| Publish / Published | Publiceren / Gepubliceerd |
| Activate | Activeren |
| Draft | Concept |
| Test step | Stap testen |
| Settings | Instellingen |
| Preferences | Voorkeuren |
| Organisation | Organisatie |
| Workspace | Werkruimte |
| Project / Projects | Project / Projecten |
| Template(s) | Sjabloon / Sjablonen |
| Owner | Eigenaar |
| Member(s) | Lid / Leden |
| Role(s) | Rol / Rollen |
| Group(s) | Groep / Groepen |
| Audience | Doelgroep |
| Share / Shared with me | Delen / Gedeeld met mij |
| Connection(s) | Koppeling / Koppelingen |
| Integration(s) | Integratie / Integraties |
| Tool(s) (an agent's tools) | Tool / Tools |
| Prompt | Prompt |
| Placeholder (Privacy Shield label such as `[NAME_1]`) | Plaatshouder |
| Personal data | Persoonsgegevens |
| Detection | Detectie |
| Encryption | Versleuteling |
| Zero-knowledge | Zero-knowledge |
| Usage & Monitoring | Gebruik & monitoring |
| Audit log | Auditlog |
| Retention | Bewaartermijn |
| Upload | Uploaden |
| Download | Downloaden |
| Export | Exporteren |
| Import | Importeren |
| Preview | Voorbeeld |
| Rows / Columns | Rijen / Kolommen |
| Field(s) | Veld / Velden |
| Filter | Filter |
| Dashboard | Dashboard |
| Lesson / Course | Les / Cursus |
| Quiz | Quiz |

## Lesson texts (`learn.*`)
- **Quote buttons and screens exactly as the Dutch UI shows them**, using the table above. For example: `Klik op **Nieuwe chat**`, `open **Instellingen › Organisatie › Privacy Shield**`.
- **Examples, names and data stay fictional.** Turn English example sentences into natural Dutch, but keep company and person names as they are.
