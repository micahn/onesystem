---
id: schema
title: Vault data contract
kind: meta
surface: [mcp, http, cli]
tools: [predict]
engines: [julia, laya, rizzo]
question_types: [choice, score, noul]
status: current
tags: [meta, schema, self-search]
---

# Vault data contract

This vault has two audiences and one file format serves both.

- **Humans** read the notes. Prose, examples, caveats, the occasional argument about
  whether a use case is worth having.
- **An engine** reads `index/usecases.json`. It never parses the prose; it ranks the flat
  index and then a human or an agent opens the one note it picked.

The rule that keeps this honest: **prose may elaborate, never contradict.** If a fact
matters to a decision, it lives in the frontmatter. If it only matters to a reader, it
lives in the body.

## Frontmatter fields

Every note in `use-cases/`, `patterns/` and `reference/` carries this. Fields marked
**required** must be present; the rest should be filled in.

| Field | Type | Required | Meaning |
|---|---|---|---|
| `id` | string | yes | Stable slug, unique, kebab-case. Never renamed once referenced. |
| `title` | string | yes | Human title. |
| `kind` | enum | yes | `use-case`, `reference`, `pattern`, `meta`, `glossary`. |
| `surface` | list | yes | How you reach the service: `mcp`, `http`, `cli`. |
| `tools` | list | yes | Which tool: `predict`, or a laya-only tool named as such. |
| `engines` | list | yes | **Which engines can run this as written.** See below. |
| `question_types` | list | yes | `choice`, `score`, `noul`. |
| `status` | enum | yes | `proven`, `candidate`, `rejected`, `reference`. |
| `trigger` | string | no | The literal moment in a workflow where this fires. A condition, not a topic. |
| `human_review` | enum | no | `required`, `optional`, `none`. |
| `risk_when_wrong` | enum | no | `low`, `medium`, `high`. |
| `skills` | list | no | Workflow skills this plugs into. |
| `tags` | list | no | Free-form. |

### `engines` is the portability field, and it is not optional

This is the field that keeps a laya-only pattern from being read as a portable one.

`[rizzo]` is the normal value and means the payload runs as written on the engine this
machine has. `[laya]` alone means the note depends on a tool only laya has — `laya_route`,
`laya_preset` — and the comment line above the field says which. Those notes do not run here.

The value is a claim and it is checked: `scripts/run-payloads.py` executes every payload in
`use-cases/` against rizzo and fails if any is rejected, and
`scripts/verify-claims.py` checks the documented engine facts against a running onesystem.

### `human_review`

How much of a human's attention the answer still needs. This is the field that stops this
wiki from being an automation fantasy.

- `required` — the engine produces a *recommendation*, a human decides. Triage, gates,
  anything that blocks a person from moving.
- `optional` — the engine decides, a human may overturn. Ranking, prioritisation, defaults.
- `none` — the engine decides and the answer stands. Secret scanning, injection filters.

### `risk_when_wrong`

What breaks if the answer is confidently wrong.

- `low` — a re-read.
- `medium` — a wasted agent run, or a misordered queue.
- `high` — destroyed work, a leaked secret, a corrupted artifact.

`risk_when_wrong: high` with `human_review: none` is a combination this wiki treats as a
smell. It is allowed — secret scanning is exactly that shape — but it has to be deliberate.

### `status: rejected` is first-class

Notes are not deleted when a use case does not pan out. The `act_probability` trap means a
plausible-looking answer is cheap; the only durable signal is a record of what was measured.
`rejected` notes carry the reason in the body.

## What is deliberately not a field

- **`laya_version`.** Dropped. A version number in frontmatter goes stale silently and
  reads as a compatibility claim nobody verifies. Version facts live in prose, next to the
  argument they support.
- **`cost_ms`.** Dropped. Latency is per-engine — rizzo's warm median is 195 ms and julia's
  is 16 ms — so a single number in frontmatter would be one engine's figure presented as the
  note's. The per-engine table is in
[choosing an engine](../patterns/choosing-an-engine.md).
- **`projects`.** Dropped. It named private repositories, which is not a fact a public vault
  should carry.
- **`laya_predict` / `julia_predict` and friends.** `tools` names the *logical* tool. The
  registered name is a function of how many engines are enabled, so pinning it here would be
  wrong most of the time. The rule is stated once, in [MCP tools](../reference/mcp-tools.md).

## Why the index is one JSON file

High-cardinality ranking embeds the query and every option label, keeps the top *k*, and
runs one pass on the survivors. That only works if the options are in one addressable list.
Thirty-odd notes scattered across a vault would force a `grep` and a hand-rolled embedder
every time. One JSON file is one read.

The `criteria` block is shaped to be **drop-in valid** as a `choice` question's criteria:

```json
"criteria": {
  "ticket-gate": "Is this ticket fully specified: clear scope, no open questions, and testable acceptance criteria?"
}
```

That is exactly the `{"label": "description"}` shape the `predict` tool validates. No
translation layer, no adapter script. See
[self-search](../patterns/self-search.md).

## Invariants

- `index/usecases.json` parses. It is the one file that must never break.
- Every `id` in the index has a note, and every note's `id` is in the index.
  `scripts/validate.py` checks this.
- Labels in `criteria` are unique and stable. A label that silently changes meaning
  invalidates every stored probability.
- **Every complete payload in a note must be valid for the engines its `engines` field
  claims.** A payload in the docs that the named engine rejects is worse than no payload.
- **`engines` must match what the note actually uses.** A note with `engines: [laya,
  rizzo]` that calls a laya-only tool is a lie, and the validator cannot catch it — a human
  has to.

## Adding a use case

1. Add the entry to `index/usecases.json` — both the `criteria` one-liner and the full
   `use_cases` record. The gloss is what gets embedded, so write it for a reader who has
   never seen the note.
2. Create `use-cases/<id>.md` with the frontmatter above and a paste-ready payload.
3. Link it from [use-cases/index.md](../use-cases/index.md).
4. Run the payload once, on an engine the `engines` field names. Record the real answer under
   **Measured**. A use case with no measured output stays `candidate`.
