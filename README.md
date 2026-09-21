# pi-jev-effort

Sets the thinking level of a [pi](https://pi.dev) session for every prompt, from a
[TypeSafe Jev](https://typesafe.ai) judgement of how hard the prompt actually is — and caps it
by how much of your quota is left.

```
jev ▁▁█▁ medium · 57% · resets 2h11m
```

The four blocks are Jev's probability for each rung of the rubric — trivial, routine,
substantial, hard — so a split answer is visible rather than averaged away.

Jev is a System One model: it answers a typed question with a distribution instead of prose, so
one call returns a score on your rubric plus the confidence behind it. A judgement takes about
250ms and costs about $0.000015, and Jev bills input only.

## Why an extension and not a hook

Pi's command hooks can read the thinking level but not write it. `setThinkingLevel` exists only on
the extension API, so the decision has to live inside pi's process. The same is true elsewhere:
Claude Code hooks read `$CLAUDE_EFFORT` but cannot set it (that needs a Mod), and Codex hook output
has no field that changes session settings at all.

## Install

```sh
pi install npm:pi-jev-effort
```

Or work on it in place, which keeps `/reload` working:

```sh
git clone https://github.com/namenu/pi-jev-effort ~/src/pi-jev-effort
ln -s ~/src/pi-jev-effort ~/.pi/agent/extensions/jev-effort
```

Then give it a key. Either works, and `auto` prefers the first it finds:

| Transport | Key | Endpoint |
|---|---|---|
| TypeSafe direct | `TYPESAFE_API_KEY`, or `apiKey` in `~/.jev/config.json` | `POST https://api.typesafe.ai/v1/systemone` |
| OpenRouter | the OpenRouter login pi already holds — nothing to set | `POST https://openrouter.ai/api/alpha/decisions` |

The OpenRouter path needs no configuration: the extension asks pi for the key with
`modelRegistry.getApiKeyForProvider("openrouter")` and re-resolves it every turn, so a refreshed
OAuth token keeps working. If your OpenRouter workspace filters providers, allow **TypeSafe** under
Guardrails first, or every call comes back `404 provider-not-allowed-by-guardrail`.

There are no npm dependencies. Both transports take the same body and return the same answer shape.

## How a level gets chosen

**1. Jev answers one scored question** about the prompt, against a four-level rubric — trivial,
routine, substantial, hard — and returns a probability for each rung. Measured against
`~typesafe/jev-latest` (resolved as `typesafe/jev-1.13-20260917`), about 250ms per call:

| Prompt | Distribution | Reads as |
|---|---|---|
| `안녕` / `show me the files in this directory` | `1.00 / 0 / 0 / 0` | certainly trivial |
| `fix the typo in the README` | `0.93 / 0.07 / 0 / 0` | trivial |
| `refactor this` | `0.07 / 0.07 / 0.80 / 0.06` | substantial |
| `fix this` | `0.47 / 0.09 / 0.43 / 0.01` | could be either, and says so |

**2. Cumulative mass decides whether to move**, not the average. The scale is ordinal, so the
question is how much of the answer sits at or beyond a level: move up to the highest level that
`P(score ≥ level) ≥ 0.3` reaches, or down to the lowest that `P(score ≤ level) ≥ 0.6` covers.
Upgrades clear a lower bar because thinking too much costs tokens while thinking too little costs
the answer.

The last row is why the average is the wrong summary. Its mean is 0.96 with a reported confidence
of 0.04 — round that and you land on a rung nothing voted for, at a confidence no threshold will
ever pass, and the level sticks wherever it happens to be. On cumulative mass the same answer moves
a session down from `high` to `medium` (`P(≤2) = 0.99`) and leaves it there, which is what a
genuinely ambiguous prompt deserves.

**3. The budget caps the result.** A ceiling from quota pressure is a hard cap, not an opinion — it
applies whether or not the distribution could move anything.

Every prompt is judged, including one-word ones. A greeting is the easiest call Jev makes, and a
short follow-up like "continue" is sent with the previous reply and the tools that ran, so it is
judged against the work it continues rather than on its own two words.

## Budget, burn rate and reset

The same places `ccusage` and CodexBar look: the transcripts the agent already writes, plus whatever
the provider volunteers about its own limits.

| Source | Where it comes from | Gives |
|---|---|---|
| `headers` | rate-limit headers captured in `after_provider_response` | remaining fraction, reset time |
| `openrouter` | `GET /api/v1/credits` | remaining fraction of purchased credits (no reset) |
| `local` | `~/.pi/agent/sessions/**/*.jsonl`, which record `usage.cost` per message | spend in the window against `limitUsd`, reset at the window edge |

`auto` tries them in that order. The **burn rate is always local**: the extension sums the cost of
assistant messages inside a rolling window and divides by the span, re-reading a transcript only
when its size changed. Windows sit on a UTC grid, the way ccusage treats Claude's 5-hour blocks, so
the reset time is the edge of the current block.

Pressure lowers the ceiling as the quota drains, and a burn rate that would empty the window before
it resets counts as one threshold worse:

```json
"pressure": [
  { "remainingBelow": 0.3, "ceiling": "medium" },
  { "remainingBelow": 0.1, "ceiling": "low" }
]
```

The footer carries it: `jev ▁▂█▁ medium · 57% · resets 2h11m`. A `~` before the level — 
`jev ▄▂▄▁ ~medium` — means the distribution leans somewhere else but did not clear its threshold,
so the level is being held rather than chosen.

## Command

```
/jev-effort           # full readout: distribution, level, budget, burn, reset
/jev-effort last      # the last ten judgements, one sparkline each
/jev-effort on        # enable, and clear a manual pause
/jev-effort off       # disable for this session
```

```
jev-effort on · via openrouter · level medium
last: "make it cleaner" → medium → medium
  0 trivial     minimal ███·······  0.34
  1 routine     low     ██········  0.20
  2 substantial medium  █████·····  0.46
  3 hard        high    ··········  0.00
  score 1.13 · confidence 0.12 · P(≤2)=1.00
budget openrouter 57% · 1,203,164 tok / $0.031 in 5h · $0.00046/min
```

Change the level yourself with `/effort` or `Ctrl+Shift+E` and automatic routing pauses for the
session — your hands beat the model's judgement. A level change caused by switching models does not
count as manual, so clamping to a model's capabilities will not pause anything.

## Configuration

Optional, at `~/.pi/agent/jev-effort.json`. Defaults:

```json
{
  "enabled": true,
  "provider": "auto",
  "apiKey": null,
  "baseUrl": null,
  "model": null,
  "timeoutMs": 4000,
  "levels": ["minimal", "low", "medium", "high"],
  "minUpgradeConfidence": 0.3,
  "minDowngradeConfidence": 0.6,
  "floor": null,
  "ceiling": null,
  "minPromptChars": 0,
  "budget": {
    "source": "auto",
    "windowHours": 5,
    "limitUsd": null,
    "pressure": [
      { "remainingBelow": 0.3, "ceiling": "medium" },
      { "remainingBelow": 0.1, "ceiling": "low" }
    ],
    "refreshMs": 60000
  },
  "notify": false,
  "debug": false
}
```

`levels` maps rubric rungs 0–3 onto pi thinking levels, so a model with `xhigh` and `max` can use
them: `["low", "medium", "high", "max"]`. `minUpgradeConfidence` and `minDowngradeConfidence` are
shares of the distribution, not Jev's reported confidence. `floor` and `ceiling` clamp every result,
and `minPromptChars` above 0 brings back a length guard if you want one. `JEV_EFFORT_DEBUG=1` prints
one line per judgement to stderr:

```
[jev-effort] ▁▁█▁ score=2.02 conf=0.85 P(<=3)=1.00 P(>=3)=0.09 budget=openrouter:57% ceiling=none medium -> medium
```

Pi clamps whatever it is given to what the model supports, so `minimal` can land as `low`. That is
pi, not this extension, and the status line shows what actually took effect.

## Failure is always open

No key, a timeout, an HTTP error, a guardrail rejection or a malformed answer leaves the level
untouched and the turn running. A judgement layer that can cost you a turn is worse than no
judgement layer.

## Development

```sh
node --test
```

The tests cover the cumulative-mass rule against real distributions, the hard cap, the wire contract
of both transports with `fetch` mocked, transcript parsing and burn rate, rate-limit header shapes,
and the UTC window grid. For an
end-to-end check, point `baseUrl` at a local server that answers

```json
{ "answers": { "effort": { "type": "score", "score": 0, "confidence": 0.85 } } }
```

and run `JEV_EFFORT_DEBUG=1 pi -p "<a prompt of at least 12 characters>"`.

## License

MIT
