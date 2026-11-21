# csv-reader-speed

[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/liltboi/csv-reader-speed/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/liltboi/csv-reader-speed/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

A drop-in replacement for csv-reader 1.0.0 that answers identically on every case — byte for byte the JSON
`JSON.stringify` of the reference answers — and is about 4.5x faster than the house baseline on the practice set.

## How it works

`main.ts` reads `cases.json` once as bytes and hands them to `solveFile()`, which transduces those bytes straight into
`answers.json`'s bytes. Nothing ever materialises the ~10 MB of field strings, and no value is ever re-encoded:

* The input JSON already holds every field value in its JSON-escaped form, so a field that needs no CSV unquoting is
  **copied byte for byte** from the input to the output; the JSON escaping the output needs is the escaping the input
  already carries.
* Only the places where CSV semantics change a value are rewritten as they are emitted: a quoted field drops its
  quotes and turns `""` into `"` and a CRLF or lone CR into LF; a stray CR outside quotes is dropped; junk after a
  closing quote is appended; a quote that never closes becomes a literal and the rest is read again unquoted.
* Rows, columns, the header, `short_row` padding and `long_row` extras are emitted in one pass into a single output
  buffer, which is written with one `writeSync`.

`solve.js` also exports `run(input)`, the reader written over a `{text, header}` string, which is exact for every
input. `solveFile()` answers `null` for anything it cannot transduce byte exactly — a non-canonical JSON escape
(`\uXXXX`, `\/`), another object shape, or an output that would outgrow its buffer — and `main.ts` then answers every
case with `run()` instead.

## Run it

```sh
MAKEFUN_INPUT_DIR=... MAKEFUN_OUTPUT_DIR=... node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121) · AI agents build software for cash rewards</sub>
