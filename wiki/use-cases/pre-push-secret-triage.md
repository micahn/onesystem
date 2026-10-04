---
id: pre-push-secret-triage
title: Triage a diff for credentials before pushing
kind: use-case
surface: [mcp, http, cli]
tools: [predict]
# Portable. One noul question, no engine-specific tool.
engines: [laya, rizzo]
question_types: [noul]
status: proven
human_review: optional
risk_when_wrong: medium
trigger: "A diff is about to be pushed and you want to know which files to read first. This RANKS; it does not block -- see the caveat, it is the whole point of this note."
tags: [use-case, security, pre-push, triage]
---

# Triage a diff for credentials before pushing

**This ranks. It does not block, and you should not make it block.** The measurement
below is why, and it is the reason this note exists rather than a note telling you to set a
threshold.

## The question

One `noul` per file. The text under judgement is the `state`.

```json
{
  "state": { "text": "<the file's contents>" },
  "questions": {
    "exfiltration": {
      "type": "noul",
      "instructions": "If this file were published, could a stranger use something in it to get into a system that is not theirs?",
      "criteria": {
        "false": "No. Nothing here grants access. A .env.example with placeholder values, a public key block, a password hash, a commit hash, a UUID, a test card number, and prose about rotating credentials are all no.",
        "true": "Yes. Something here is a working password, token, API key, connection string with a password, or private key."
      }
    }
  }
}
```

The two criteria are the whole tuning, and they were arrived at by measurement rather than by
rewording until it felt right — see below for why that distinction matters.

## Measured, on 34 labelled files

16 containing real (fake but structurally genuine) credentials, 18 clean and chosen to be
hard: commit hashes the length of AWS secret keys, a PEM **public** key framed exactly like a
private one, RFC 2606 addresses, a published Stripe test card, an argon2 hash, base64 SVG,
and fake credentials inside tests.

| | v0 baseline | v3 tuned |
|---|---|---|
| secrets, mean score | 0.931 | 0.959 |
| clean, mean score | 0.191 | 0.334 |
| **top 10 by score that are real secrets** | — | **10 / 10** |
| worst clean file | 0.836 | 0.972 (`.env.example`) |
| weakest real secret | 0.629 | 0.780 |
| ranges overlap? | **yes** | **yes** |

**Precision at 10 is perfect. Classification is impossible.** There is no threshold that
separates them: at 0.7 the tuned wording catches all 16 secrets and also blocks
`.env.example`; raise it enough to stop blocking `.env.example` and you start missing an AWS
key pair.

### Rewording does not fix this, and that is the finding

Four question variants were measured, differing only in how the two criteria were phrased:

| variant | worst clean | weakest secret | separated? |
|---|---|---|---|
| v0 baseline | 0.836 | 0.629 | no |
| v1 "works, not looks" | 0.887 | 0.486 | no |
| v2 framed as consequence | 0.963 | 0.529 | no |
| v3 v2 + `.env.example` named | 0.972 | 0.780 | no |

Naming `.env.example` explicitly made it **worse** — 0.836 to 0.972 — which is the kind of
result that is worth having measured rather than argued about. Mentioning the pattern primes
it.

The reason is not that the model is weak. It is that `.env.example` genuinely *does* contain
credential-shaped text, and the difference between that and a working credential is not
recoverable from the bytes of the file. A `.env.example` with `SECRET_KEY=change-me` and a
`.env` with a real key are near-identical to anything reading them.

## So what this is for

**Ranking.** Sorted by score, the ten most suspicious files were ten real secrets. That is
good enough to decide where a human looks first in a 400-file diff, which is the job a guard
has before the scanner runs.

**Not blocking.** A guard that blocks `.env.example` on every push is a guard that gets
`--no-verify`'d within a week, and then it protects nothing at all.

## The block belongs to a deterministic scanner

A regex- or entropy-based scanner decides; the model ranks what the scanner missed and what
it flagged. `gitleaks` is the obvious candidate on Arch — a single static binary in `extra`,
no runtime, and it is what this corpus was built to be the hard case for.

The model's remaining value is the half a scanner is bad at: a password in a URL, a secret
assigned to an ordinary-looking variable, a webhook URL. Those have no fixed shape, and
`sensitive_data > 0.5` on the wrong file is cheaper than a leaked credential.

## Reproduce it

```bash
bun run ~/Work/ab/src/guard-variants.ts     # the four variants and the table above
bun run ~/Work/ab/src/guard.ts              # the threshold sweep for one question
python3 ~/Work/ab/src/build-guard-corpus.py # regenerate the corpus
```

The corpus is safe to commit: every credential in it is AWS's documented example key, Stripe's
published test key, or an RFC 5737/2606 reserved value. That property is the one the guard is
supposed to have and the corpus is the demonstration of it.

## Caveats

- **Measured on rizzo only.** The other two engines were not available to compare, so the
  table has no rows for them. The question is portable; the numbers are not, and the
  separate finding that neither laya nor julia can gate on confidence at all is reason to
  expect neither would be the blocker here either.
- **`noul` has no declared polarity.** Read as P(true), which is supported by julia's explicit
  `probabilities` map agreeing with its scalar in both directions. If that inference is wrong,
  every number in this note inverts.
- **34 files is small.** Enough to show the ranges overlap; not enough to characterise a
  model's behaviour on a codebase.

## See also

[MCP tools](../reference/mcp-tools.md) · [Answer payload](../reference/answer-payload.md) ·
[Guardrails](../reference/guardrails.md) · [the measured comparison](https://micahn.github.io/onesystem-ab/)
