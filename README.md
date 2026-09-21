# pi-jev-effort

Sets the thinking level of a [pi](https://pi.dev) session for every prompt, from a
[TypeSafe Jev](https://typesafe.ai) judgement of how hard the prompt actually is — and caps it
by how much of your quota is left.

```
[jev-effort] score=0.00 conf=1.00 budget=openrouter:58% burn=$0.00064/min ceiling=none high -> minimal
[jev-effort] score=2.38 conf=0.54 budget=openrouter:58% burn=$0.00046/min ceiling=none high -> high
[jev-effort] score=2.36 conf=0.55 budget=local:0%      burn=$0.00114/min ceiling=low  high -> low
```

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

**1. Jev scores the prompt** against a four-level rubric — trivial, routine, substantial, hard —
and returns an expected score with its confidence. Measured against `~typesafe/jev-latest`
(resolved as `typesafe/jev-1.13-20260917`):

| Prompt | Score | Confidence | Latency | Cost |
|---|---|---|---|---|
| `list the files in this directory, nothing else` | 0.00 | 1.00 | — | — |
| `rename the variable foo to bar in utils.ts` | 0.43 | 0.57 | 281ms | $0.0000149 |
| `why does the run index drift from the runner status file after a crash` | 2.38 | 0.54 | — | — |
| `find why the scheduler deadlocks under concurrent compaction and fix it` | 2.87 | 0.87 | 235ms | $0.0000151 |

**2. Hysteresis decides whether to move.** An upgrade needs confidence ≥ 0.3, a downgrade ≥ 0.6.
Thinking more than necessary costs tokens; thinking less costs the answer, so the bars are not
symmetric. The third row above is why: at 0.54 the score leans substantial but not firmly enough to
give up a level you already have.

**3. The budget caps the result.** A ceiling from quota pressure is a hard cap, not an opinion — it
applies whether or not Jev was confident. Everything else about the turn is unchanged.

Short prompts never reach step 1. "continue" or "yes" carries no signal of its own, and classifying
it would drag the level down in the middle of hard work, so anything under 12 characters keeps the
current level and makes no call.

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

The footer carries it: `jev: high (0.87) · 58% · resets 2h11m`.

## Command

```
/jev-effort           # status, including budget source, burn and reset
/jev-effort on        # enable, and clear a manual pause
/jev-effort off       # disable for this session
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
  "timeoutMs": 2500,
  "levels": ["minimal", "low", "medium", "high"],
  "minUpgradeConfidence": 0.3,
  "minDowngradeConfidence": 0.6,
  "floor": null,
  "ceiling": null,
  "minPromptChars": 12,
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

`levels` maps rubric scores 0–3 onto pi thinking levels, so a model with `xhigh` and `max` can use
them: `["low", "medium", "high", "max"]`. `floor` and `ceiling` clamp every result. `JEV_EFFORT_DEBUG=1`
prints one line per judgement to stderr, as at the top of this README.

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

The tests cover the hysteresis rule, the hard cap, the wire contract of both transports with `fetch`
mocked, transcript parsing and burn rate, rate-limit header shapes, and the UTC window grid. For an
end-to-end check, point `baseUrl` at a local server that answers

```json
{ "answers": { "effort": { "type": "score", "score": 0, "confidence": 0.85 } } }
```

and run `JEV_EFFORT_DEBUG=1 pi -p "<a prompt of at least 12 characters>"`.

## License

MIT
