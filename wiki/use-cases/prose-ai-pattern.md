---
id: prose-ai-pattern
title: Which AI-writing pattern
kind: use-case
surface: [mcp]
tools: [predict]
# Portable as written: an object state. julia needs it flattened to a string.
engines: [laya, rizzo]
question_types: [choice, score]
status: candidate
human_review: optional
risk_when_wrong: low
skills: [humanizer, writing-for-agents]
trigger: "A line of prose needs to be checked against the thirty-five-item AI-writing pattern vocabulary, with false positives suppressed."
tags: [use-case, prose]
---

# Which AI-writing pattern

`humanizer` (at `~/.agents/skills/humanizer/`, v2.11.2) carries a **35-item numbered pattern
vocabulary** in six groups — Content 1-6, Language 7-13, Style 14-19, Chatbot 20-22,
Filler/hedging 23-35 — plus a "Check for false positives / What not to flag" section.

That is a purpose-built classification problem, and the false-positives section is the part
that makes it usable: without a negative class, every line matches something.

## Payload

Ask per line, not per document — the patterns are line-level:

```json
{
  "state": {
    "line": "This comprehensive solution leverages cutting-edge methodologies to robustly address the challenge.",
    "surrounding_paragraph": "Sales has been up 40% this quarter, which is the best result we have had since 2023."
  },
  "questions": {
    "is_ai_pattern": {
      "type": "noul",
      "instructions": "Does this line hit a known AI-writing pattern rather than reading like the writer's own voice?"
    },
    "group": {
      "type": "choice",
      "instructions": "Which group of AI-writing patterns does this line most clearly exhibit?",
      "criteria": {
        "content": "inflated claims, vague sourcing, unnecessary superlatives, meaningless quantifiers",
        "language": "overused stock vocabulary, formulaic phrasing, hedging",
        "style": "uniform paragraph rhythm, bullet-everything, mechanical transitions",
        "chatbot": "assistant mannerisms: 'I'd be happy to', 'Let me know if', restating the request",
        "filler": "throat-clearing, redundant framing, empty connective tissue",
        "none": "this line is fine as written"
      }
    },
    "keeps_claim": {
      "type": "noul",
      "instructions": "Would rewriting this line preserve every claim it currently makes, without inventing anything new?"
    }
  }
}
```

## Caveats

- **`none` is a required label.** The skill's own false-positive section exists because
  these patterns over-fire. A six-label question with a real `none` beats a five-label
  question that must pick.
- **Six groups, not 35 patterns.** Thirty-five labels is unreadable and
  past the point where the model can hold the distinctions. Ask the group first; only go
  finer if you actually need per-pattern attribution, and then split into batches.
- `keeps_claim` is the constraint the skill leads with — *"keep every claim, invent no
  facts"*. A line that trips a pattern but carries real information should be rewritten
  carefully, not deleted.
- A user-supplied sample outranks the style rules. If you have one, put it in `state`.

## See also

[use-cases/doc-done-criteria-clear](doc-done-criteria-clear.md) · [patterns/wiring-into-skills](../patterns/wiring-into-skills.md)
