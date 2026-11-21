// Escaped-byte transducer v8: record work in its own function.
import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

const COM = 44, QUO = 34, BS = 92, NL = 110, CR = 114, UU = 117, SL = 47;
const C_COLUMNS = Buffer.from('{"columns":');
const C_NULLROWS = Buffer.from('null,"rows":[');
const C_ROWS = Buffer.from(',"rows":[');
const C_ERRS = Buffer.from('],"errors":[');
const K_TEXT = Buffer.from('"text":"');
const K_HDR = Buffer.from('"header":');

let B, DV, OMAX = 0, E = 0, P = 0, O = 0, LINE = 0, RL = 0, RR = 0;
let WIDTH = -1, COLDONE = 0, ROWNO = 0;
let EB = Buffer.allocUnsafe(1 << 16), EO = 0, EN = 0;
let FEND = new Int32Array(1024);
let HPOS = new Int32Array(16);

function errGrow(need) {
  if (EO + need > EB.length) { let n = EB.length * 2; while (EO + need > n) n *= 2; const nb = Buffer.allocUnsafe(n); EB.copy(nb, 0, 0, EO); EB = nb; }
}
function wInt2(eo, v) {
  if (v < 10) { EB[eo++] = 48 + v; return eo; }
  const st = eo;
  while (v >= 10) { const q = (v / 10) | 0; EB[eo++] = 48 + (v - q * 10); v = q; }
  EB[eo++] = 48 + v;
  let a = st, z = eo - 1;
  while (a < z) { const t = EB[a]; EB[a++] = EB[z]; EB[z--] = t; }
  return eo;
}
const PREFIX = [
  '{"code":"short_row","line":',
  '{"code":"long_row","line":',
  '{"code":"stray_cr","line":',
  '{"code":"quote_junk","line":',
  '{"code":"unterminated_quote","line":',
];
/** Cold: appends one error object. */
function emitErr(code) {
  errGrow(160);
  let eo = EO;
  if (EN > 0) EB[eo++] = COM;
  EN++;
  const s = PREFIX[code];
  for (let i = 0; i < s.length; i++) EB[eo++] = s.charCodeAt(i);
  eo = wInt2(eo, RL);
  EB[eo++] = COM; EB[eo++] = QUO; EB[eo++] = 114; EB[eo++] = 111; EB[eo++] = 119; EB[eo++] = QUO; EB[eo++] = 58;
  if (RR < 0) { EB[eo++] = 110; EB[eo++] = 117; EB[eo++] = 108; EB[eo++] = 108; } else eo = wInt2(eo, RR);
  EB[eo++] = 125;
  EO = eo;
}
function putConst(o, c) { for (let i = 0; i < c.length; i++) B[o + i] = c[i]; return o + c.length; }
function growFend() { const n2 = new Int32Array(FEND.length * 2); n2.set(FEND); FEND = n2; }

/** Cold: pads a short row and records the error. */
function padRow(nf, width, o) {
  emitErr(0);
  const eo0 = EO - 1;
  let eo = eo0;
  const s = ',"fields":';
  for (let i = 0; i < s.length; i++) EB[eo++] = s.charCodeAt(i);
  eo = wInt2(eo, nf);
  EB[eo++] = 125; EO = eo;
  for (let k = nf; k < width; k++) { if (o > OMAX) return -1; out3[o++] = COM; out3[o++] = QUO; out3[o++] = QUO; }
  return o;
}
let out3;
/** Cold: trims a long row and records the error with the extra fields. */
function cutRow(from, to) {
  emitErr(1);
  const ncopy = to - from - 1;
  const eo0 = EO - 1;
  errGrow(ncopy + 40);
  let eo = eo0;
  const s = ',"extra":[';
  for (let i = 0; i < s.length; i++) EB[eo++] = s.charCodeAt(i);
  B.copy(EB, eo, from + 1, to); eo += ncopy;
  EB[eo++] = 93; EB[eo++] = 125; EO = eo;
  return from;
}

