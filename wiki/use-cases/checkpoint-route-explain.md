---
id: checkpoint-route-explain
title: Explain checkpoint routing
kind: use-case
surface: [mcp]
tools: [laya_route, laya_status]
# Only laya. Uses a laya-only tool; see reference/compatibility for what that costs.
engines: [laya]
question_types: [noul]
status: proven
human_review: none
risk_when_wrong: low
trigger: "Explaining to a user why a given request went to the english or multilingual checkpoint. No forward pass, so it is free and safe to call first."
tags: [use-case, checkpoint]
---

# Explain checkpoint routing

``laya_route`` runs **no forward pass**. It is pure Python routing logic, so it is
milliseconds, needs no checkpoint, and works with the network unplugged. That makes it the
cheapest thing in the toolkit and the easiest to call speculatively.

## Payload

```json
{ "state": { "text": "আমি একুটু ভুল পরিবর্তন চাই" }, "questions": { "q": { "type": "noul", "instructions": "irrelevant, but required" } } }
```

## Measured, via the CLI

```console
$ laya "আমি একুটু ভুল পরিবর্তন চাই"
Model     : multilingual
Reason    : non-Latin script (bengali, 100% of letters); the English checkpoint cannot read it
Detected  : {"script": "bengali", "script_profile": {"bengali": 1.0}, "language": null,
             "is_english": false, "language_undecided": true, "diacritic_rate": 0.0,
             "non_latin_fraction": 1.0}
```

```console
$ laya "add a --json flag to the CLI"
Model     : english
Reason    : English Latin text
```

## Caveats

- **`questions` is required even though it is unused.** ``laya_route`` validates the
  question set because the typed-decisions workflow matcher reads it. A minimal
  `{q: {type: "noul", instructions: "..."}}` satisfies it.
- **The `reason` string is genuinely explanatory** — *"the English checkpoint cannot read
  it"* is a sentence you can show a user. This is the best use of the tool: explaining
  routing decisions, not making them.
- `is_english: false` with `language: null` and `language_undecided: true` is the router
  correctly saying "I know the script, I am not going to guess the language". For
  non-Latin scripts the model does not need the language id — it needs to not be the
  English checkpoint.
- Plain-ASCII Spanish, Italian, Portuguese and French, and CJK text containing Latin brand
  names, now reach the multilingual checkpoint correctly. If you expected english and got
  multilingual, that is a fix, not a bug.

## See also

[reference/mcp-tools](../reference/mcp-tools.md) · [reference/cli](../reference/cli.md) · [use-cases/wiki-usecase-rank](wiki-usecase-rank.md)
