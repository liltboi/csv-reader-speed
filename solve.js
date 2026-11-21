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
    for (;;) {
      if (nextLf < pos) {
        const t = text.indexOf('\n', pos);
        nextLf = t < 0 ? n : t;
      }
      if (nextCr < pos) {
        const t = text.indexOf('\r', pos);
        nextCr = t < 0 ? n : t;
      }

      if (text.charCodeAt(pos) === 34) {
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
        // An unquoted field: the first comma, LF or CR at or after pos ends it.
        quoted = false;
        const start = pos;
        let ci = text.indexOf(',', pos);
        if (ci < 0) ci = n;
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
      fields.push(value);
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