const M1 = 0x01010101 | 0, M2C = 0x2C2C2C2C | 0, M5C = 0x5C5C5C5C | 0;
function mask2(w) {
  const a = (w ^ M2C) | 0, c = (w ^ M5C) | 0;
  return (((a - M1) & ~a) | ((c - M1) & ~c)) & 0x80808080;
}
function maskBS(w) {
  const c = (w ^ M5C) | 0;
  return ((c - M1) & ~c) & 0x80808080;
}

function uEsc() {
  const b = B, out = B;
  const p = P, o = O;
  const c2 = b[p + 1];
  if (c2 === CR) {
    if (p + 4 <= E && b[p + 2] === BS && b[p + 3] === NL) { P = p + 4; LINE += 1; return 2; }
    emitErr(2);
    P = p + 2; O = o; return 0;
  }
  if (c2 === UU || c2 === SL) return -1;
  out[o] = BS; out[o + 1] = c2; O = o + 2; P = p + 2; return 0;
}
function qEsc() {
  const b = B, out = B;
  const p = P, o = O;
  const c2 = b[p + 1];
  if (c2 === NL) { out[o] = BS; out[o + 1] = NL; O = o + 2; P = p + 2; LINE += 1; return 0; }
  if (c2 === CR) {
    out[o] = BS; out[o + 1] = NL;
    if (p + 4 <= E && b[p + 2] === BS && b[p + 3] === NL) P = p + 4; else P = p + 2;
    O = o + 2; LINE += 1; return 0;
  }
  if (c2 === UU || c2 === SL) return -1;
  out[o] = BS; out[o + 1] = c2; O = o + 2; P = p + 2; return 0;
}
function readUnquoted() {
  const b = B, dv = DV, e = E, out = B;
  let p = P, o = O, line = LINE;
  let ended = 0;
  for (;;) {
    while (p + 8 <= e) {
      const w = dv.getUint32(p, true);
      const w2 = dv.getUint32(p + 4, true);
      dv.setUint32(o, w, true);
      dv.setUint32(o + 4, w2, true);
      const x1 = mask2(w);
      if (x1 !== 0) { const n = (31 - Math.clz32(x1 & -x1)) >> 3; o += n; p += n; break; }
      const x2 = mask2(w2);
      if (x2 !== 0) { const n = 4 + ((31 - Math.clz32(x2 & -x2)) >> 3); o += n; p += n; break; }
      o += 8; p += 8;
      if (o > OMAX) return -1;
    }
    while (p < e) {
      const c = b[p];
      if (c === COM || c === BS) break;
      out[o++] = c; p++;
    }
    if (p >= e) { ended = 3; break; }
    if (b[p] === COM) { p++; ended = 1; break; }
    if (b[p + 1] === NL) { p += 2; line++; ended = 2; break; }
    P = p; O = o; LINE = line;
    const r = uEsc();
    if (r < 0) return -1;
    if (r === 2) { ended = 2; p = P; o = O; line = LINE; break; }
    p = P; o = O; line = LINE;
  }
  P = p; O = o; LINE = line;
  return ended;
}
function readQuoted(vs) {
  const b = B, dv = DV, e = E, out = B;
  let p = P + 2, o = O, line = LINE;
  const openLine = line, openPos = p;
  let closed = false;
  for (;;) {
    while (p + 8 <= e) {
      const w = dv.getUint32(p, true);
      const w2 = dv.getUint32(p + 4, true);
      dv.setUint32(o, w, true);
      dv.setUint32(o + 4, w2, true);
      const x1 = maskBS(w);
      if (x1 !== 0) { const n = (31 - Math.clz32(x1 & -x1)) >> 3; o += n; p += n; break; }
      const x2 = maskBS(w2);
      if (x2 !== 0) { const n = 4 + ((31 - Math.clz32(x2 & -x2)) >> 3); o += n; p += n; break; }
      o += 8; p += 8;
      if (o > OMAX) return -1;
    }
    while (p < e) { if (b[p] === BS) break; out[o++] = b[p]; p++; }
    if (p >= e) break;
    if (b[p + 1] === QUO) {
      if (p + 4 <= e && b[p + 2] === BS && b[p + 3] === QUO) { out[o++] = BS; out[o++] = QUO; p += 4; continue; }
      p += 2; closed = true; break;
    }
    P = p; O = o; LINE = line;
    const r = qEsc();
    if (r < 0) return -1;
    p = P; o = O; line = LINE;
  }
  if (!closed) {
    o = vs; out[o++] = BS; out[o++] = QUO;
    P = openPos; O = o; LINE = openLine;
    emitErr(4);
    return readUnquoted();
  }
  if (p >= e) { P = p; O = o; LINE = line; return 3; }
  const c = b[p];
  if (c === COM) { P = p + 1; O = o; LINE = line; return 1; }
  if (c === BS && b[p + 1] === NL) { P = p + 2; O = o; LINE = line + 1; return 2; }
  if (c === BS && b[p + 1] === CR && p + 4 <= e && b[p + 2] === BS && b[p + 3] === NL) { P = p + 4; O = o; LINE = line + 1; return 2; }
  P = p; O = o; LINE = line;
  const before = o;
  const ended = readUnquoted();
  if (ended < 0) return -1;
  if (O !== before) emitErr(3);
  return ended;
}

