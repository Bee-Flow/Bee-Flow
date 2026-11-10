# Top-level definition keys

One file per key that was added to the app definition after the frozen base: `<key>.js`,
exporting `{ key, since, canon, validate, public: false }`. `definitionKeyRegistry.mts` (one
level up) reads this folder in file-name order and documents the fields.

- `since` is the schema version that introduced the key (3 or higher). A definition that carries
  the key is stored with at least that `schemaVersion`; one that does not keeps the version it had.
- `canon` is only called when the key is present. An absent key stays absent, so no existing
  definition changes when a key is added here.
- A key reaches an anonymous visitor of a public page only with `public: true`.
- `description` and `shape` are optional and are for the AI builder: its prompt lists the key in
  the extension index with the first sentence of `description`, and `app_inspect_catalog` answers
  `<key>: <shape> — <description>` (`../catalogTiers.mts`). Say which tool writes the key.

The base keys (`meta`, `theme`, `screens`, `actions`, ...) are built by
`canonicalize/definition.js` itself and do not belong here.
