// A fast drop-in for csv-reader 1.0.0: run(input) reads {text, header} once, left to right, and answers
// {columns, rows, errors} exactly as the house reference does.
//
// solveFile() is the fast path main.ts uses on the case set: it reads cases.json's bytes and transduces them into
// answers.json's bytes. The input JSON already holds every field value in its JSON-escaped form, so a field that
// needs no CSV unquoting is copied byte for byte and the output needs no re-escaping; only a quoted field ("" -> ",
// CRLF or a lone CR -> LF), a stray CR or a junk tail is rewritten as it is emitted. A JSON escape that is not
// canonical (\uXXXX, \/) falls back: this path returns null and the caller answers with run() over the parsed values.

import { openSync, readSync, closeSync, fstatSync } from 'node:fs';

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



// ---------------------------------------------------------------------------------------------------------------------
// Fast path: cases.json bytes -> answers.json bytes.
// ---------------------------------------------------------------------------------------------------------------------

const COM = 44, QUO = 34, BS = 92, NL = 110, CR = 114, UU = 117, SL = 47;

const C_COLUMNS = Buffer.from('{"columns":');
const C_NULLROWS = Buffer.from('null,"rows":[');
const C_ROWS = Buffer.from(',"rows":[');
const C_ERRS = Buffer.from('],"errors":[');
const C_SHORT = '{"code":"short_row","line":';
const C_LONG = '{"code":"long_row","line":';
const C_STRAY = '{"code":"stray_cr","line":';
const C_QJUNK = '{"code":"quote_junk","line":';
const C_UNTERM = '{"code":"unterminated_quote","line":';

const HDR = Buffer.from('\",\"h');
let B, CAP, E, P, O, LINE, RL, RR;
let EB = Buffer.allocUnsafe(1 << 20), EO = 0, EN = 0;
let FEND = new Int32Array(1 << 12);
let ANY = false;

function putConst(o, c) {
  const n = c.length;
  for (let i = 0; i < n; i++) B[o + i] = c[i];
  return o + n;
}

function wStr(eo, s) {
  for (let i = 0; i < s.length; i++) EB[eo++] = s.charCodeAt(i);
  return eo;
}
function wInt(eo, v) {
  if (v < 10) { EB[eo++] = 48 + v; return eo; }
  const st = eo;
  while (v >= 10) { const q = (v / 10) | 0; EB[eo++] = 48 + (v - q * 10); v = q; }
  EB[eo++] = 48 + v;
  let a = st, z = eo - 1;
  while (a < z) { const t = EB[a]; EB[a++] = EB[z]; EB[z--] = t; }
  return eo;
}
function errHead(c, line, row) {
  let eo = EO;
  if (EN > 0) EB[eo++] = COM;
  EN++;
  eo = wStr(eo, c);
  eo = wInt(eo, line);
  eo = wStr(eo, ',"row":');
  if (row < 0) eo = wStr(eo, 'null'); else eo = wInt(eo, row);
  return eo;
}
function errSimple(c) {
  let eo = errHead(c, RL, RR);
  EB[eo++] = 125;
  EO = eo;
}

function readUnquoted() {
  const b = B, e = E;
  let p = P, o = O;
  for (;;) {
    while (p < e) { const c = b[p]; if (c === COM || c === BS) break; b[o++] = c; p++; ANY = true; }
    if (p >= e) { P = p; O = o; return 3; }
    if (b[p] === COM) { P = p + 1; O = o; return 1; }
    const c2 = b[p + 1];
    if (c2 === NL) { P = p + 2; O = o; LINE++; return 2; }
    if (c2 === CR) {
      if (p + 4 <= e && b[p + 2] === BS && b[p + 3] === NL) { P = p + 4; O = o; LINE++; return 2; }
      O = o;
      errSimple(C_STRAY);
      p += 2;
      continue;
    }
    if (c2 === UU || c2 === SL) return -1;
    b[o++] = BS; b[o++] = c2; p += 2; ANY = true;
  }
}

function readQuoted(vStart) {
  const b = B, e = E;
  const openLine = LINE;
  let p = P + 2, o = vStart;
  for (;;) {
    while (p < e) { const c0 = b[p]; if (c0 === BS) break; b[o++] = c0; p++; }
    if (p >= e) break;
    const c2 = b[p + 1];
    if (c2 === QUO) {
      if (p + 4 <= e && b[p + 2] === BS && b[p + 3] === QUO) {
        b[o++] = BS; b[o++] = QUO;
        p += 4;
        continue;
      }
      p += 2;
      if (p >= e) { P = p; O = o; return 3; }
      const c = b[p];
      if (c === COM) { P = p + 1; O = o; return 1; }
      if (c === BS) {
        const d = b[p + 1];
        if (d === NL) { P = p + 2; O = o; LINE++; return 2; }
        if (d === CR && p + 4 <= e && b[p + 2] === BS && b[p + 3] === NL) { P = p + 4; O = o; LINE++; return 2; }
      }
      P = p; O = o; ANY = false;
      const ended = readUnquoted();
      if (ANY) errSimple(C_QJUNK);
      return ended;
    }
    if (c2 === NL) { b[o++] = BS; b[o++] = NL; p += 2; LINE++; continue; }
    if (c2 === CR) {
      b[o++] = BS; b[o++] = NL;
      LINE++;
      if (p + 4 <= e && b[p + 2] === BS && b[p + 3] === NL) p += 4; else p += 2;
      continue;
    }
    if (c2 === UU || c2 === SL) return -1;
    b[o++] = BS; b[o++] = c2; p += 2;
  }
  O = vStart;
  if (vStart + 2 > CAP) return -1;
  B[O++] = BS; B[O++] = QUO;
  LINE = openLine;
  P = P + 2;
  errSimple(C_UNTERM);
  return readUnquoted();
}