/** Emits one record (P at its first character). Returns 0 on success, -1 to fall back. */
function record() {
  const b = B, out = B;
  const isHeader = headerFlag && !COLDONE;
  RL = LINE; RR = isHeader ? -1 : ROWNO;
  let o = O, p = P, line = LINE;
  const recStart = o;
  if (!isHeader && ROWNO > 0) out[o++] = COM;
  out[o++] = 91;
  let nf = 0, lastQuoted = 0, firstVs = -1, ended = 0;
  for (;;) {
    if (nf > 0) out[o++] = COM;
    out[o++] = QUO;
    const vs = o;
    if (nf === 0) firstVs = vs;
    lastQuoted = b[p] === BS && b[p + 1] === QUO ? 1 : 0;
    P = p; O = o; LINE = line;
    ended = lastQuoted ? readQuoted(vs) : readUnquoted();
    if (ended < 0) return -1;
    p = P; o = O; line = LINE;
    out[o++] = QUO;
    if (nf >= FEND.length) growFend();
    FEND[nf] = o;
    nf++;
    if (ended !== 1) break;
  }
  if (nf === 1 && o === firstVs + 1 && lastQuoted === 0) { O = recStart; P = p; LINE = line; return 0; }
  if (isHeader) {
    WIDTH = nf; COLDONE = 1;
    out[o++] = 93;
    o = putConst(o, C_ROWS);
    O = o; P = p; LINE = line;
    return 0;
  }
  if (WIDTH < 0) WIDTH = nf;
  if (nf < WIDTH) {
    o = padRow(nf, WIDTH, o);
    if (o < 0) return -1;
  } else if (nf > WIDTH) {
    o = cutRow(FEND[WIDTH - 1], o);
  }
  ROWNO++;
  out[o++] = 93;
  O = o; P = p; LINE = line;
  return 0;
}
let headerFlag = 0;

function parseCase(ts, te, header, o0) {
  E = te;
  P = ts; O = o0; LINE = 1;
  WIDTH = -1; COLDONE = 0; ROWNO = 0; headerFlag = header ? 1 : 0;
  if (te - ts >= 3 && B[ts] === 0xEF && B[ts + 1] === 0xBB && B[ts + 2] === 0xBF) P = ts + 3;
  let o = putConst(o0, C_COLUMNS);
  if (!header) o = putConst(o, C_NULLROWS);
  O = o;
  const b = B;
  while (P < te) {
    const c0 = b[P];
    if (c0 === BS) {
      const c1 = b[P + 1];
      if (c1 === NL) { P += 2; LINE++; continue; }
      if (c1 === CR && P + 4 <= te && b[P + 2] === BS && b[P + 3] === NL) { P += 4; LINE++; continue; }
    }
    if (record() < 0) return -1;
  }
  o = O;
  if (header && !COLDONE) { B[o++] = 91; B[o++] = 93; o = putConst(o, C_ROWS); }
  o = putConst(o, C_ERRS);
  if (o + EO + 2 > B.length) return -1;
  EB.copy(B, o, 0, EO); o += EO;
  B[o++] = 93; B[o++] = 125;
  EO = 0; EN = 0;
  return o;
}

