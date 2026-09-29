# Bee Flow — Documentation

Source for [docs.beeflow.ai](https://docs.beeflow.ai) — published via GitHub
Pages (custom domain set in `static/CNAME`; site URL and base path in
`docusaurus.config.ts`).

Built with [Docusaurus 3](https://docusaurus.io/) — React-based, MDX-powered.

## Local development

```bash
cd docs
npm install
npm start
```

Open <http://localhost:3000>.

## Build

```bash
npm run build       # static site -> ./build
npm run serve       # serve the build locally
npm run typecheck   # tsc over the TS config/components
```

## Structure

```
docs/                 Markdown content (one folder per top-level section)
├── getting-started/
├── connector/
├── self-hosting/
├── features/
├── studio/
├── integrations/
├── admin/
├── licensing/
├── api/
├── reference/
├── contributing/
└── img/screenshots/  Screenshots, one folder per topic

src/
├── pages/index.tsx       Custom marketing landing
├── components/           Hero, FeatureGrid, IntegrationsStrip, Pieces,
│                         WhoFor, CallToAction
├── css/custom.css        Amber theme + motion
└── remark/screenshots.mjs   Folder-as-screenshot resolver

static/
├── CNAME             Custom domain (docs.beeflow.ai)
├── cms/              Sveltia CMS admin (Decap-compatible config)
└── img/              Logo
docusaurus.config.ts  Site config
sidebars.ts           Sidebar nav definition
```

## Authoring

- Drop `.md` files into the appropriate folder under `docs/`.
- Add the new doc id to `sidebars.ts`.
- Admonitions use Docusaurus syntax: `:::note`, `:::tip`, `:::warning`, `:::danger`, `:::info`.
- Internal links can use either `.md` paths or relative URLs.
- Screenshots: drop a PNG/JPG in `docs/img/screenshots/<topic>/`. Reference it with a folder path ending in `/`:
  `![alt](../img/screenshots/<topic>/)` — the remark plugin picks the first image alphabetically.

## Contributing

Fork → branch → PR. Every page has an "Edit this page" link.

## License

Documentation is CC-BY-4.0. Code samples are MIT.
