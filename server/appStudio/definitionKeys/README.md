# Top-level definition keys

One file per key that was added to the app definition after the frozen base: `<key>.js`,
exporting `{ key, since, canon, validate, public: false }`. `definitionKeyRegistry.mts` (one
level up) reads this folder in file-name order and documents the fields.

- `since` is the schema version that introduced the key (3 or higher). A definition that carries
  the key is stored with at least that `schemaVersion`; one that does not keeps the version it had.
- `canon` is only called when the key is present. An absent key stays absent, so no existing
  definition changes when a key is added here.
- A key reaches an anonymous visitor of a public page only with `public: true`.
- `description` (required) and `shape` (optional) are for the AI builder: its prompt lists the key in
  the extension index with the first sentence of `description`, and `app_inspect_catalog` answers
  `<key>: <shape> — <description>` (`../catalogTiers.mts`). Say which tool writes the key.

`catalogContract.test.js` (one level up) holds every file here to the rules and needs no edit for
a new key: `since` is an integer of 3 or more, `public` is written out (`false`, or `true` after
review), and the first sentence of `description` fits the index (at most 72
characters, no `;`, no line break). `componentSpecs/README.md` lists every other place a `since`
mark can sit.

The base keys (`meta`, `theme`, `screens`, `actions`, ...) are built by
`canonicalize/definition.js` itself and do not belong here.
