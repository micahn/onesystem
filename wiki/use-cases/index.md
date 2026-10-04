---
id: use-cases-index
title: Use cases
kind: meta
surface: [mcp, http]
tools: [predict, laya_route, laya_preset]
# Only laya. Uses a laya-only tool; see reference/compatibility for what that costs.
engines: [laya]
question_types: [choice, score, noul]
tags: [moc, use-cases]
status: current
---

# Use cases

34 decision points, grouped by where they fire. Each has a paste-ready payload, a
`human_review` level, a `risk_when_wrong`, and an `engines` field saying which engines can
run it as written — [laya and rizzo](../reference/compatibility.md) take an object `state`,
julia needs a string. The machine-readable version of this table
is `index/usecases.json` — see [index/schema](../index/schema.md) for the field contract.

**`human_review`** is the column that matters most. `required` means the engine produces a
recommendation and a human decides; `none` means the answer stands. Only two use cases
reach `none`, and both are filters.

| | Count |
|---|---|
| `human_review: required` | 12 |
| `human_review: optional` | 19 |
| `human_review: none` | 3 |
| `status: proven` | 5 |
| `status: candidate` | 29 |
| `risk_when_wrong: high` | 4 |

## Gates and specs

The layer between "someone wrote this down" and "an agent starts". Highest value per
call, because a wrong gate costs a whole agent run.

| Use case | Review | Risk | Status |
|---|---|---|---|
| [use-cases/ticket-gate](ticket-gate.md) | required | low | **proven** |
| [use-cases/spec-readiness](spec-readiness.md) | required | medium | candidate |
| [use-cases/ticket-granularity](ticket-granularity.md) | required | medium | candidate |
| [use-cases/blocking-edges-genuine](blocking-edges-genuine.md) | optional | medium | candidate |
| [use-cases/acceptance-criteria-checkable](acceptance-criteria-checkable.md) | optional | medium | candidate |

## Triage

The richest cluster, because `triage` SKILL.md is already a labelled state machine. Lift
the labels, do not use the `triage` preset.

| Use case | Review | Risk | Status |
|---|---|---|---|
| [use-cases/triage-state](triage-state.md) | required | medium | candidate |
| [use-cases/triage-category](triage-category.md) | required | low | candidate |
| [use-cases/triage-unusual-transition](triage-unusual-transition.md) | required | low | candidate |
| [use-cases/triage-claim-holds](triage-claim-holds.md) | required | medium | candidate |
| [use-cases/triage-already-implemented](triage-already-implemented.md) | optional | medium | candidate |

## Wayfinding

Where a decision is about *which* decision to make. `hitl-or-afk` is the one with hard
consequences attached.

| Use case | Review | Risk | Status |
|---|---|---|---|
| [use-cases/frontier-priority](frontier-priority.md) | optional | medium | candidate |
| [use-cases/fog-or-ticket](fog-or-ticket.md) | optional | medium | candidate |
| [use-cases/wayfinder-type](wayfinder-type.md) | required | medium | candidate |
| [use-cases/hitl-or-afk](hitl-or-afk.md) | required | **high** | candidate |
| [use-cases/decision-ticket-optional](decision-ticket-optional.md) | optional | low | candidate |

## Code review

