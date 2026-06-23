# Lyt automators

An **@AUTOMATOR** is a declarative, in-vault process that reads vault/mesh state,
optionally consults an LLM, and writes vault artifacts — fill missing metadata,
build lanes, run a sync flow. Automators are YON documents that live *inside* a
vault, so they are versioned with your knowledge, reviewable in any diff, and
legible to AI agents.

The runtime that executes them is [`@younndai/lyt-runner`](https://www.npmjs.com/package/@younndai/lyt-runner):
it loads the `yai.lyt` expander (which turns `@AUTOMATOR` + `@DIRECTIVE` records
into core YON `@AGENT`/`@STEP`/ops) and registers the vault-aware operation set
(`std:vault.*`, `std:mesh.*`, `std:lease.*`, and `std:llm.*` via
[`@younndai/lyt-llm`](https://www.npmjs.com/package/@younndai/lyt-llm)).

## Where automator declarations live

Per-vault, in `.lyt/automators/*.yon`. Each file is a YON document declaring one
or more `@AUTOMATOR` records. Every fresh vault ships with a bundled reference
automator:

```
.lyt/automators/metadata-filler.yon   ← bundled in every fresh vault
```

`metadata-filler` fills missing frontmatter on notes that don't yet follow the
v1 contract. It is `archetype=filler`, `source=system`, `signed_by=system:lyt`,
and claims `as_roles=[automator:system]`.

## Running automators

```bash
lyt automator list [--vault <name>]      # declarations present in the vault
lyt automator status [--vault <name>]    # last run + state per automator
lyt automator run <name> --vault <name>  # execute a declared automator
```

Vault/mesh writes from an automation pass the same writability gates as human
and agent writes, and each run is recorded in the vault's provenance ledger —
auditable, replayable, no hidden side effects.

## Authoring your own automator

Custom automators live alongside the bundled ones in
`.lyt/automators/<your-name>.yon`. The mandatory fields:

| Field              | Notes                                                                   |
| ------------------ | ----------------------------------------------------------------------- |
| `rid`              | `automator:<name>`                                                      |
| `name`             | kebab-case                                                              |
| `version`          | semver                                                                  |
| `archetype`        | `filler` · `propagator` · `generator` · `aggregator` (among others)     |
| `description`      | one line                                                                |
| `source`           | `system` · `user` · `mesh` · `marketplace` (yours is `user`)            |
| `runtime`          | `deterministic` · `llm` · `hybrid`                                      |
| `transaction_mode` | `none` (v1)                                                             |
| `scope`            | `vault` · `mesh` (start with `vault`)                                   |

Optional fields cover scheduling, triggers, memscope permissions, LLM
preferences, and retention. Use the bundled
`<vault>/.lyt/automators/metadata-filler.yon` as a working reference.

## Validating a declaration

Before committing a `.yon` file, validate it with the YON parser:

```bash
yon validate <file>.yon --profile full --lenient
```

Acceptable informational warnings:

- `Unknown domain "yai.lyt"` — expected until the `yai.lyt` schema is registered
  with the YON domain registry.
- `Audit profile requires at least one @STAMP record` — informational; `@STAMP`
  records are auto-injected at write-time.

## See also

- `lyt help patterns` — patterns (templates) vs automators (executable declarations).
- `lyt help ledgers` — where automator runs are recorded.
