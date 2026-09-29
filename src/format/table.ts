import type { JsonValue, Row } from '../value';

/**
 * Print HITAMO rows as a text table.
 * Numbers are right-aligned. Null is the word null, so it stays distinct from an empty string.
 */
export function formatRows(rows: Row[]): string {
  if (rows.length === 0) return '(0 rows)\n';
  const columns = columnNames(rows);
  if (columns.length === 0) return `${countLine(rows.length)}\n`;

  const alignRight = columns.map((name) => numericColumn(rows, name));
  const body = rows.map((row) => columns.map((name) => cellText(name in row ? row[name] : null)));
  const widths = columns.map((name, index) =>
    Math.max(name.length, ...body.map((line) => line[index].length)),
  );

  return [
    rule('┌', '┬', '┐', widths),
    render(columns, widths, alignRight),
    rule('├', '┼', '┤', widths),
    ...body.map((line) => render(line, widths, alignRight)),
    rule('└', '┴', '┘', widths),
    countLine(rows.length),
    '',
  ].join('\n');
}

function columnNames(rows: Row[]): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      names.push(key);
    }
  }
  return names;
}

function numericColumn(rows: Row[], name: string): boolean {
  let sawNumber = false;
  for (const row of rows) {
    if (!(name in row) || row[name] === null) continue;
    if (typeof row[name] !== 'number') return false;
    sawNumber = true;
  }
  return sawNumber;
}

function cellText(value: JsonValue): string {
  if (value === null) return 'null';
  if (value === true) return 'true';
  if (value === false) return 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') return value.replace(/\r\n|\n|\r/g, '\\n').replace(/\t/g, '\\t');
  return JSON.stringify(value);
}

function rule(left: string, mid: string, right: string, widths: number[]): string {
  return left + widths.map((width) => '─'.repeat(width + 2)).join(mid) + right;
}

function render(values: string[], widths: number[], alignRight: boolean[]): string {
  const cells = values.map((value, index) => {
    const gap = widths[index] - value.length;
    const text = alignRight[index] ? `${' '.repeat(gap)}${value}` : `${value}${' '.repeat(gap)}`;
    return ` ${text} `;
  });
  return `│${cells.join('│')}│`;
}

function countLine(count: number): string {
  return `(${count} ${count === 1 ? 'row' : 'rows'})`;
}
