---
id: pre-push-secret-guard
title: Pre-push secret guard
kind: use-case
surface: [mcp]
tools: [laya_preset, predict]
# Only laya. Uses a laya-only tool; see reference/compatibility for what that costs.
engines: [laya]
question_types: [noul, score]
status: proven
human_review: none
risk_when_wrong: high
skills: [git-guardrails-claude-code, code-review]
trigger: "A diff is about to be pushed. Block on the guard preset's sensitive_data above 0.5; never push .env contents or db files past it."
tags: [use-case, pre]
---

# Pre-push secret guard

The one use case in this wiki with `human_review: none` and a strong measured signal. It is
also already a standing instruction in `~/.config/opencode/AGENTS.md`: *"run the `guard`
preset over agent diffs before every push. Block on `sensitive_data` noul > 0.5 (0.79
measured on a secret diff vs ~0.14 on clean code)."*

## The preset, as shipped

```json
{
  "preset": "guard",
  "state": {
    "prompt": "<the diff or staged content, as text>"
  }
}
```

Returns `jailbreak`, `prompt_injection`, `sensitive_data`, `harm_severity`, `topic`.

## Measured

Independently reproduced on this machine, using the `guard` preset as shipped:

| Input | `sensitive_data` |
|---|---|
| A diff adding `DB_PASSWORD = "hunter2-..."` and an API key | **0.569** |
| A clean diff adding a `parse_header` byte-parsing function | **0.0023** |

Separation of **0.567** across a ~250x ratio. This is the strongest signal measured
anywhere in this wiki, and it reproduces the 0.79-vs-0.13 figures already recorded in
`~/.config/opencode/AGENTS.md` — the absolute numbers move with how blatant the secret is,
the separation does not.

## A sharper custom version

The preset is generic. A version tuned to your conventions is much better, because it knows
what *your* secrets look like:

```json
{
  "state": {
    "diff": "<staged diff>",
    "repo": "mem-local"
  },
  "questions": {
    "sensitive_data": {
      "type": "noul",
      "instructions": "Does this diff contain a credential, token, private key, connection string, or personal data that must not be committed?"
    },
    "looks_like_our_secret": {
      "type": "noul",
      "instructions": "Does this contain a string that looks like one of this project's real secrets, such as an LLM API key, a database URL, or a session secret?"
    },
    "is_example_placeholder": {
      "type": "noul",
      "instructions": "Is the only sensitive-looking content an obvious placeholder, such as 'your-key-here', 'xxx', or a documented example value?"
    },
    "severity": {
      "type": "score",
      "instructions": "How much harm would committing this cause?",
      "criteria": [
        "none: no sensitive content",
        "minor: an internal hostname or path",
        "serious: a credential that could be used",
        "severe: a live production credential or personal data"
      ]
    }
  }
}
```

## Caveats

- **`is_example_placeholder` is what makes this usable.** Placeholders trip every naive
  secret scanner and account for most false positives. Asking about them explicitly is the
  difference between a guard that gets respected and one that gets bypassed after the third
  false alarm.
- **Never push `.env` contents or database files past this, whatever the number says.**
  A classifier is a filter, not a control. The rule is a rule.
- The misconfiguration half: `presets.py` has a real bug —
  `guard_questions()` gives `topic` a `criteria` dict whose values are all `None`.
  `validate_questions` stringifies them, so every topic label becomes the description
  `"None"`. `topic` is therefore useless from the preset. Write your own or drop it.
- `matts-skills/skills/misc/git-guardrails-claude-code` already has hooks for push, reset
  and clean. This is the natural payload for them.

## See also

[use-cases/untrusted-content-injection](untrusted-content-injection.md) · [reference/mcp-tools](../reference/mcp-tools.md) ·
[reference/guardrails](../reference/guardrails.md)
