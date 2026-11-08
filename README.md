# dsh-trajectory-digest

Two-layer tool-output compression for **DeepSeek Harness (DSH)**.

A long session drowns in its own tool output. Every `ls`, every test run, every
file listing is re-sent to the model on every subsequent request — long after it
has served its purpose. This plugin keeps the recent working set intact and
collapses the rest into self-describing digests, with the full original always
recoverable from disk.

## Measured effect

On a real workload (199 digests across 7 sessions):

| metric | value |
|---|---|
| tool-result text compressed | **1,289,708 → 114,780 chars (91.1%)** |
| single session prompt size | 338,540 → **285,919 tokens** (−52.6k) |
| 50 KB listing | 49,931 → 150 chars (99.7%) |
| `grep` with 1200 matches | 8,576 → 110 chars |
| test-run log | 1,124 → 120 chars |

A controlled A/B (same 8×`grep` task, same step count, one mode per run):

| mode | prompt at step 10 |
|---|---|
| age layer disabled | 66,239 tokens |
| age layer enabled | **41,303 tokens** |

## How it works

Two layers, one policy.

**Age layer (the main one).** After every step the planner looks at the
model-visible surface and picks `tool/result` nodes that are older than
`keepRecent` requests and larger than `minChars`. Each one is rewritten with a
`tool/result` *surface replacement* — a durable event whose `surfaceOp` is
`{ op: 'replace', startSeq, endSeq }`:

```js
session.append('tool/result', { ...original.data, message: {
  ...original.data.message,
  content: [{ type: 'text', text: digest }],
}}, { surfaceOp: { op: 'replace', startSeq: seq, endSeq: seq }, sourceEventSeqs: [seq] })
```

The original event stays in the log (the human transcript still shows the real
output); only the model-visible node changes, and the change is durable across
restarts without needing this plugin loaded.

**Write layer.** A single result larger than `hugeChars` (default 40k) is bounded
immediately, because the step that produced it still has to fit in one request.

## Per-family digests

Bodies are chosen by tool family instead of a blind head-slice:

| family | detection | body |
|---|---|---|
| `bash` / `pwsh` | `Tests:`, `✓ built`, `N passed/failed`, `added N packages`, `npm ERR!` | that single line (`· outcome`) |
| `bash`, listing-shaped | >20 short lines, no prose | line count + first 3 (`· listing`) |
| `grep` | `Found N of M matches` | the count, plus up to 3 file names (`· matches`) |
| `glob` | line count | count + first 3 paths (`· paths`) |
| `web_fetch` / `web_search` | `# heading` or `<title>` | the heading (`· extract`) |
| anything failing | `isError` or an error line | the first error lines verbatim (`· error`) |
| everything else | — | head + tail (`· head+tail`) |

Every digest ends with a spill path, so the model can `read` the full original
when it really needs it:

```
[digest] ✓ grep "tag-5" → 255L/8576c · matches
Found 250 of 1200 matches
… full: ~/.dsh/trajectory-digest/spill/1794056609896-grep-….txt
```

## Configuration

`~/.dsh/trajectory-digest/config.json` is re-read live (500 ms), so behaviour
changes need no plugin reload:

```json
{
  "mode": "age",
  "keepRecent": 2,
  "minChars": 1600,
  "spillMaxFiles": 400,
  "spillMaxAgeDays": 7,
  "spillMaxBytes": 268435456
}
```

| key | default | meaning |
|---|---|---|
| `mode` | `age` | `age` (both layers) or `write` (only the `> hugeChars` guard) |
| `keepRecent` | `2` | how many requests keep full fidelity |
| `minChars` | `1600` | age threshold; `hugeChars`-style write threshold in `write` mode |
| `hugeChars` | `40000` | write-layer threshold in `age` mode |
| `digestChars` | `420` | body budget for aged results |
| `maxDigestChars` | `1200` | hard cap on any digest |
| `spillMaxFiles` / `spillMaxAgeDays` / `spillMaxBytes` | 400 / 7 / 256 MiB | spill retention |
| `neverDigest` | `read`, `edit`, `write`, `skill`, … | tools that are never touched |

## Why reasoning is never compressed

On the DeepSeek route the adapter replays assistant `reasoning` blocks as
`thinking` with their signatures. Rewriting them invalidates the signature and
rewrites the model's own chain of thought — the failure mode is not an error but
a quietly worse decision. This plugin touches `tool/result` nodes only.

## Install

```bash
plugin_manager install_bundle /absolute/path/to/dsh-trajectory-digest
```

No dependencies, no imports from `@deepseek-ai/*`.

## Known limits

* The age planner handles at most `maxEntriesPerRecord` (default 8) nodes per
  step, so a very long pre-existing history takes a few steps to catch up.
* Per-family extraction is heuristic. It is tuned for build/test/listing output;
  an unusual format falls back to `head+tail`, which is still recoverable via the
  spill path.
* `stats.json` is not bounded (it is small: one bucket per session).

MIT licensed.
