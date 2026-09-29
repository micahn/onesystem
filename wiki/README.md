# onesystem wiki

Documentation for [onesystem](../README.md) — a local service that runs **decision
engines** behind one payload — and, more usefully, **where they fit in real agent
workflows**.

An engine answers typed questions (`choice` / `score` / `noul`) over any state in a single
pass, with probabilities and no text generation. The interesting problems in an agent
workflow are not "write the answer" problems, they are "which of these five things is true"
problems. This vault is organised around those.

Open `Home.md` in Obsidian, or start there in any Markdown reader. The links are ordinary
relative Markdown links, so they work on GitHub as well as in Obsidian.

## What this is, and what it deliberately is not

This documents **onesystem**: the service, the payload contract, the requirements a model
has to meet, and the decision points in a workflow where an engine earns its place.

It does **not** document the three models. They change on their own schedules, and a
paraphrase of their APIs in here would be wrong within a release. Where a model's own
detail matters, this wiki links to its authors:
[laya](https://huggingface.co/convaiinnovations/laya) ·
[julia](https://huggingface.co/SupersonicLabs/Julia-1) ·
[rizzo](https://github.com/Rizzo-AI-Academy/rizzo-flow).

## Layout

```
Home.md                  entry point / MOC
glossary.md              terms, and whose definition owns each one
index/
  schema.md              the frontmatter contract every note follows
  usecases.json          the machine-readable index an engine reads to search this wiki
reference/
  compatibility.md       what a model must provide — the measured matrix, the contract
  models.md              the three models, and where each documents itself
  mcp-tools.md           the tools, the naming rule, MCP and the HTTP front door
  answer-payload.md      every response field, and the four ways the engines disagree
  guardrails.md          when not to trust it, and the confidence doctrine
  backends.md            transports, config blocks, adding a model
  cli.md                 the onesystem command
use-cases/
  index.md               all 34, grouped by where they fire
  <id>.md                one note per use case, with a paste-ready payload
patterns/
  choosing-an-engine.md  the decision: which engine, and why not to average them
  multi-question-batches.md   one forward pass, many questions
  self-search.md              an engine ranking this wiki against a live situation
  wiring-into-skills.md       the map onto workflow skills
scripts/
  validate.py            structural checks: the index parses, frontmatter agrees with it,
                         every link resolves
  verify-claims.py       checks the wiki's factual claims against a running onesystem
  migrate.py             the one-shot laya-wiki → onesystem migration, kept for the record
  relativise-links.py    wikilinks → relative Markdown links, so GitHub can render them
```

## Start with the contract

Three engines are installed and they are **not** drop-in replacements. Two things break a
port, both at the type checker rather than at the answer:

- `state` is an object for laya, a string for julia, and either for rizzo.
- the registered tool name depends on how many engines you have enabled.

And one thing breaks it *quietly*, which is worse: the engines disagree about their own
answer format. `noul` declares no polarity, confidence is named three different ways, and
laya returns two different confidence numbers in the same object. A reader that parses all
three with one function silently mis-scores two of them.

[What a model has to provide](reference/compatibility.md) is that page, measured rather
than asserted.

## Two audiences, one format

Prose is for humans; `index/usecases.json` is for whichever engine is active. The rule that
keeps them honest:

> **Prose may elaborate, never contradict.**

Anything a decision depends on lives in the frontmatter or the index. Anything that only
matters to a reader lives in the body.

The index's `criteria` block is drop-in valid as a `choice` question's criteria, so an
engine can rank these use cases against a live situation with no adapter:

```python
import json, httpx

criteria = json.load(open("index/usecases.json"))["criteria"]

r = httpx.post("http://127.0.0.1:7331/call", json={
    "backend": "rizzo", "tool": "predict",
    "arguments": {
        # rizzo is the only engine that takes an object here, and it is the only one whose
        # confidence is worth reading afterwards.
        "state": {"situation": "an unlabeled issue with a repro snippet, about to be handed to an agent"},
        "questions": {"applies": {
            "type": "choice",
            "instructions": "Which documented use case applies to this situation?",
            "criteria": criteria,
        }},
    },
}, timeout=120)

answers = json.loads(r.json()["result"]["content"][0]["text"])["answers"]["applies"]
print(answers["choice"], answers["confidence"])   # read the distribution, and check the winner
```

Two things to carry away. The `state` is short and focused on purpose — padding it
measurably degrades the answer. And the winner is checked by whoever receives it, because a
confidence is only worth reading on some engines. See
[self-search](patterns/self-search.md).

## What is measured and what is not

5 use cases are `proven`, with numbers in their notes. 29 are `candidate` — payload
written, not yet run against real data. The wiki does not blur that line.

Everything marked measured was measured on this machine: onesystem with laya 0.3.21, julia
0.1.0 and rizzo-flow 4b q8, on an AMD RX 9070 XT with rizzo on Vulkan. The headline
comparison across 100 cases is published separately:
**[the A/B/C writeup](https://micahn.github.io/onesystem-ab/)**.

Findings that overturned an earlier draft of this wiki are kept in, because a wiki that
only records its successes is not worth maintaining:

- **Confidence is a gate — on rizzo, and not on the other two.** The previous version of
  this page said it was not a gate at all, on the strength of laya alone. Measured: rizzo's
  high-confidence band is 52/52 correct, laya's is 56% against a 46% base rate, julia's is
  54% against 50% with 26 wrong answers reported above `0.90`.
- **Do not average them.** rizzo alone 86.4%, three-model majority 65.9%, and the ceiling
  for any router is 93.2% — three cases of headroom.
- **laya and julia are not independent.** On 9 of 44 cases they agreed with each other
  against ground truth while rizzo was right, and both under-assert on `noul`.
- **`state` quality dominates everything.** The same situation described two ways scored
  `0.9644` and `0.3059`; the verbose one got it wrong.
- **34 labels is fine.** A documented temperature clamp was blamed for a bad result that a
  bad `state` actually caused.
- **Following the official shortlist advice made things worse** — 2224 ms instead of
  30.7 ms, with the correct answer dropped.

## Validation

```bash
python3 scripts/validate.py      # structure
onesystem start
python3 scripts/verify-claims.py  # facts
```

`validate.py` checks that the index parses, that every `criteria` key has a record and a note and every
record has a note, that frontmatter agrees with the index, that `count` matches, and that
every relative Markdown link resolves. It cannot check whether a gloss is still *true* —
that is a human job.

`verify-claims.py` covers the part that *is* mechanical: it asks a running onesystem
whether laya still refuses a string `state`, whether julia still refuses an object, whether
a refusal still comes back as `isError` with a plain-text message rather than a JSON-RPC
error, and whether `act_probability` is still the constant `1.0` the guardrails page says
it is. Documentation of a contract drifts quietly; this is what stops it.

## Adding a use case

1. Add the entry to `index/usecases.json` — both the `criteria` one-liner (this is the
   ranking surface, so write it for a reader who has never seen the note) and the full
   `use_cases` record.
2. Create `use-cases/<id>.md` with the frontmatter from [the schema](index/schema.md),
   including the `engines` field, which is what keeps a laya-only pattern from being read
   as a portable one.
3. Link it from [use-cases/index.md](use-cases/index.md) and, if it plugs into a skill, from
   [wiring-into-skills.md](patterns/wiring-into-skills.md).
4. Run the payload once. Write down what actually came back. Flip `status` to `proven`, or to
   `rejected` with the reason.

`rejected` is a first-class status. The only durable signal against a plausible-looking
answer is a record of what was measured.
