---
id: home
title: Onesystem Wiki
kind: meta
surface: [mcp, http, cli]
tools: [predict]
engines: [julia, laya, rizzo]
question_types: [choice, score, noul]
status: current
tags: [moc, onesystem, decision-engines]
---

# Onesystem Wiki

onesystem runs local **decision engines** behind one service and one payload. An engine
answers **typed questions** over any state in a single pass, and it does not generate text.
That single design choice is the reason this wiki exists: the interesting problems in an
agent workflow are not "write the answer" problems, they are "which of these five things is
true" problems. Those are exactly what a small classifier is good at, and exactly what a
language model is mediocre at while costing orders of magnitude more.

The catch is that a classifier is only as useful as the questions you know to ask it. So
this wiki is organised around **decision points in real workflows**, not around an API.

This wiki is engine-agnostic. It does not assume you have laya, julia or rizzo, or which of
them — it tells you how to find out, and what holds either way.

## First: find out what you have

You cannot write a correct call until you know which engines are installed, which are
enabled, and what they are called. All three answers come from the running daemon.

```bash
# Which engines answer, and what are their tool names right now?
curl -s localhost:7331/catalog | jq '.backends[] | {backend, tools: [.tools.tools[].name]}'

# What is installed, where, and what is each one doing?
curl -s localhost:7331/health | jq '.backends[] | {name, transport, state}'
```

Two things are true of **every** engine, so you can read the rest of this wiki without
checking:

- **One tool.** `predict`. Anything else an engine exposes (`route`, `preset`, `shortlist`,
  the `*_batch` variants) is that engine's own and nothing else has it.
- **One payload.** `{state, questions}`, with three question types.

If `catalog` is empty, nothing is enabled — see
[backends](reference/backends.md). If the daemon is not answering at all, `onesystem start`.

### The tool name is not fixed

It is derived from how many engines you have enabled, so **look it up rather than
hardcoding it**:

| enabled | routing default | tool name |
|---|---|---|
| one engine | — | `predict` |
| several | unset | `julia_predict`, `laya_predict`, `rizzo_predict` |
| several | one named | that one keeps `predict`, the rest qualified |

`POST /call` sidesteps the whole question, because it takes the backend and the tool
separately and does not care. See [MCP tools](reference/mcp-tools.md).

### It returns a string

Every engine's tool resolves to a **JSON string**, because that is what the plugin hands
back. Read `.answers` off the raw result and you get `undefined`, which looks exactly like a
dead engine — it is the most common reason a first attempt gets abandoned.

```javascript
const answer = JSON.parse(await tools.predict({ state, questions }));
```

This is a property of the bridge, not of any engine, so it holds however many you have.

## The contract that holds for all of them

| type | `criteria` you pass | you get back | use it for |
|---|---|---|---|
| `choice` | `{label: description}` | `choice` + `probabilities` | which of N things is true |
| `noul` | `{false: …, true: …}` | `noul` | one proposition, yes or no |
| `score` | **ordered array** of levels | `score` + `legend` + `probabilities` | where on a scale you defined |

`score` takes an array where the other two take an object. That is the one shape error worth
memorising, and it is the same on every engine.

One call answers every question in it, so asking five related questions costs about what one
costs. See [multi-question batches](patterns/multi-question-batches.md).

```javascript
const answer = JSON.parse(await tools.predict({
  state: { situation: "A payments endpoint began returning 503 for 4% of requests after the pool was capped at 5. p99 went 40ms to 2.1s." },
  questions: {
    cause: {
      type: "choice",
      instructions: "What is the proximate cause of the 503s?",
      criteria: { pool: "The pool is saturated at its cap.", upstream: "The upstream is degraded." },
    },
    severity: {
      type: "score",
      instructions: "How severe is this?",
      criteria: ["Minor, self-clearing.", "Degraded but usable.", "Partial outage."],
    },
  },
}));
```

## What differs between engines, and why it matters

The inputs can be made identical. Three things cannot:

1. **`state` shape.** laya requires an object, julia requires a string, rizzo takes either.
   A payload written for one is a validation error in another.
2. **The answer format.** They disagree about their own contract — `noul` declares no
   polarity, confidence is named three different ways, and one engine returns two different
   confidence numbers in the same object. A reader that parses all of them with one function
   silently mis-scores two.
3. **Whether the confidence means anything.** Measured over 100 cases, one engine's
   high-confidence band was 100% correct and the other two were 56% and 54% — worse than
   useless as a gate. The same threshold code is correct on one engine and an error factory on
   another.

All of it is measured, not asserted:
**[what a model has to provide](reference/compatibility.md)** is the contract page, and
**[choosing an engine](patterns/choosing-an-engine.md)** is the decision.

## Start here

- **What can a model do at all?** → [what a model has to provide](reference/compatibility.md)
  — the measured matrix, and the seven requirements
- **Which engine should I use?** → [choosing an engine](patterns/choosing-an-engine.md)
- **How do I call one?** → [MCP tools](reference/mcp-tools.md) · [CLI](reference/cli.md) ·
  [backends](reference/backends.md)
- **What comes back?** → [answer payload](reference/answer-payload.md), field by field
- **When should I *not* use it?** → [guardrails](reference/guardrails.md) — read this one
  before wiring any of this into something that matters
- **Where does it fit in my work?** → [34 use cases](use-cases/index.md) ·
  [skill integration](patterns/wiring-into-skills.md)

## The four things people get wrong

1. **Not checking which engines exist.** Writing `onesystem.predict` — a name that has
   never resolved — or hardcoding a tool name that changes when you enable a second engine.
2. **Trusting a confidence number.** It is not a correctness signal, and on two of the three
   engines it is not even a usable gate. The field is called `confidence`; that is not what it
   is. See [guardrails](reference/guardrails.md).
3. **Padding the `state`.** A verbose restatement performed far worse than a short focused
   one — `0.3059` against `0.9644` — at every option count, and it was confidently wrong.
4. **Asking it open questions.** It will not summarise your diff or reason across five files.
   It will hand you a confident label for a question you did not know how to pose. Every use
   case here is a *typed* question for a reason.

## The wiki is also an index

`index/usecases.json` is the machine-readable half, and any engine can rank this wiki's own
use cases against a live situation. Its `criteria` block is drop-in valid as a `choice`
question's criteria, so there is no adapter. [The contract](index/schema.md) explains the
fields; [self-search](patterns/self-search.md) shows the call. **Prose may elaborate, never
contradict** — the rule that keeps the two halves honest.

## What the measurements changed

Every latency and probability here was measured, and several results overturned an earlier
draft of these notes. They are kept in, because a wiki that only records its successes is not
worth maintaining.

- **Confidence is per-engine.** An earlier version of this page said flatly that it is not a
  gate, on the strength of one engine. It is a gate on rizzo and is not on laya or julia,
  which is a more useful sentence than the one it replaced.
- **`state` quality is the biggest lever, and padding it usually hurts.** Focused beat
  verbose 2 times out of 3, by ~0.65 both times. The third is the interesting one: verbose
  scored *higher* and was still wrong, so the failure mode is a confident error rather than a
  hedged one.
- **34 labels is fine.** A documented `choice:11+` clamp was blamed for a bad result; then
  isolating the variable showed 34 labels beat a hand-picked 10 on the same input.
- **Do not average engines.** One engine alone scored 86.4%, a three-model majority 65.9%,
  and the ceiling for any router was 93.2% — three cases of headroom.

Details: [choosing an engine](patterns/choosing-an-engine.md),
[guardrails](reference/guardrails.md), and the
[full A/B/C writeup](https://micahn.github.io/onesystem-ab/).