function transduce(N) {
  const OUTBASE = (N + 16) & ~7;
  let nh = 0;
  for (let at = N; ; ) {
    at = B.lastIndexOf(K_HDR, at - 1);
    if (at < 0) break;
    if (nh === HPOS.length) { const n2 = new Int32Array(nh * 2); n2.set(HPOS); HPOS = n2; }
    HPOS[nh++] = at;
    if (at === 0) break;
  }
  if (nh === 0) return -1;
  for (let a = 0, z = nh - 1; a < z; a++, z--) { const t = HPOS[a]; HPOS[a] = HPOS[z]; HPOS[z] = t; }
  let o = OUTBASE;
  B[o++] = 91;
  let p = 0;
  while (p < N && B[p] <= 32) p++;
  if (p >= N || B[p] !== 91) return -1;
  p++;
  for (let i = 0; i < nh; i++) {
    const h = HPOS[i];
    const hv = B[h + 9];
    let header = false;
    if (hv === 116) header = true;
    else if (hv !== 102) return -1;
    const q = h - 2;
    const tpos = B.lastIndexOf(K_TEXT, q);
    if (tpos < 0) return -1;
    while (p < N && B[p] <= 32) p++;
    if (p >= N) return -1;
    if (B[p] === 44) { p++; while (p < N && B[p] <= 32) p++; }
    if (p >= N || B[p] !== 123 || p > tpos) return -1;
    p++;
    if (B.indexOf(K_TEXT, p) !== tpos) return -1;
    const ts = tpos + 8;
    if (i > 0) B[o++] = COM;
    EO = 0; EN = 0;
    o = parseCase(ts, q, header, o);
    if (o < 0) return -1;
    p = h + 9 + (hv === 116 ? 4 : 5);
    while (p < N && B[p] <= 32) p++;
    if (p + 1 >= N || B[p] !== 125 || B[p + 1] !== 125) return -1;
    p += 2;
  }
  while (p < N && B[p] <= 32) p++;
  if (p >= N || B[p] !== 93) return -1;
  p++;
  while (p < N && B[p] <= 32) p++;
  if (p !== N) return -1;
  B[o++] = 93;
  return o;
}

export function solveBuffer(raw) {
  const N = raw.length;
  const cap = N + N + (N >> 2) + (1 << 21);
  B = Buffer.allocUnsafe(cap);
  raw.copy(B, 0, 0, N);
  DV = new DataView(B.buffer, B.byteOffset, cap);
  OMAX = cap - 32; out3 = B;
  const end = transduce(N);
  if (end < 0) return null;
  return B.subarray((N + 16) & ~7, end);
}
export function solveFile(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const cap = size + size + (size >> 2) + (1 << 21);
    B = Buffer.allocUnsafe(cap);
    let off = 0;
    while (off < size) { const got = readSync(fd, B, off, size - off, off); if (got <= 0) return null; off += got; }
    DV = new DataView(B.buffer, B.byteOffset, cap);
    OMAX = cap - 32; out3 = B;
    const end = transduce(size);
    if (end < 0) return null;
    return B.subarray((size + 16) & ~7, end);
  } finally { closeSync(fd); }
}
// A fast drop-in for csv-reader 1.0.0: run(input) reads {text, header} once, left to right, and answers
// {columns, rows, errors} exactly as the house reference does.
//
// One cursor walks the text. A record that holds no quote before its first line break, and whose line break is a
// plain LF or a CRLF (no stray CR), is the common case and the cheap one: its fields are one native substring and
// one native split, so the per-field work runs in C++ rather than in a JS loop. Only a record that can hold a
// quoted field, a stray CR or junk takes the field-at-a-time reader below, which is the house reference's own
// reading spelled out: a plain field is one native search for its comma plus a substring, with the next LF and the
// next CR remembered between fields so no scan repeats, and the rare broken shapes (a stray CR, junk after a
// closing quote, an unterminated quote) stitch pieces together on a slow path.
//
// Character codes used below: 10 LF, 13 CR, 34 ", 44 ,, 0xFEFF BOM.