function parseCase(ts, te, header, o0) {
  P = ts; E = te; LINE = 1; O = o0;
  if (E - P >= 3 && B[P] === 0xEF && B[P + 1] === 0xBB && B[P + 2] === 0xBF) P += 3;

  O = putConst(O, C_COLUMNS);
  if (!header) O = putConst(O, C_NULLROWS);

  let width = -1, columnsDone = false, rowCount = 0;

  for (;;) {
    for (;;) {
      if (P >= E) break;
      const c = B[P];
      if (c === BS) {
        const c2 = B[P + 1];
        if (c2 === NL) { P += 2; LINE++; continue; }
        if (c2 === CR && P + 4 <= E && B[P + 2] === BS && B[P + 3] === NL) { P += 4; LINE++; continue; }
      }
      break;
    }
    if (P >= E) break;

    RL = LINE;
    const isHeader = header && !columnsDone;
    RR = isHeader ? -1 : rowCount;

    const recStart = O;
    if (!isHeader && rowCount > 0) B[O++] = COM;

    B[O++] = 91;
    let nf = 0;
    let lastQuoted = false;
    let firstEmpty = true;
    let ended;
    do {
      if (nf > 0) B[O++] = COM;
      B[O++] = QUO;
      const vs = O;
      const q = B[P] === BS && B[P + 1] === QUO;
      lastQuoted = q;
      ended = q ? readQuoted(vs) : readUnquoted();
      if (ended < 0) return -1;
      if (nf === 0 && O > vs) firstEmpty = false;
      B[O++] = QUO;
      if (nf >= FEND.length) { const nf2 = new Int32Array(FEND.length * 2); nf2.set(FEND); FEND = nf2; }
      FEND[nf] = O;
      nf++;
    } while (ended === 1);

    if (nf === 1 && firstEmpty && !lastQuoted) { O = recStart; continue; }

    if (isHeader) {
      width = nf;
      columnsDone = true;
      B[O++] = 93;
      O = putConst(O, C_ROWS);
    } else {
      if (width < 0) width = nf;
      if (nf < width) {
        let eo = errHead(C_SHORT, RL, RR);
        eo = wStr(eo, ',"fields":');
        eo = wInt(eo, nf);
        EB[eo++] = 125; EO = eo;
        for (let k = nf; k < width; k++) { B[O++] = COM; B[O++] = QUO; B[O++] = QUO; }
      } else if (nf > width) {
        const from = FEND[width - 1] + 1;
        let eo = errHead(C_LONG, RL, RR);
        eo = wStr(eo, ',"extra":[');
        B.copy(EB, eo, from, O);
        eo += O - from;
        EB[eo++] = 93; EB[eo++] = 125; EO = eo;
        O = FEND[width - 1];
      }
      rowCount++;
      B[O++] = 93;
    }
  }

  if (header && !columnsDone) {
    B[O++] = 91; B[O++] = 93;
    O = putConst(O, C_ROWS);
  }
  O = putConst(O, C_ERRS);
  EB.copy(B, O, 0, EO); O += EO;
  B[O++] = 93; B[O++] = 125;
  EO = 0;
  return O;
}

/** Reads a cases.json file's bytes and transduces them into answers.json's bytes, or null when the file is not the
 * shape this path can answer exactly (the caller then falls back to run()). */
export function solveFile(path) {
  const fd = openSync(path, 'r');
  try {
    const size = fstatSync(fd).size;
    const outbase = ((size + 7) & ~7) + 16;
    CAP = outbase + Math.ceil(size * 2.75) + (1 << 23);
    B = Buffer.allocUnsafe(CAP);
    let off = 0;
    while (off < size) {
      const got = readSync(fd, B, off, size - off, off);
      if (got <= 0) return null;
      off += got;
    }
    return solveSlice(B, size, outbase);
  } finally {
    closeSync(fd);
  }
}

/** The same transduction over a Buffer already holding cases.json (tests). */
export function solveBuffer(raw) {
  const size = raw.length;
  const outbase = ((size + 7) & ~7) + 16;
  CAP = outbase + Math.ceil(size * 2.75) + (1 << 23);
  B = Buffer.allocUnsafe(CAP);
  raw.copy(B, 0, 0, size);
  return solveSlice(B, size, outbase);
}

function solveSlice(B, N, outbase) {
  let o = outbase;
  B[o++] = 91;
  let searchFrom = 0, first = true;
  for (;;) {
    const tpos = B.indexOf('"text":"', searchFrom);
    if (tpos < 0) break;
    const ts = tpos + 8;
    const hk = B.indexOf(HDR, ts);
    if (hk < 0) return null;
    const hv = B[hk + 11];
    if (hv !== 0x74 && hv !== 0x66) return null;
    if (!first) B[o++] = COM;
    first = false;
    EO = 0; EN = 0;
    o = parseCase(ts, hk, hv === 0x74, o);
    if (o < 0) return null;
    searchFrom = hk + 12;
  }
  B[o++] = 93;
  return B.subarray(outbase, o);
}
