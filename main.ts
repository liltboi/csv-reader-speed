// The harness runs `node /bot/main.ts` (node22): it reads every case from /input/cases.json (a JSON array of
// {id, input}), answers each one with run() from solve.js, and writes /output/answers.json, one answer per case
// and in the cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and
// /output.
//
// The fast path answers the whole set at once: solveFile() reads cases.json's bytes and transduces them into
// answers.json's bytes without ever materialising the ~10 MB of field strings. The input JSON already holds every
// field value in its JSON-escaped form, so a field needing no CSV unquoting is copied byte for byte and the output
// needs no re-escaping; the answer is byte for byte the JSON the per-case run() + JSON.stringify path writes.
// When the file is not the shape that path can answer exactly (a non-canonical JSON escape, another key order,
// anything unexpected) solveFile returns null and the per-case path below answers it with run(), which is exact
// for every input.

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, as the house baseline runs it, set before solve.js is imported so all of its work
// runs under it. (This is the one flag V8 reads while it runs; the compiler and heap flags are fixed when the
// process starts, so setting them from here would change nothing.)
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run, solveFile } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
  solveFile: (path: string) => Buffer | null;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const INPUT_FILE = join(INPUT_DIR, 'cases.json');
const OUTPUT_FILE = join(OUTPUT_DIR, 'answers.json');

const fd = openSync(OUTPUT_FILE, 'w');
const fast = solveFile(INPUT_FILE);
if (fast !== null) {
  let off = 0;
  while (off < fast.length) off += writeSync(fd, fast, off, fast.length - off);
} else {
  // The file is not the shape the transducer can answer exactly: answer each case with run().
  const cases = JSON.parse(readFileSync(INPUT_FILE, 'utf8')) as { id: string; input: unknown }[];
  if (cases.length === 0) writeSync(fd, '[]');
  for (let i = 0; i < cases.length; i += 1) {
    const a = run(cases[i]!.input);
    const s = (i === 0 ? '[' : ',') + JSON.stringify(a) + (i === cases.length - 1 ? ']' : '');
    const buf = Buffer.from(s, 'utf8');
    let off = 0;
    while (off < buf.length) off += writeSync(fd, buf, off, buf.length - off);
  }
}
closeSync(fd);