const COMMA = 1;
const LINE_BREAK = 2;
const END = 3;

/**
 * Reads one case's input.
 * @param {{text: unknown, header?: unknown}} input
 * @returns {{columns: string[] | null, rows: string[][], errors: object[]}}
 */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0;
  let line = 1;
  if (n > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The next LF and the next CR at or after pos (n when none is left): refreshed only once a cursor passes them.
  let nextLf = -1;
  let nextCr = -1;

  // The record being read: the line it starts on, and the index it will take in rows (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // Reads an unquoted run from start, appending to prefix: keeps every character but a CR that no LF follows
  // (stray_cr), which ends at the next comma or line break. Returns {value, ended, added}; `added` counts the
  // characters kept after prefix.
  function slowUnquoted(start, prefix) {
    const parts = [prefix];
    let segStart = start;
    let added = 0;
    let i = start;
    let ended = END;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 44) {
        parts.push(text.slice(segStart, i));
        added += i - segStart;
        pos = i + 1;
        ended = COMMA;
        break;
      }
      if (c === 10) {
        parts.push(text.slice(segStart, i));
        added += i - segStart;
        pos = i + 1;
        line += 1;
        ended = LINE_BREAK;
        break;
      }
      if (c === 13) {
        if (text.charCodeAt(i + 1) === 10) {
          parts.push(text.slice(segStart, i));
          added += i - segStart;
          pos = i + 2;
          line += 1;
          ended = LINE_BREAK;
          break;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        parts.push(text.slice(segStart, i));
        added += i - segStart;
        i += 1;
        segStart = i;
        continue;
      }
      i += 1;
    }
    if (i >= n) {
      parts.push(text.slice(segStart));
      added += n - segStart;
      pos = n;
    }
    return { value: parts.join(''), ended, added };
  }

  // The field-at-a-time reader, for a record the record-level fast path below cannot take. Returns the record's
  // fields and whether its last field was quoted (a record that held only stray CRs is left with no characters).
  function readFields() {
    const fields = [];
    let ended = END;
    let quoted = false;
    let value = '';
    let fi = 0;
    for (;;) {
      if (text.charCodeAt(pos) === 34) {
        if (nextLf < pos) {
          const t = text.indexOf('\n', pos);
          nextLf = t < 0 ? n : t;
        }
        if (nextCr < pos) {
          const t = text.indexOf('\r', pos);
          nextCr = t < 0 ? n : t;
        }
        // A quoted field: find the closing quote (the first quote not followed by another), then reread.
        quoted = true;
        const openLine = line;
        const start = pos + 1;
        const q0 = start < n ? text.indexOf('"', start) : -1;
        let q = q0;
        while (q >= 0 && text.charCodeAt(q + 1) === 34) q = text.indexOf('"', q + 2);
        if (q < 0) {
          // The quote never closes: it is a literal, and the text after it is read again as unquoted.
          pos = start;
          line = openLine;
          errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
          const r = slowUnquoted(start, '"');
          value = r.value;
          ended = r.ended;
        } else {
          if (q0 === q && nextLf >= q && nextCr >= q) {
            // The common quoted field: no doubled quote, no line break inside.
            value = q === start ? '' : text.slice(start, q);
          } else {
            // The field's own characters: "" one quote, a CRLF or a lone CR one LF.
            let parts = null;
            let segStart = start;
            let i = start;
            while (i < q) {
              const cc = text.charCodeAt(i);
              if (cc === 34) {
                if (parts === null) parts = [];
                parts.push(text.slice(segStart, i), '"');
                i += 2;
                segStart = i;
              } else if (cc === 13) {
                if (parts === null) parts = [];
                parts.push(text.slice(segStart, i), '\n');
                line += 1;
                i += text.charCodeAt(i + 1) === 10 ? 2 : 1;
                segStart = i;
              } else if (cc === 10) {
                line += 1;
                i += 1;
              } else {
                i += 1;
              }
            }
            if (parts === null) {
              value = text.slice(start, q);
            } else {
              parts.push(text.slice(segStart, q));
              value = parts.join('');
            }
          }
          pos = q + 1;
          // What follows the closing quote, up to the next comma or line break, is appended as it stands.
          if (pos >= n) {
            ended = END;
          } else {
            const cc = text.charCodeAt(pos);
            if (cc === 44) {
              pos += 1;
              ended = COMMA;
            } else if (cc === 10) {
              pos += 1;
              line += 1;
              ended = LINE_BREAK;
            } else if (cc === 13 && text.charCodeAt(pos + 1) === 10) {
              pos += 2;
              line += 1;
              ended = LINE_BREAK;
            } else {
              const r = slowUnquoted(pos, value);
              if (r.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
              value = r.value;
              ended = r.ended;
            }
          }
        }
      } else {
        // An unquoted field: the first comma, LF or CR at or after pos ends it. A comma before the next line
        // break (the common case) needs neither line-break cursor refreshed.
        quoted = false;
        const start = pos;
        let ci = text.indexOf(',', pos);
        if (ci < 0) ci = n;
        if (ci < nextLf && ci < nextCr) {
          value = text.slice(start, ci);
          pos = ci + 1;
          ended = COMMA;
          fields[fi++] = value;
          continue;
        }
        if (nextLf < pos) {
          const t = text.indexOf('\n', pos);
          nextLf = t < 0 ? n : t;
        }
        if (nextCr < pos) {
          const t = text.indexOf('\r', pos);
          nextCr = t < 0 ? n : t;
        }
        let end = ci;
        if (nextLf < end) end = nextLf;
        if (nextCr < end) end = nextCr;
        if (end >= n) {
          value = text.slice(start);
          pos = n;
          ended = END;
        } else {
          const ec = text.charCodeAt(end);
          if (ec === 44) {
            value = text.slice(start, end);
            pos = end + 1;
            ended = COMMA;
          } else if (ec === 10) {
            value = text.slice(start, end);
            pos = end + 1;
            line += 1;
            ended = LINE_BREAK;
          } else if (text.charCodeAt(end + 1) === 10) {
            value = text.slice(start, end);
            pos = end + 2;
            line += 1;
            ended = LINE_BREAK;
          } else {
            const r = slowUnquoted(start, '');
            value = r.value;
            ended = r.ended;
          }
        }
      }
      fields[fi++] = value;
      if (ended !== COMMA) break;
    }
    return { fields, quoted };
  }

  while (pos < n) {
    // Lines left with no characters are no record.
    const c0 = text.charCodeAt(pos);
    if (c0 === 10) {
      pos += 1;
      line += 1;
      continue;
    }
    if (c0 === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      continue;
    }

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    let fields = null;
    let lastQuoted = false;

    // The record-level fast path. The first line break at or after pos ends the record when no quote comes before
    // it (no quoted field can be open) and that break is a plain LF or a CRLF (no stray CR): then every field is
    // one comma-separated run of the record's characters, so one substring and one native split answer it. If the
    // first CR is not the LF's own CR, there is a stray CR and the record goes to the slow reader.
    if (nextLf < pos) {
      const t = text.indexOf('\n', pos);
      nextLf = t < 0 ? n : t;
    }
    if (nextCr < pos) {
      const t = text.indexOf('\r', pos);
      nextCr = t < 0 ? n : t;
    }
    const lf = nextLf;
    const cr = nextCr;
    let end;
    let after = -1;
    if (lf === n && cr === n) {
      end = n;
      after = n;
    } else if (lf < cr) {
      end = lf;
      after = lf + 1;
    } else if (lf < n && cr === lf - 1) {
      end = cr;
      after = lf + 1;
    } else {
      end = -1;
    }
    if (end >= 0) {
      const q = text.indexOf('"', pos);
      if (q < 0 || q >= end) {
        fields = text.slice(pos, end).split(',');
        pos = after;
        if (after > end) line += 1;
      }
    }
    if (fields === null) {
      const r = readFields();
      fields = r.fields;
      lastQuoted = r.quoted;
    }

    // A line that held only stray CRs is left with no characters: no record (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns === null ? [] : columns) : null, rows, errors };
}
