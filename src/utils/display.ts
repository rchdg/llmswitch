/**
 * Terminal display-width helpers.
 *
 * `String.padEnd` counts UTF-16 code units, but CJK characters occupy two
 * terminal columns. Padding Chinese headers or provider names with padEnd/
 * padStart therefore produces visibly ragged columns. These helpers pad by
 * rendered width instead.
 */

/**
 * Columns occupied by one code point. Covers the East Asian Wide/Fullwidth
 * ranges we actually emit (CJK, kana, hangul, fullwidth forms, common
 * punctuation and emoji); everything else counts as one column.
 */
function codePointWidth(cp: number): number {
  // Combining marks and zero-width characters take no space.
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0xfeff) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;

  if (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK radicals, Kangxi, CJK punctuation
    (cp >= 0x3041 && cp <= 0x33ff) || // Hiragana, Katakana, Hangul compat, CJK compat
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Ext A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified
    (cp >= 0xa000 && cp <= 0xa4cf) || // Yi
    (cp >= 0xac00 && cp <= 0xd7a3) || // Hangul syllables
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK compat ideographs
    (cp >= 0xfe30 && cp <= 0xfe6f) || // CJK compat forms
    (cp >= 0xff00 && cp <= 0xff60) || // Fullwidth forms
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1f64f) || // Emoji
    (cp >= 0x1f900 && cp <= 0x1f9ff) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK Ext B+
  ) {
    return 2;
  }
  return 1;
}

/** Rendered width of a string in terminal columns. */
export function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
        width += codePointWidth(char.codePointAt(0)!);
  }
  return width;
}

/** Pad on the right to `width` rendered columns. */
export function padEndDisplay(value: string, width: number): string {
  const missing = width - displayWidth(value);
  return missing > 0 ? value + " ".repeat(missing) : value;
}

/** Pad on the left to `width` rendered columns. */
export function padStartDisplay(value: string, width: number): string {
  const missing = width - displayWidth(value);
  return missing > 0 ? " ".repeat(missing) + value : value;
}

export interface TableColumn<T> {
  header: string;
  value: (row: T) => string;
  align?: "left" | "right";
}

/**
 * Render a fixed-width table sized to its content, aligned by display width.
 * Returns header + rows; the caller decides how to print them.
 */
export function renderTable<T>(rows: T[], columns: TableColumn<T>[]): string[] {
  const cells = rows.map((row) => columns.map((col) => col.value(row)));
  const widths = columns.map((col, i) =>
    Math.max(
      displayWidth(col.header),
      ...cells.map((row) => displayWidth(row[i] ?? "")),
    ),
  );
  const line = (values: string[]) =>
    values
      .map((value, i) =>
        columns[i]!.align === "right"
          ? padStartDisplay(value, widths[i]!)
          : padEndDisplay(value, widths[i]!),
      )
      .join("  ")
      .trimEnd();
  return [line(columns.map((col) => col.header)), ...cells.map(line)];
}
