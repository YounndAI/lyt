# Lyt automators

An **@AUTOMATOR** is a scheduled or triggered process that reads mesh state,
optionally consults an LLM, and writes vault artifacts. Automators are the
moat layer per the YounndAI architecture (mesh underneath, RAG alongside,
automators on top).

## Where automator declarations live

Per-vault, in `.lyt/automators/*.yon`. Each file is a YON document declaring
one or more `@AUTOMATOR` records. The block-A.3 reference declaration is:

```
.lyt/automators/metadata-filler.yon   ← bundled in every fresh vault
```

`metadata-filler` is the v1 reference automator (arc §6.13 Example 1):
fills missing frontmatter fields on notes that aren't following the v1
contract. It's `archetype=filler`, `source=system`, `signed_by=system:lyt`,
auto-claims `as_roles=[automator:system]`.

## v1 (block-A) ships **declarations only — no runtime**

block-A locks the `@AUTOMATOR` shape (32 fields, 9 mandatory) and bundles
the first reference declaration. The runtime that consumes these (lyt-runner)
lands in **block-B**: declarations don't execute until then.

Until block-B, declarations serve as:

- A contract for block-B's expander to test against.
- A discovery surface — handlers can read what an automator declares
  _intends_ to do.
- The seed for the dogfooding ergonomics test (arc §9): real first-party
  declarations exercise the parser + scaffold flow end-to-end.

## Authoring your own automator

Once block-B lands, custom automators live alongside the bundled ones in
`.lyt/automators/<your-name>.yon`. The 9 mandatory fields are:

| Field              | Notes                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------ | ------------------------ | ------- | ---------------------------- |
| `rid`              | `automator:<name>`                                                                         |
| `name`             | kebab-case                                                                                 |
| `version`          | semver                                                                                     |
| `archetype`        | one of 14 (see arc §6.4) — start with `filler`, `propagator`, `generator`, or `aggregator` |
| `description`      | one-line                                                                                   |
| `source`           | `system                                                                                    | user                     | mesh    | marketplace`(yours is`user`) |
| `runtime`          | `deterministic                                                                             | llm                      | hybrid` |
| `transaction_mode` | v1 only `none`; v2 adds `checkpoint`                                                       |
| `scope`            | `vault                                                                                     | mesh`(start with`vault`) |

23 optional fields cover scheduling, triggers, memscope permissions, LLM
preferences, retention. See `<vault>/.lyt/automators/metadata-filler.yon`
for a working reference.

## Validating a declaration

Before committing a `.yon` file, validate against `@younndai/yon-parser`:

```
node <yon-parser>/dist/cli.js validate <file>.yon --profile full --lenient
```

Acceptable warnings:

- `Unknown domain "yai.lyt"` — expected until the yai.lyt schema is
  registered with `@younndai/domains` (planned post-v1).
- `Audit profile requires at least one @STAMP record` — informational;
  `@STAMP` records are auto-injected by lyt-runner at write-time per arc §11.

## Further reading

- Arc thoughts §6.10 — full 32-field @AUTOMATOR schema set.
- Arc thoughts §6.11 — lyt-runner architecture (block-B).
- Arc thoughts §6.13 — verified YON examples (`metadata-filler`,
  `rollup-aggregator`, `timesheet-extractor`, `acme-billing-weekly`).
- `<vault>/yai.lyt` (or `<repo>/Projects/the LYT design vault/yai.lyt.md`)
  — yai.lyt domain spec.