Constrained by `code-review`'s two-axis design. Read
[the prohibition](../patterns/wiring-into-skills.md#1.-do-not-rerank-across-review-axes) before
using any of these.

| Use case | Review | Risk | Status |
|---|---|---|---|
| [use-cases/review-finding-kind](review-finding-kind.md) | required | medium | candidate |
| [use-cases/review-worst-in-axis](review-worst-in-axis.md) | optional | low | candidate |
| [use-cases/review-smell-which](review-smell-which.md) | required | medium | candidate |
| [use-cases/review-finding-noop](review-finding-noop.md) | optional | medium | candidate |

## Debugging

`diagnosing-bugs` already sanctions autonomous ranking, which makes this the easiest
cluster to adopt.

| Use case | Review | Risk | Status |
|---|---|---|---|
| [use-cases/debug-red-signal-quality](debug-red-signal-quality.md) | optional | medium | candidate |
| [use-cases/debug-hypothesis-rank](debug-hypothesis-rank.md) | optional | medium | candidate |
| [use-cases/debug-seam-is-real](debug-seam-is-real.md) | optional | **high** | candidate |
| [use-cases/debug-is-real-bug](debug-is-real-bug.md) | optional | medium | candidate |

## Design and architecture

| Use case | Review | Risk | Status |
|---|---|---|---|
| [use-cases/prototype-branch](prototype-branch.md) | optional | low | candidate |
| [use-cases/deepening-candidate-rank](deepening-candidate-rank.md) | optional | low | candidate |
| [use-cases/skill-boundary-choice](skill-boundary-choice.md) | optional | low | candidate |
| [use-cases/glossary-drift](glossary-drift.md) | optional | low | candidate |

## Prose, docs and research

| Use case | Review | Risk | Status |
|---|---|---|---|
| [use-cases/prose-ai-pattern](prose-ai-pattern.md) | optional | low | candidate |
| [use-cases/doc-done-criteria-clear](doc-done-criteria-clear.md) | optional | medium | candidate |
| [use-cases/research-claim-primary-source](research-claim-primary-source.md) | optional | medium | candidate |

## Filters

The `human_review: none` cases, where a false positive is cheap and a false negative is
not. `untrusted-content-injection` is a content filter;
`checkpoint-route-explain` is free and factual.

| Use case | Review | Risk | Status |
|---|---|---|---|
| [use-cases/pre-push-secret-triage](pre-push-secret-triage.md) | optional | medium | **proven** |
| [use-cases/untrusted-content-injection](untrusted-content-injection.md) | none | **high** | **proven** |

## Meta

| Use case | Review | Risk | Status |
|---|---|---|---|
| [use-cases/wiki-usecase-rank](wiki-usecase-rank.md) | **required** | medium | **proven** |
| [use-cases/checkpoint-route-explain](checkpoint-route-explain.md) | none | low | **proven** |

## The five proven ones

These have measured numbers in their notes:

- **[use-cases/ticket-gate](ticket-gate.md)** — `ready` 0.8128, confidence 0.4438. Already written into
  `~/Projects/breath/AGENTS.md` rule 6.
- **[use-cases/pre-push-secret-triage](pre-push-secret-triage.md)** — ranks a diff; measured `precision@10` of 10/10
  0.13 on a clean one. Strongest signal in the wiki.
- **[use-cases/checkpoint-route-explain](checkpoint-route-explain.md)** — no forward pass, milliseconds, offline.

- **[use-cases/untrusted-content-injection](untrusted-content-injection.md)** — `prompt_injection` 1.0 on an injected
  bug report against 0.0095 on an ordinary one, with a measured imperative-docs near-miss
  at 0.0788 that shows where a threshold would start making noise.
- **[use-cases/wiki-usecase-rank](wiki-usecase-rank.md)** — the wiki searching itself, 34 labels, no
  shortlist. Correct on 2 of 3 situations, and the two *most confident* answers measured
  anywhere in this wiki were both wrong (0.9738, 0.9822). That is why it is
  `human_review: required`.

## Status vocabulary

| Status | Meaning |
|---|---|
| `proven` | Measured, with the numbers in the note. |
| `candidate` | Designed and payload written, not yet run against real data. |
| `rejected` | Tried and did not work, or argued out on principle. The reason is in the note under **Verdict**. |
| `reference` | Describes Laya rather than proposing a use for it. |

Twenty-nine of the thirty-four are `candidate`, and the notes do not pretend otherwise: a
payload written from a skill's own wording is a design, not a result. The five proven ones
are the two filters, ticket gating, routing, and the wiki's own self-search — chosen
because they are the ones cheap enough to actually run while writing the wiki.

## See also

- [patterns/wiring-into-skills](../patterns/wiring-into-skills.md) — which skill each one plugs into
- [index/schema](../index/schema.md) — the frontmatter contract
