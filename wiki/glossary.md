---
id: glossary
title: Glossary
kind: meta
surface: [mcp, http, cli]
tools: [predict]
engines: [julia, laya, rizzo]
question_types: [choice, score, noul]
tags: [glossary, meta]
status: current
---

# Glossary

Terms used in this wiki, and the words this wiki borrows from elsewhere. Where a term
belongs to another project, that project owns the definition and this is a pointer.

## The shared vocabulary

These are the ones that mean the same thing on all three engines.

**Typed question** — one of three kinds: `choice`, `score`, `noul`. The only kind of
question any of these engines accepts. If you cannot phrase it as one of the three, you do
not have a decision yet.

**State** — what the question is asked *about*. Text, or a JSON object, and **which one is
a hard requirement per engine**: laya requires an object, julia requires a string, rizzo
takes either. See [compatibility](reference/compatibility.md). The quality of the state is
the quality of the answer.

**Instruction** — the sentence inside a question saying what is being asked. It is rendered
into the model's input, so it is part of the question's meaning and not metadata. A vague
instruction produces a confident answer to a vague question.

**Criteria** — your labels. For `choice` and `noul`, an object of `label -> description`;
for `score`, an ordered list of rubric levels. **Yours, not the engine's.** This is where
your vocabulary goes, and it is the entire advantage over a general model: `needs-triage` /
`ready-for-agent` mean what your triage skill says they mean.

**Rubric** — the ordered levels of a `score` question. The level *texts* do most of the
work. Write the bad thing into each level, not just the good thing.

**Forward pass** — one evaluation of the model plus its decision head. Every question in one
call shares one, which is why five related questions cost about what one costs.

**Probability** — what comes back instead of text. Read the distribution, not just the
argmax: two cases returning the same label are not the same case.

**Act probability** — a field on laya's answers that is `1.0` on every answer ever returned
and carries no information. Not a confidence. See
[guardrails](reference/guardrails.md).

## onesystem's vocabulary

**Backend** — a named entry in the config, with a transport. `laya`, `julia`, `rizzo`.

**Transport** — how onesystem reaches a backend: `stdio-mcp` (it starts and stops a
process), `systemone-serve` (it starts a service and polls for readiness), or
`systemone-http` (the service is already running and onesystem only forwards). See
[backends](reference/backends.md).

**The portable surface** — one tool, `predict`, and three question types. Everything else
any engine exposes is a bonus you cannot rely on.

**Engine** — a model behind a backend. The word is used instead of "model" where the
distinction matters, because the thing that answers is the engine and the weights are one
of its parts.

**`toolPrefix`** — a per-model prefix that keeps two engines' `predict` apart. Without it
the catalog lists the same tool name twice.

**Registered tool name** — the name a client actually calls. It is a function of how many
engines are enabled: bare when there is one, qualified when there are several and no default
is configured, and bare for the configured default. See
[MCP tools](reference/mcp-tools.md).

**Half-install** — a runtime directory with no `meta.json`. `runtimes` reports it as not
installed, which is the honest answer for an install that was interrupted.

## This wiki's vocabulary

**Use case** — a decision point in a real workflow, written as a typed question with a
paste-ready payload. The unit of this wiki.

**Criterion gloss** — the `criteria` one-liner in `index/usecases.json`, written for a reader
who has never seen the note. It is the text that gets embedded, so it has to stand alone.

**Use-case index** — `index/usecases.json`, the machine-readable half. An engine ranks it
against a live situation; a human then opens the note it picked.

**`human_review`** — how much human attention the answer still needs: `required`,
`optional`, or `none`. The field that keeps this from being an automation fantasy.

**`risk_when_wrong`** — what breaks if the answer is confidently wrong: `low`, `medium`,
`high`. `high` with `human_review: none` is a smell.

**Candidate / proven / rejected** — a use case's status. `candidate` means designed but
unrun, `proven` means measured with the numbers in the note, `rejected` means it was tried
or argued out and the reason is recorded. Only the last two carry evidence.

## Borrowed from laya

laya's vocabulary is richer than the shared surface, and these terms appear in notes scoped
to it. laya owns all of them; the pointers are in [the models page](reference/models.md).

**Checkpoint** — a loaded encoder plus decision head. Which one is resident is laya's
choice, not yours.

**Preset** — a prebuilt classifier, e.g. `guard` for sensitive data. laya's `preset` tool
runs one.

**Route** — pick a workflow from a description, without a language model in the loop.
laya's `route` tool.

**Shortlist** — high-cardinality ranking: embed the query and every option label, keep the
top *k*, then one pass over the survivors.

**`max_loaded`** — how many checkpoints laya keeps resident. Also the name of the idea that
`preset` and `route` are built on.

## See also

[Home](Home.md) · [What a model has to provide](reference/compatibility.md) ·
[the vault data contract](index/schema.md)
