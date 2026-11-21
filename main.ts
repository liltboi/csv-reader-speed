// The harness runs `node /bot/main.ts` (node22): it reads every case from /input/cases.json (a JSON array of
// {id, input}), answers each one with run() from solve.js, and writes /output/answers.json, one answer per case
// and in the cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and
// /output.
//
// The fast path answers the whole set at once: solveFile() reads cases.json's bytes and transduces them into
// answers.json's bytes without ever materialising the field strings. The input JSON already holds every field
// value in its JSON-escaped form, so a field needing no CSV unquoting is copied byte for byte and the output
// needs no re-escaping. When the file is not the shape that path can answer exactly, solveFile returns null and
// the exact per-case path below answers it with run().

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, as the house baseline runs it, set before solve.js is imported.
setFlagsFromString('--no-incremental-marking');

const { run, solveFile } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
  solveFile: (path: string) => Buffer | null;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

const casesPath = join(INPUT_DIR, 'cases.json');
const outPath = join(OUTPUT_DIR, 'answers.json');

const fast = solveFile(casesPath);
if (fast !== null) {
  const fd = openSync(outPath, 'w');
  let off = 0;
  while (off < fast.length) off += writeSync(fd, fast, off, fast.length - off);
  closeSync(fd);
} else {
  // Exact fallback: parse the cases and answer each with run().
  const cases = JSON.parse(readFileSync(casesPath, 'utf8')) as { id: string; input: unknown }[];
  const answers: unknown[] = [];
  for (const c of cases) answers.push(run(c.input));
  const s = JSON.stringify(answers);
  const fd = openSync(outPath, 'w');
  const buf = Buffer.from(s, 'utf8');
  let off = 0;
  while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  closeSync(fd);
}
