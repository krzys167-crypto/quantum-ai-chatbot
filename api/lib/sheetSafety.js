/**
 * Cells the model writes into a Google Sheet are stored with valueInputOption=USER_ENTERED, so a string that starts
 * with "=" becomes a live formula that runs with the sheet owner's authority every time the sheet is opened.
 * A few functions reach the network from Google's servers:
 *
 *   IMAGE(url)                                   fetches `url` when the sheet is rendered. The url can be built from other
 *                                                cells ("https://x/?d=" & A1:A9), so cell content leaves the account
 *                                                without a click.
 *   IMPORTXML / IMPORTDATA / IMPORTHTML / IMPORTFEED   same, through a fetch whose result is shown in the sheet.
 *   IMPORTRANGE(sheet_url, range)                pulls another spreadsheet's cells into this one.
 *   HYPERLINK(url, label)                        a link whose target can carry cell content; one click sends it.
 *
 * A prompt-injected instruction in a mail, document or web page can ask the model to write such a formula, and
 * update_sheet / create_spreadsheet are not approval-gated (they stay in the user's account). So the model-facing path
 * writes a cell that contains one of those calls as TEXT: a leading apostrophe makes Sheets treat the cell as a plain
 * string (the apostrophe itself is not stored). Every other formula (SUM, IF, VLOOKUP, ...) is left alone.
 *
 * This is applied ONLY to what the model writes. updateSheetValues() itself is not changed, because undo/redo uses it
 * to put the user's own earlier cells back, and those may legitimately contain any formula.
 *
 * UNVERIFIED against the real Sheets API: that "'=IMAGE(...)" is stored as text under USER_ENTERED, and what
 * valueRenderOption=FORMULA reads back for such a cell (it matters only for the undo "has this changed" comparison).
 */

export const BLOCKED_FUNCTIONS = ['IMAGE', 'IMPORTXML', 'IMPORTDATA', 'IMPORTHTML', 'IMPORTFEED', 'IMPORTRANGE', 'HYPERLINK'];

// A call is the name, optional whitespace, then "(". Not preceded by a name character, so MYIMAGE( or A.IMAGE( are not it.
const CALL = new RegExp(`(?<![A-Za-z0-9_.])(${BLOCKED_FUNCTIONS.join('|')})\\s*\\(`, 'i');
// What Sheets may treat as the start of a formula: "=", and "+" / "-" / "@" in front of a function. Leading blanks,
// control characters and zero-width characters are skipped so they cannot be used to hide the "=".
const FORMULA_START = /^[\s\u0000-\u001f\u007f\u200b-\u200d\u2060\ufeff]*[=+\-@]/;

/** One cell. Returns the text to write and, when it was changed, the blocked function it contained. */
export function neutralizeCell(cell) {
  const text = cell == null ? '' : String(cell);
  if (!FORMULA_START.test(text)) return { value: text, fn: null };
  const m = CALL.exec(text);
  if (!m) return { value: text, fn: null };
  return { value: `'${text}`, fn: m[1].toUpperCase() };
}

/**
 * A grid as the tools receive it (array of rows; a row may be a bare scalar). Always returns an array of arrays of
 * strings, the shape updateSheetValues / createSpreadsheet write, plus where something was changed.
 * `hits` carries positions and function names only, never cell content.
 */
export function neutralizeGrid(grid) {
  const hits = [];
  const rows = (Array.isArray(grid) ? grid : []).map((row, r) =>
    (Array.isArray(row) ? row : [row]).map((cell, c) => {
      const { value, fn } = neutralizeCell(cell);
      if (fn) hits.push({ row: r, col: c, function: fn });
      return value;
    }),
  );
  return { rows, hits };
}

const MAX_REPORTED = 20;

/** The part of the tool result that tells the model (and so the user) what was done. Empty when nothing was changed. */
export function neutralizedNote(hits) {
  if (!hits.length) return {};
  return {
    neutralized_cells: hits.length,
    neutralized: hits.slice(0, MAX_REPORTED),
    neutralized_note:
      `${hits.length} cell(s) contained a formula that calls ${[...new Set(hits.map((h) => h.function))].join(', ')} ` +
      '(these fetch web addresses or pull in other files when the sheet opens). They were written as plain text, not as ' +
      'formulas. Tell the user. If they really want such a formula they can type it into the sheet themselves.',
  };
}
