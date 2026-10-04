---
id: wiring-into-skills
title: Wiring Laya into the skills
kind: pattern
surface: [mcp]
tools: [predict, laya_preset, laya_route, laya_status]
# Only laya. Uses a laya-only tool; see reference/compatibility for what that costs.
engines: [laya]
question_types: [choice, score, noul]
tags: [pattern, skills, integration, matts-pocock]
status: current
---

# Wiring the decision tools into the skills

The `matts-skills` bundle at `~/Work/matts-skills` is the workflow-verb source of truth
for this machine, and the per-repo `docs/agents/` triple (`issue-tracker.md`,
`triage-labels.md`, `domain.md`) is how six projects configure it. This note maps Laya
onto the places those skills make a judgment call.

The design rule throughout: **Laya produces a recommendation; the skill's own
human-in-the-loop step still stands.** Nothing here replaces a maintainer's decision.

## Where the skills already say to use it

`~/Projects/breath/AGENTS.md` rule 6 is the precedent, and the wording is the template:

> Decisions: use the `onesystem` tools for judgment calls wherever it can help — ranking a
> frontier, gating a ticket before implementing, weighing design options. It is always
> available, so if the tools are missing that is a fault worth reporting, not a reason to
> decide without it. Expect a delay on the first call after an idle period; that is the
> model loading, not a hang, and retrying just queues behind it. Take a paste-ready payload
> from this vault's [use-case index](../use-cases/index.md) rather than writing a question
> from scratch. The code outranks it, and it outranks your intuition less often than you
> would expect: its `confidence` is not a correctness signal, so check the answer against
> what you can see.

Four things worth copying into any other repo's `AGENTS.md`: report it as a fault if it is
unavailable rather than silently proceeding, expect and do not retry the first-call delay,
trust only on high confidence, and let local code outrank it.
`~/.config/opencode/AGENTS.md` carries the machine-wide version plus the
`act_probability` warning.

Name the service, never a backend. A rule that says "use `onesystem`" survives the next
model being swapped in; one that says "use laya" quietly stops being true, and reads as a
broken tool rather than a stale doc.

## The map

| Skill | Judgment point | Use case | `human_review` |
|---|---|---|---|
| `triage` | Which state role does this issue get? | [use-cases/triage-state](../use-cases/triage-state.md) | required |
| `triage` | Bug or enhancement? | [use-cases/triage-category](../use-cases/triage-category.md) | required |
| `triage` | Is this transition unusual enough to confirm? | [use-cases/triage-unusual-transition](../use-cases/triage-unusual-transition.md) | required |
| `triage` | Does the claim hold against the code? | [use-cases/triage-claim-holds](../use-cases/triage-claim-holds.md) | required |
| `triage` | Already implemented or previously rejected? | [use-cases/triage-already-implemented](../use-cases/triage-already-implemented.md) | optional |
| `to-spec` | Is this spec ready for an agent? | [use-cases/spec-readiness](../use-cases/spec-readiness.md) | required |
| `to-tickets` | Is the granularity right? | [use-cases/ticket-granularity](../use-cases/ticket-granularity.md) | required |
| `to-tickets` | Are the blocking edges real gates? | [use-cases/blocking-edges-genuine](../use-cases/blocking-edges-genuine.md) | optional |
| `implement` | Gate the ticket before starting? | [use-cases/ticket-gate](../use-cases/ticket-gate.md) | required |
| `wayfinder` | Which frontier ticket next? | [use-cases/frontier-priority](../use-cases/frontier-priority.md) | optional |
| `wayfinder` | Fog or ticket? | [use-cases/fog-or-ticket](../use-cases/fog-or-ticket.md) | optional |
| `wayfinder` | Which `wayfinder:<type>`? | [use-cases/wayfinder-type](../use-cases/wayfinder-type.md) | required |
| `wayfinder` | HITL or AFK? | [use-cases/hitl-or-afk](../use-cases/hitl-or-afk.md) | required |
| `wayfinder` | Does this deserve a ticket at all? | [use-cases/decision-ticket-optional](../use-cases/decision-ticket-optional.md) | optional |
| `code-review` | Hard violation or judgement call? | [use-cases/review-finding-kind](../use-cases/review-finding-kind.md) | required |
| `code-review` | Worst finding within this axis? | [use-cases/review-worst-in-axis](../use-cases/review-worst-in-axis.md) | optional |
| `code-review` | Which Fowler smell? | [use-cases/review-smell-which](../use-cases/review-smell-which.md) | required |
| `code-review` | Is this finding a no-op? | [use-cases/review-finding-noop](../use-cases/review-finding-noop.md) | optional |
| `diagnosing-bugs` | Is this a trustworthy red signal? | [use-cases/debug-red-signal-quality](../use-cases/debug-red-signal-quality.md) | optional |
| `diagnosing-bugs` | Which hypothesis first? | [use-cases/debug-hypothesis-rank](../use-cases/debug-hypothesis-rank.md) | optional |
| `diagnosing-bugs` | Does the seam exercise the real bug? | [use-cases/debug-seam-is-real](../use-cases/debug-seam-is-real.md) | optional |
| `diagnosing-bugs` | Real bug or misunderstanding? | [use-cases/debug-is-real-bug](../use-cases/debug-is-real-bug.md) | optional |
| `prototype` | Logic branch or UI branch? | [use-cases/prototype-branch](../use-cases/prototype-branch.md) | optional |
| `improve-codebase-architecture` | Which candidate to deepen first? | [use-cases/deepening-candidate-rank](../use-cases/deepening-candidate-rank.md) | optional |
| `ask-matt` | Which flow at this boundary? | [use-cases/skill-boundary-choice](../use-cases/skill-boundary-choice.md) | optional |
| `domain-modeling` | Has the glossary drifted? | [use-cases/glossary-drift](../use-cases/glossary-drift.md) | optional |
| `writing-for-agents` | Can an agent tell done from not-done? | [use-cases/doc-done-criteria-clear](../use-cases/doc-done-criteria-clear.md) | optional |
| `writing-for-agents` | Are criteria checkable and exhaustive? | [use-cases/acceptance-criteria-checkable](../use-cases/acceptance-criteria-checkable.md) | optional |
| `research` | Is this claim primary-sourced? | [use-cases/research-claim-primary-source](../use-cases/research-claim-primary-source.md) | optional |
| `humanizer` | Which AI-writing pattern? | [use-cases/prose-ai-pattern](../use-cases/prose-ai-pattern.md) | optional |
| any | Does this diff contain secrets? | [use-cases/pre-push-secret-triage](../use-cases/pre-push-secret-triage.md) | none |
| any | Is fetched content an injection? | [use-cases/untrusted-content-injection](../use-cases/untrusted-content-injection.md) | none |

