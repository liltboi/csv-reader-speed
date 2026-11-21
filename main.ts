// The harness runs `node /bot/main.ts` (node22): it reads every case from /input/cases.json (a JSON array of
// {id, input}), answers each one with run() from solve.js, and writes /output/answers.json, one answer per case
// and in the cases' order. Outside a container MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for /input and
// /output.

import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, as the house baseline runs it, set before solve.js is imported so all of its work
// runs under it. (This is the one flag V8 reads while it runs; the compiler and heap flags are fixed when the
// process starts, so setting them from here would change nothing.)
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as { run: (input: unknown) => unknown };

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// A small text that walks every branch of the reader (plain, quoted, doubled, multiline, junk, stray CR,
// unterminated, ragged rows, BOM). Running it first lets V8 compile the reader's loops and collect type
// feedback before the real cases, which are far too few for that to happen on their own; its answers are
// thrown away and no case's answer depends on it.
function warmText(): string {
  const words = ['alpha', 'bravo', 'Zürich', '東京', 'São Paulo', 'Москва', 'x_1', 'n/a', "O'Brien", 'A&B'];
  const cell = (i: number): string => {
    switch (i % 15) {
      case 0: return `"${words[i % 10]}, ${words[(i + 3) % 10]}"`;
      case 1: return `"${words[i % 10]}""${words[(i + 5) % 10]}"`;
      case 2: return `"${words[i % 10]}\r\n${words[(i + 1) % 10]}"`;
      case 3: return `"${words[i % 10]}\r${words[(i + 2) % 10]}"`;
      case 4: return `"${words[i % 10]}\n${words[(i + 4) % 10]}"`;
      case 5: return `"${words[i % 10]}"junk`;
      case 6: return `${words[i % 10]}\r${words[(i + 6) % 10]}`;
      case 7: return `"${words[i % 10]}"`;
      case 8: return '';
      case 9: return `${i * 37}`;
      case 10: return `${i}.${i % 100}`;
      case 11: return `LG-${i * 13}`;
      case 12: return `"${words[i % 10]}" `;
      case 13: return `${words[i % 10]} ${words[(i + 7) % 10]}`;
      default: return `${1990 + (i % 40)}-0${1 + (i % 9)}-1${i % 9}`;
    }
  };
  const row = (i: number, width: number): string => {
    const f: string[] = [];
    for (let k = 0; k < width; k++) f.push(cell(i * width + k));
    return `${f.join(',')}\r\n`;
  };
  const parts: string[] = ['﻿int_1,phrase_2,note_3,word_4,code_5,maybe_6,decimal_7,date_8\r\n'];
  for (let i = 0; i < 40; i++) parts.push(row(i + 1, 8));
  parts.push(
    '\r\n', // blank line: no record
    '1,2,3\r\n', // short row
    '1,2,3,4,5,6,7,8,9,10\r\n', // long row
    'a,b\n', // LF line break
    'x\ry,"z"kg,1,2,3,4,5,6\r\n', // stray CR in a field, junk after a quote
    '"a"x\ry,2,3,4,5,6,7,8\r\n', // junk holding a stray CR
    '"a"\r2,3,4,5,6,7,8\r\n', // junk after a lone CR (stray_cr)
    '"a\r\nb",2,3,4,5,6,7,8\r\n', // CRLF inside quotes
    '"a\rb",2,3,4,5,6,7,8\r\n', // lone CR inside quotes
    '"a""b""c",2,3,4,5,6,7,8\r\n', // doubled quotes
    '"",2,3,4,5,6,7,8\r\n', // empty quoted field
    '\r\r\n', // stray CRs only: no record
    'a\r\r\n', // stray CR then CRLF
    '\r', // stray CR at the end of the text
    '"q",', // a trailing empty field
    ',,,\r\n', // empty fields
    '"q"\r\n', // a quoted field ending the record
    '"q\r', // a quoted field at the end of the text
    '1,2,3,4,5,6,7,8', // the last line break left off
    '"unterminated,1,2,3,4,5,6,7\r\nmore,text,here\r\n\r\nlast,row', // an unterminated quote
    '"unterminated\r\nwith crlf, and a comma',
    'x,"unterminated\nwith lf",tail\r\n',
  );
  for (let i = 0; i < 25; i++) parts.push(row(i + 100, 8));
  const block = parts.join('');
  let text = block;
  while (text.length < 24000) text += block;
  return text;
}

const PROFILE = process.env.MAKEFUN_PROFILE === '1';
const mark = (): number => (PROFILE ? process.cpuUsage().user + process.cpuUsage().system : 0);
let t0 = mark();

const WARM = warmText();
for (let i = 0; i < 6; i += 1) run({ text: WARM, header: (i & 1) === 0 });

let t1 = mark();
// The file's text is read and parsed in one expression: nothing keeps the ~11 MB JSON source alive while the
// cases are answered, so the collector only ever sees the six inputs and the one answer being written.
const cases = JSON.parse(readFileSync(join(INPUT_DIR, 'cases.json'))) as { id: string; input: unknown }[];
let t2 = mark();

// One answer at a time: each case is read, written as its JSON and dropped before the next, so the heap holds
// one case's strings rather than six sets of them and the scavenger has little live data to copy.
const fd = openSync(join(OUTPUT_DIR, 'answers.json'), 'w');
if (cases.length === 0) writeSync(fd, '[]');
let work = 0;
let write = 0;
const per: number[] = [];
const str: number[] = [];
for (let i = 0; i < cases.length; i += 1) {
  let t = mark();
  const a = run(cases[i]!.input);
  // The case's text is not needed again: drop it so later cases run with less live data.
  cases[i]!.input = null;
  if (PROFILE) per.push(mark() - t);
  t = mark();
  const s = (i === 0 ? '[' : ',') + JSON.stringify(a) + (i === cases.length - 1 ? ']' : '');
  if (PROFILE) {
    work += mark() - t;
    str.push(mark() - t);
  }
  t = mark();
  const wrote = writeSync(fd, s);
  if (wrote !== Buffer.byteLength(s)) {
    // A partial write (not expected for a regular file): finish it from a buffer of the whole answer.
    const buf = Buffer.from(s, 'utf8');
    let off = wrote;
    while (off < buf.length) off += writeSync(fd, buf, off);
  }
  if (PROFILE) write += mark() - t;
}
closeSync(fd);
if (PROFILE) process.stderr.write(JSON.stringify({ warm: t1 - t0, readParse: t2 - t1, per, str, write, all: mark() }) + '\n');