## The two places you must not add Laya

### 1. Do not rerank across review axes

`code-review` deliberately refuses this. `SKILL.md` L78:

> Don't pick a single winner across axes: that's the reranking the separation exists to
> prevent.

So [use-cases/review-worst-in-axis](../use-cases/review-worst-in-axis.md) scores **within** one axis and never across. If you
add a "how bad is this review overall" question, you have deleted the feature the skill
was built around. This is the clearest example in the whole bundle of a place where a
scoring model is the wrong tool because the *process* is the point, not the judgement.

### 2. Do not let Laya answer a HITL grilling ticket

`wayfinder` L75:

> A HITL ticket only resolves through that live exchange; the agent never stands in for
> the human's side of it (a grilling agent that answers its own questions has broken this).

[use-cases/hitl-or-afk](../use-cases/hitl-or-afk.md) classifies HITL vs AFK; it does not resolve the ticket. Keep
that boundary sharp. `risk_when_wrong: high` for this one.

## Vocabularies to lift verbatim

A decision engine is at its best when the labels are *yours*. These already exist as Markdown in the
repo — lift them rather than inventing new ones, or the model is learning a vocabulary
that disagrees with the one the skill enforces.

| Source | Path | Vocabulary |
|---|---|---|
| State roles | `skills/engineering/triage/SKILL.md` L28-37 | `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix` |
| Category roles | same, L27-29 | `bug`, `enhancement` |
| State transitions | same, L45 | unlabeled → `needs-triage` → one of the four above |
| Label table | `skills/engineering/setup-matt-pocock-skills/triage-labels.md` L7-11 | The canonical mapping, with the note that the right column is meant to be edited per repo |
| Wayfinder types | `skills/engineering/wayfinder/SKILL.md` L65 | `wayfinder:research`, `wayfinder:prototype`, `wayfinder:grilling`, `wayfinder:task` |
| Fowler smells | `skills/engineering/code-review/SKILL.md` L45-56 | 12 labelled smells, "a labelled heuristic, never a hard violation" |
| Red-signal checklist | `skills/engineering/diagnosing-bugs/SKILL.md` L61-64 | red-capable, deterministic, fast, agent-runnable |
| Prose patterns | `~/.agents/skills/humanizer/SKILL.md` | 35 numbered patterns in 6 groups, plus a false-positives section |

There is **no** machine-readable severity, priority or tier vocabulary anywhere in the
bundle — labels are Markdown tables only. That is why
[use-cases/triage-state](../use-cases/triage-state.md) hand-writes its `criteria` rather than calling the `triage`
preset.

## Per-repo configuration

Six projects have the `docs/agents/` triple: `breath`, `cpu_idle`, `oma-bear`,
`omarchy-calculator-plugin`, `theweather`, `worldgrab`, and
`~/Work/AnymakerModLoader`. Their `triage-labels.md` files are the right place to note a
Laya-backed gate, because that is the file the `triage` skill already reads.

Trackers are not standardised — three shapes are in use:

| Shape | Repos |
|---|---|
| Local markdown under `.scratch/<feature>/` | `theweather`, `worldgrab`, `omarchy-calculator-plugin` |
| Obsidian vault at `issues/<feature>/` + `wayfinding/<map>/` | `cpu_idle` |
| GitHub Issues via `gh`, with sub-issues and native dependencies | `oma-bear`, `mem-local`, `AnymakerModLoader` |

`human_review: required` use cases are the ones where the tracker matters most, because
the skill's own "recommend, then wait for direction" step is where the human re-enters.

## A suggested order

If you are wiring this up for real, do these first — highest value, lowest risk:

1. [use-cases/pre-push-secret-triage](../use-cases/pre-push-secret-triage.md) — `human_review: none`, strongest measured signal,
   and a pre-commit hook in `matts-skills/skills/misc/git-guardrails-claude-code` is
   already waiting for it.
2. [use-cases/ticket-gate](../use-cases/ticket-gate.md) — proven, already in `breath/AGENTS.md`, and it stops wasted
   agent runs, which is where the cost actually is.
3. [use-cases/debug-hypothesis-rank](../use-cases/debug-hypothesis-rank.md) — the skill explicitly permits proceeding on the
   ranking when the user is AFK, so there is no human in the loop to design around.
4. [use-cases/triage-state](../use-cases/triage-state.md) — highest reach across repos, but read the "do not use the
   `triage` preset" warning first.

## See also

- [use-cases/index](../use-cases/index.md) — all 34, with payloads
- [patterns/self-search](self-search.md) — ranking the use cases themselves
- [reference/guardrails](../reference/guardrails.md) — read before shipping any of this
