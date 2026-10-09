import { getUserFromAuthHeader, getAdminClient } from './lib/supabaseAdmin.js';
import { loadConnectorsAndTools, runTool } from './lib/claudeTools.js';
import { allowRequest } from './lib/rateLimit.js';
import { createUsageMeter } from './lib/tokenUsage.js';
import { allowedOrigin } from './lib/cors.js';
import { MCP_BETA, loadMcpServers, buildMcpRequest, mcpPromptLines } from './lib/mcpServers.js';
import { selectMemory, queryFromMessages } from './lib/memoryRetrieval.js';

export const config = { maxDuration: 300 };

const MODEL = 'claude-sonnet-5';
// Generous enough that no real conversation hits it; stops a runaway loop or abuse from one account.
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

function stripEmDashes(s) {
  if (!s || typeof s !== 'string') return s;
  return s
    .replace(/\u2014/g, ',')
    .replace(/\u2013/g, '-')
    .replace(/\u2015/g, ',')
    .replace(/--+/g, ',')
    .replace(/\s+,/g, ',')
    .replace(/,{2,}/g, ',')
    .replace(/\s{2,}/g, ' ');
}

function extractText(blocks) {
  if (!Array.isArray(blocks)) return '';
  return stripEmDashes(blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim());
}

/**
 * Drop thinking blocks from an assistant turn before it is replayed.
 *
 * Quantumy never asks for extended thinking, but the API can still return
 * thinking blocks, and a turn is replayed verbatim as the assistant message on
 * the next round. Sending one back is a 400 - either because it arrived empty
 * or because thinking is not enabled on the request - and because the whole
 * conversation is resent every message, one bad block poisons every message
 * after it rather than just the turn it came from. The text and the tool calls
 * are what the next round needs; the thinking is not.
 */
function dropThinkingBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((b) => b?.type !== 'thinking' && b?.type !== 'redacted_thinking');
}

/**
 * Drop half-finished server-side tool calls from an assistant turn.
 *
 * Anthropic runs MCP and web tools on its own side and returns the call and
 * its result as two separate blocks. When the token ceiling lands between
 * them, the turn ends holding an mcp_tool_use with no mcp_tool_result - and
 * replaying that is a hard 400: "mcp_tool_use ... was found without a
 * corresponding mcp_tool_result". Since the whole conversation is resent every
 * message, that one orphan kills every later message in the thread too, which
 * is how it showed up: not as a failed tool call, as a dead conversation.
 *
 * Both directions are dropped. A result whose call is missing is equally
 * invalid, and would strand the model with an answer to a question it cannot
 * see. Local tool_use blocks are left alone - those are paired up by the tool
 * loop itself, which is a different mechanism with its own handling.
 */
export function reconcileServerToolBlocks(blocks) {
  if (!Array.isArray(blocks)) return { content: [], dropped: [] };
  const isUse = (b) => typeof b?.type === 'string' && b.type !== 'tool_use' && b.type.endsWith('_tool_use');
  const isResult = (b) => typeof b?.type === 'string' && b.type !== 'tool_result' && b.type.endsWith('_tool_result');

  const resultFor = new Set(blocks.filter(isResult).map((b) => b.tool_use_id).filter(Boolean));
  const useFor = new Set(blocks.filter(isUse).map((b) => b.id).filter(Boolean));

  const dropped = [];
  const content = blocks.filter((b) => {
    if (isUse(b) && !resultFor.has(b.id)) {
      dropped.push(b.name || b.type);
      return false;
    }
    if (isResult(b) && b.tool_use_id && !useFor.has(b.tool_use_id)) {
      dropped.push(b.type);
      return false;
    }
    return true;
  });
  return { content, dropped };
}

// Long-lived conversations resend their full history on every message with no
// cap, so a thread that grows to hundreds of exchanges (or has a few large
// pasted files in it) gets proportionally more expensive forever. Keep the
// most recent messages up to a character budget (~4 chars/token, so this is
// roughly a 40k-token ceiling on history alone), always keeping at least the
// current turn even if it alone exceeds the budget.
const MAX_HISTORY_CHARS = 200_000;
function trimHistory(msgs) {
  if (msgs.length <= 1) return msgs;
  let total = 0;
  const kept = [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    const len = typeof msgs[i].content === 'string' ? msgs[i].content.length : JSON.stringify(msgs[i].content).length;
    if (kept.length > 0 && total + len > MAX_HISTORY_CHARS) break;
    kept.unshift(msgs[i]);
    total += len;
  }
  return kept;
}

// Attached PDFs ride in the message text as [📄 name](data:application/pdf;base64,…).
// Claude reads PDFs natively — including scanned ones, which it renders as
// images — so there is no parsing step here, just a document block.
const PDF_RE = /\[([^\]]*)\]\(data:application\/pdf;base64,([A-Za-z0-9+/=\s]+)\)/g;
const MAX_PDFS = 3;

function extractPdfs(str) {
  const docs = [];
  const text = str.replace(PDF_RE, (_full, label, data) => {
    const clean = String(data || '').replace(/\s+/g, '');
    const name = String(label || 'document').replace(/^📄\s*/, '').trim() || 'document';
    if (clean.length < 128) return `[Attached PDF "${name}" was empty and could not be read]`;
    if (docs.length >= MAX_PDFS) {
      return `[Attached PDF "${name}" was not read — at most ${MAX_PDFS} PDFs per message]`;
    }
    docs.push({
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: clean },
    });
    return `[Attached PDF: ${name}]`;
  });
  return { text, docs };
}

function toAnthropicContent(content) {
  const { text: withoutPdfs, docs } = extractPdfs(String(content || ''));
  const str = withoutPdfs;
  const imgRe = /!\[([^\]]*)\]\((data:image\/([a-zA-Z0-9+.-]+);base64,([A-Za-z0-9+/=\s]+))\)/g;
  const parts = [];
  let last = 0, m, imageCount = 0;
  const MAX_IMAGES = 5;
  while ((m = imgRe.exec(str)) !== null) {
    if (m.index > last) {
      const text = str.slice(last, m.index).trim();
      if (text) parts.push({ type: 'text', text });
    }
    if (imageCount < MAX_IMAGES) {
      let mediaType = m[3];
      if (!mediaType.startsWith('image/')) mediaType = 'image/' + mediaType;
      if (mediaType.includes('jpg')) mediaType = 'image/jpeg';
      else if (mediaType.includes('png')) mediaType = 'image/png';
      else if (mediaType.includes('gif')) mediaType = 'image/gif';
      else if (mediaType.includes('webp')) mediaType = 'image/webp';
      else if (!['image/jpeg','image/png','image/gif','image/webp'].includes(mediaType)) mediaType = 'image/jpeg';
      const data = String(m[4] || '').replace(/\s+/g, '');
      if (data.length > 64) {
        parts.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data } });
        imageCount += 1;
      }
    }
    last = m.index + m[0].length;
  }
  const rest = str.slice(last).trim();
  if (rest) parts.push({ type: 'text', text: rest });
  if (parts.length === 0 && docs.length === 0) return str || '';
  if (parts.every((p) => p.type === 'image') && parts.length > 0) {
    parts.unshift({ type: 'text', text: `Please analyze the ${parts.length} attached image${parts.length > 1 ? 's' : ''}.` });
  }
  // Documents lead, so the model has them in hand before the request text.
  if (docs.length > 0) {
    if (parts.length === 0) {
      parts.push({ type: 'text', text: `Please review the attached PDF${docs.length > 1 ? 's' : ''}.` });
    }
    return [...docs, ...parts];
  }
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  return parts;
}

async function loadUserMemory(userId) {
  try {
    const admin = getAdminClient();
    const { data } = await admin
      .from('user_memory')
      .select('fact, category')
      .eq('user_id', userId)
      .order('updated_at', { ascending: false })
      .limit(60);
    return data || [];
  } catch {
    return [];
  }
}

async function loadProjectContext(userId, projectId) {
  if (!projectId) return null;
  try {
    const admin = getAdminClient();
    const { data } = await admin.from('projects').select('name, description').eq('id', projectId).eq('user_id', userId).maybeSingle();
    return data;
  } catch {
    return null;
  }
}

/** Rules and tool descriptions only — nothing per-user, so this stays cached across requests even while memory/project churn. */
function buildStaticSystemPrompt({ connected }) {
  const toolLines = ['- web_search', '- web_fetch', '- save_memory / recall_memory', '- save_note / list_notes', '- generate_pdf_document'];
  if (connected.gmail) toolLines.push('- Gmail tools');
  if (connected.drive) toolLines.push('- Drive tools');
  if (connected.docs) toolLines.push('- Docs tools');
  if (connected.sheets) toolLines.push('- Sheets tools');
  if (connected.calendar) toolLines.push('- Calendar tools');
  if (connected.outlook) toolLines.push('- Outlook tools');
  if (connected.excel) toolLines.push('- Excel tools');

  return `You are **Quantumy**, an AI workspace operator. Direct, brief, outcome-focused. No filler, no emoji.\n\n**Reasoning depth:** Match deliberation to the question. Think it through carefully when it's complex, ambiguous, or high-stakes; answer directly and concisely when it's simple, don't pad a short answer with unneeded deliberation.\n\n**Memory first, always:** Before reaching for any tool, check what you already know from the saved memory in this prompt. Answer from memory whenever it's actually sufficient; don't re-fetch live data you already have a saved answer for. Memory is the default context source for this user, not a fallback for when tools are unavailable.\n\n**Web search: explicit request only.** Never call web_search or web_fetch unless the user actually asks you to look something up or search the web ("search for...", "look up...", "what's the latest on...", "check online"). Do not search proactively just because a fact could be stale or you're unsure, even on a question that sounds like it needs current info. If you don't know something and they haven't asked you to search, say what you know and ask if they want you to look it up, don't decide to search on your own.\n\n**Connected tools (Gmail, Drive, Docs, Sheets, Calendar, etc.): explicit request only.** Only call a connected tool when the message is actually asking you to check, find, send, update, or otherwise touch that account or workspace. Never call one speculatively to see if it has something relevant, and never call one because a past message implied you might eventually need to. If memory already answers the question, use memory instead of reaching for a live tool.\n\n**Tool choice: whether to use any tool at all:** Most messages need zero tools: greetings, opinions, brainstorming, explaining something you already know, general knowledge, casual conversation, and anything memory already answers. Answer those directly with no tool call. save_memory and save_note remain on their own explicit triggers described below; they are not part of this default-to-no-tool rule.\n\n**Confirmation rule:** Reversible actions do immediately (sheet updates, drafts, search, docs, pdfs). Trash: summarize and wait for the user to say yes in chat. Sending, replying, forwarding email, creating a calendar event with guests, changing or cancelling a calendar event that has guests (or inviting new ones), and commenting on a shared file never happen from your call: once the content is final, call send_email, reply_email, forward_email, create_calendar_event (with attendees), update_calendar_event, delete_calendar_event, add_file_comment or reply_to_file_comment once; the app then shows the user a Confirm card with exactly those fields and acts only when the user presses Confirm. You cannot confirm for them. Never say an email was sent, guests were invited, an event was changed or a comment was posted unless a tool result says so; normally say it is waiting for their Confirm. An event nobody else is on is created, changed or cancelled immediately.\n\n**Executive PDFs and Documents (when asked):**\n- When the user asks to create/generate a PDF, report, brief, or proposal, call generate_pdf_document. Include clean section titles, paragraph content, bullet items, and formatted tables with headers/rows. Include 2-4 metric highlight cards (e.g. key figures) and a summary_box when applicable. Pick an appropriate theme (navy for corporate, emerald for finance/sustainability, charcoal for tech/modern). If Google Drive is connected, it saves to Drive and returns the direct link; otherwise it provides a direct download link.\n- When the user asks for a Google Doc (create_google_doc), structure the body with clean Markdown (# Heading 1, ## Heading 2, - bullets, **bold**) so the document automatically formats with styled headings, typography, and hierarchy in Google Docs.\n\n**Multi-step ops (sheets + email), once the user has actually asked for one:** Do not stall. Prefer the shortest tool path:\n1) search_sheets / search_drive to get spreadsheet_id\n2) read_sheet with range like "Master!A1:Z2" (or the named tab) to learn columns\n3) update_sheet with append:true and the same tab range (e.g. "Master!A:Z") mapping values in column order\n4) create_email_draft (not send) matching the user's requested style, then ask them to confirm send\nIf a tool errors, report it and continue with what you can.\n\n**Undoing sheet edits:** Every sheet write you make is recorded before it happens, so "undo that" works. Call undo_sheet_edit to reverse the last one, redo_sheet_edit to put it back, and list_sheet_edits first when more than one edit could be meant. Two limits to be honest about: this only reverses edits you made, not what the user typed in the sheet themselves (tell them Ctrl+Z in the browser for that), and undo is itself a write, so it appears in the file's version history. If undo reports that the cells changed after you wrote them, do not force it. Say which cell changed and ask them first.\n\n**Saying what you did (hard rule, no exceptions):** Only a tool_result in this conversation is evidence that something happened. Everything else is intention.\n- Do not describe an action in the past tense unless the tool call for it ran and returned in this conversation. \"I updated the sheet\" is a claim about a tool_result; if there is no tool_result, it is false.\n- Do not say you will check, look, or verify something and then answer without calling the tool. If a message names a check, either make the call in that same turn or do not name the check. Never end a turn on \"let me check X\" - the turn is where the checking happens.\n- If you cannot do it - no connector, missing id, tool errored, ran out of steps - say that plainly and say what you need. An honest \"I could not do this because X\" is always a better answer than a description of the work you would have done.\n- If a tool call fails or is cut off, the action did not happen. Retry it or report it. Do not narrate around it.\n\n**When the user says you did not do something:** Do not simply agree, and do not simply insist. Look at the conversation: find the tool_result, or find that there is none. Then say which it is. \"You're right, I did not - there is no record of that call, let me do it now\" when you did not, and \"I did run it, here is what came back: ...\" when you did, quoting the result. Apologising for something you actually did is as wrong as claiming something you did not, and folding on contact teaches the user nothing about which of your answers to trust. Never guess to make the disagreement go away.\n\n**Style (hard rules):**\n- Lead with outcomes. Clean Markdown in text mode. No pipe tables.\n- Never use em dashes (—) or en dashes (–) or double hyphens as dashes. Use commas, periods, colons, or parentheses instead.\n- Prefer short sentences over long clauses.\n- Code blocks must contain the literal plain text meant to be copied and run or pasted as-is. Never percent-encode, URL-encode, or otherwise transform text inside a code block.\n\n**Memory (critical):** Actively use every saved fact given to you in the user context below. Prefer memory over guessing, and prefer it over calling a tool to re-derive something already saved. When they share stable facts, call save_memory immediately without asking permission. Keep each saved fact to one thing, stated in a sentence or two; if you have a lot to record, save several separate facts rather than one long one.\n\n**The memory in this prompt is filtered, not complete.** Only the saved facts matching the current topic are included, plus the ones about how this user likes to work. The rest are still saved and still reachable. So a fact you cannot see is not a fact that does not exist: if the user refers to something they told you before, asks what you remember, or asks about a person, project, or system you have no fact about in front of you, call recall_memory and search. Never say you do not remember something, or that it was never saved, without calling recall_memory first - that is the same error as claiming you did something you did not.\n\n**Learning how they work (behavior patterns):** Beyond stated facts, notice recurring patterns in how this user works with you, e.g. they always want a draft before sending, they consistently ask for short answers, they always check a specific sheet before anything else, they prefer a certain tone or format. Only save a pattern with save_memory (category "behavior") once you've genuinely seen it repeat, not from a single instance, and phrase it as an observation ("tends to prefer X"), not a rigid rule. These are visible and editable in Settings, so never invent one to sound adaptive, only save what you actually observed. Once saved, actually adapt: apply it without being asked again.\n\n**Notes (explicit trigger only, never guess):** save_note, list_notes, update_note, delete_note are unrelated to memory. Only call save_note when the user directly asks to save or add a note ("note this", "add a note:", "save this as a note") — never infer on your own that something is note-worthy the way you do for memory. Keep the note text short and concrete.\n- Project scoping is automatic: if they're inside a project, the note files under it without asking; only pass project explicitly to target a different one by name ("add a note to Tanzania: ..."). list_notes defaults the same way — inside a project it shows that project's notes plus global ones; pass project:"all" if they ask to see everything regardless of project.\n- Pick note_type from context: action_item for a to-do, trade_note for something tied to a specific deal/row, decision for a record of what was decided and why, alert for something the whole team should see. Default action_item if unclear.\n- Set due_date only if they give or imply one ("follow up by Friday", "due the 20th"). Set trade_ref when they mention a specific reference/row id, so it can be looked up later in a connected sheet with search_sheets/read_sheet. Set priority only if implied; default medium.\n- Set tags for short topic labels when the note clearly belongs to a topic worth grouping by later (e.g. "shipping", "payments"), not on every note. Set checklist when they describe a note as multiple steps or a list of things to do ("note this: 1) call the bank 2) get the SWIFT code 3) confirm with Shivaz"), one string per step; skip it for a single-item note. To add/change steps later, update_note with a new checklist array replaces the whole list.\n- "mark this done" / "dismiss that note" / "delete that note": use update_note or delete_note with the note_id from the most recent save_note or list_notes result for that note. If you don't have the id in context, call list_notes first to find it.\n- "escalate this to X": draft an email (create_email_draft) summarizing the note and its project/trade_ref, addressed per their instruction; confirm before send_email like any other outbound email. This does not change the note's status unless they also ask for that.\n- "show overdue notes": list_notes with overdue:true. "generate a notes summary" / "export notes": call list_notes with the right filter, then either answer inline, or build the summary into create_google_doc / create_email_draft if they ask for a doc or an email specifically.\n\n## Connected tools\n${toolLines.join('\n')}`;
}

/** Per-user, changes almost every request (memory grows constantly) — kept out of the cached static block on purpose. */
function buildDynamicContext({ memory, project, firstName, query = '' }) {
  // Only the facts that bear on what is being discussed, plus the ones about
  // how this user works, which always apply. See lib/memoryRetrieval.js.
  const { selected, omitted, total } = selectMemory(memory, query);

  const omittedLine =
    omitted > 0
      ? `\n${omitted} of ${total} saved facts are not shown here because they did not match this topic. They are not gone. If you think something was saved that you cannot see, call recall_memory to search the full store rather than telling the user you have no memory of it.`
      : '';

  const memoryBlock =
    selected.length > 0
      ? `## What you know about this user (use aggressively)\n${selected
          .map((m) => `- ${m.fact}${m.category ? ` (${m.category})` : ''}`)
          .join('\n')}\nThese facts are authoritative. Prefer them over generic advice. Reference them by name or detail when relevant. Never pretend you forgot them. When they share new stable personal, work, preference, or project facts, call save_memory immediately.${omittedLine}`
      : total > 0
        ? `## What you know about this user\nNone of the ${total} saved facts matched this topic, so none are shown. Call recall_memory to search them if the question turns out to need one.`
        : '## What you know about this user\nNo saved memories yet. As soon as they share stable personal, work, preference, or project facts, call save_memory right away.';

  const projectBlock = project
    ? `## Active project workspace\nName: ${project.name}\n${project.description ? `Description: ${project.description}\n` : ''}`
    : '';

  const nameLine = firstName
    ? `The user's first name is ${firstName}. Address them by first name occasionally when natural.`
    : '';

  return `${nameLine}\n${memoryBlock}\n${projectBlock}`;
}

function sseWrite(res, obj) {
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

const CACHE_CONTROL = { type: 'ephemeral' };

/**
 * Tags the last block of the last message so the growing prefix gets cached
 * round to round, then appends `tail` — the per-request user context — *after*
 * that breakpoint.
 *
 * The order is the whole point. Caching is a prefix match, and the tail is
 * rebuilt from the database on every request, so anywhere inside the cached
 * prefix it would strand every breakpoint the previous requests wrote: the
 * bytes they pointed at no longer exist, no entry matches, and the entire
 * conversation gets re-billed as a cache write instead of read at a tenth of
 * the price. Sitting after the breakpoint it is just the uncached remainder,
 * a few hundred tokens at full price, and the history in front of it keeps
 * hitting cache.
 */
function withCacheBreakpoint(messages, tail = null) {
  if (!messages?.length) return messages;
  const out = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  let content = last.content;
  if (typeof content === 'string') {
    content = [{ type: 'text', text: content, cache_control: CACHE_CONTROL }];
  } else if (Array.isArray(content) && content.length) {
    content = content.map((b, i) => (i === content.length - 1 ? { ...b, cache_control: CACHE_CONTROL } : b));
  }
  if (tail && Array.isArray(content)) content = [...content, { type: 'text', text: tail }];
  out.push({ ...last, content });
  return out;
}

/** Tags the last tool so the whole (static) tool list is cached rather than re-billed every round. */
function withToolsCacheBreakpoint(tools) {
  if (!tools?.length) return tools;
  const out = tools.slice(0, -1);
  out.push({ ...tools[tools.length - 1], cache_control: CACHE_CONTROL });
  return out;
}

/**
 * System carries the static rules block only, cache_control-tagged.
 *
 * Per-user context (memory, project, name) used to sit here too, untagged. That
 * looked free — it is never worth a cache write of its own — but position, not
 * tagging, is what costs money: render order is tools -> system -> messages, so
 * a volatile block here sits ahead of the entire conversation, and one
 * save_memory call invalidated the cached history behind it. It now rides at
 * the tail of the newest message instead (see withCacheBreakpoint), which
 * changes nothing the model reads and leaves the prefix in front of it intact.
 *
 * The purpose-built channel for this is a `role: "system"` message inside
 * `messages`, but Sonnet 5 rejects those, so a text block on the user turn is
 * the available route.
 */
function systemBlocks(system) {
  return [{ type: 'text', text: system.staticPrompt, cache_control: CACHE_CONTROL }];
}

/**
 * The MCP connector is two fields that only work together: a server in
 * `mcp_servers` and an `mcp_toolset` in `tools` naming it. Sending either
 * alone is a validation error, so they are applied in one place, and the beta
 * header goes on only when there is actually a server to connect - an unused
 * beta flag is a needless difference between requests.
 */
function applyMcp(body, headers, mcp) {
  if (!mcp?.mcp_servers?.length) return;
  body.mcp_servers = mcp.mcp_servers;

  /**
   * The toolsets must go in front of the cache breakpoint, not after it.
   *
   * This first appended them to a tool list that had already been tagged, so
   * the breakpoint sat on the last local tool and everything the MCP servers
   * contributed fell outside the cached prefix. An MCP server's tools are not
   * two lines of JSON - the toolset entry expands to that server's whole
   * catalogue, which for a Make account is one tool per on-demand scenario -
   * and all of it was then re-billed as fresh input on every round of every
   * turn, at ten times the cache-read rate. Caching is a prefix match, so
   * where the breakpoint sits is the entire difference.
   *
   * The old tag is stripped rather than left in place: two breakpoints would
   * work, but chat.js already spends three of the four the API allows, and
   * one at the end of the whole list is what actually wants caching.
   */
  const local = (body.tools || []).map(({ cache_control, ...rest }) => rest);
  body.tools = withToolsCacheBreakpoint([...local, ...mcp.toolsets]);
  headers['anthropic-beta'] = MCP_BETA;
}

async function runClaude({ apiKey, system, messages, tools, maxTokens = 4096, mcp }) {
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system: systemBlocks(system),
    messages: withCacheBreakpoint(messages, system.dynamicContext),
  };
  if (tools?.length) body.tools = withToolsCacheBreakpoint(tools);
  const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  applyMcp(body, headers, mcp);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorText = await response.text();
    const err = new Error(`Anthropic API error ${response.status}`);
    err.status = response.status;
    err.details = errorText;
    throw err;
  }
  return response.json();
}

export async function runClaudeStream({ apiKey, system, messages, tools, onDelta, maxTokens = 4096, mcp }) {
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system: systemBlocks(system),
    messages: withCacheBreakpoint(messages, system.dynamicContext),
    stream: true,
  };
  if (tools?.length) body.tools = withToolsCacheBreakpoint(tools);
  const headers = { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' };
  applyMcp(body, headers, mcp);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const errorText = await response.text();
    const err = new Error(`Anthropic API error ${response.status}`);
    err.status = response.status;
    err.details = errorText;
    throw err;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', stopReason = null, textAcc = '';
  const contentBlocks = [];
  let currentTool = null;
  // The block currently open, whatever its type. currentTool tracks only the
  // subset whose arguments stream as JSON; deltas for other kinds - thinking
  // text, a thinking signature - need the block itself.
  let currentBlock = null;
  // Streaming splits usage across two events: message_start carries the input
  // side (which is final the moment the request is accepted), message_delta
  // carries a running output count whose last value is the total.
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
    web_search_requests: 0,
  };
  // message_start reports the input as it stood when the request was accepted.
  // Server-side tools (web_search, web_fetch) run *during* the response and
  // inject their results into the same message, so the real input can end up
  // far larger than that opening figure — and the corrected totals arrive in
  // message_delta. Reading only output_tokens there silently under-counts
  // every turn that searched the web.
  const applyUsage = (u) => {
    if (!u) return;
    for (const k of ['input_tokens', 'output_tokens', 'cache_read_input_tokens', 'cache_creation_input_tokens']) {
      if (u[k] != null) usage[k] = Number(u[k]) || 0;
    }
    // Billed per search, not per token, so it is tracked separately.
    const searches = u.server_tool_use?.web_search_requests;
    if (searches != null) usage.web_search_requests = Number(searches) || 0;
  };
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let evt;
      try {
        evt = JSON.parse(payload);
      } catch {
        continue;
      }
      if (evt.type === 'message_start') {
        applyUsage(evt.message?.usage);
      } else if (evt.type === 'content_block_start') {
        const b = evt.content_block;
        if (b?.type === 'text') {
          currentTool = null;
          currentBlock = { type: 'text', text: '' };
          contentBlocks.push(currentBlock);
        } else if (b?.type === 'tool_use') {
          currentTool = { type: 'tool_use', id: b.id, name: b.name, input: '', partial_json: '' };
          currentBlock = currentTool;
          contentBlocks.push(currentTool);
        } else if (b) {
          // Anything else Anthropic ran on its side: mcp_tool_use and its
          // result, web_search_tool_result, and whatever comes next. These
          // used to be dropped, which was harmless while every block was text
          // or a local tool call and quietly corrupting once it was not - the
          // turn is replayed to the API as the assistant message, so a
          // missing mcp_tool_use leaves its result orphaned and the model
          // loses what it just did. Kept whole, with arguments accumulated the
          // same way as a local call when the block streams any.
          const passthrough = { ...b };
          if (passthrough.input === undefined && b.type.endsWith('_tool_use')) {
            passthrough.input = {};
            passthrough.partial_json = '';
            currentTool = passthrough;
          } else {
            currentTool = null;
          }
          currentBlock = passthrough;
          contentBlocks.push(passthrough);
        }
      } else if (evt.type === 'content_block_delta') {
        const d = evt.delta;
        if (d?.type === 'text_delta' && typeof d.text === 'string') {
          textAcc += d.text;
          const last = contentBlocks[contentBlocks.length - 1];
          if (last?.type === 'text') last.text += d.text;
          if (onDelta) onDelta(d.text);
        } else if (d?.type === 'input_json_delta' && currentTool) {
          currentTool.partial_json = (currentTool.partial_json || '') + (d.partial_json || '');
        } else if (d?.type === 'thinking_delta' && currentBlock) {
          // A thinking block arrives empty and fills through deltas. Ignoring
          // them left the block with thinking: "", and replaying that as the
          // assistant turn is rejected outright - "each thinking block must
          // contain thinking" - which killed every following message in the
          // conversation, not just the one that produced it.
          currentBlock.thinking = (currentBlock.thinking || '') + (d.thinking || '');
        } else if (d?.type === 'signature_delta' && currentBlock) {
          currentBlock.signature = (currentBlock.signature || '') + (d.signature || '');
        }
      } else if (evt.type === 'content_block_stop') {
        if (currentTool) {
          try {
            currentTool.input = JSON.parse(currentTool.partial_json || '{}');
          } catch {
            // The arguments were cut off mid-JSON. Defaulting to {} used to hide
            // this: the call then ran with no arguments at all - read_sheet with
            // no spreadsheet id, search_gmail with no query - and whatever came
            // back had nothing to do with what was meant. Marked instead, so the
            // caller can reissue it rather than act on an answer to a question
            // nobody asked.
            currentTool.input = {};
            currentTool.truncated = true;
          }
          delete currentTool.partial_json;
          currentTool = null;
        }
        currentBlock = null;
      } else if (evt.type === 'message_delta') {
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
        // Cumulative and authoritative: whatever it carries supersedes
        // message_start, including a revised input count.
        applyUsage(evt.usage);
      }
    }
  }
  // A block still open when the stream ends never got its content_block_stop,
  // so its arguments are incomplete however far they got.
  if (currentTool) currentTool.truncated = true;

  const normalized = contentBlocks.map((b) => {
    if (b.type === 'tool_use') {
      const out = { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
      // Cut off before the tool was even named: there is nothing to reissue by
      // name, but it still has to count as a failed call rather than vanish.
      if (b.truncated || !b.name) out.truncated = true;
      return out;
    }
    // Passthrough blocks keep their own shape; only the streaming scratch
    // field is dropped, since sending it back would not be valid content.
    if (b.partial_json !== undefined) {
      const { partial_json, truncated, ...rest } = b;
      return rest;
    }
    return b;
  });
  return { stop_reason: stopReason || 'end_turn', content: normalized, text: textAcc, usage };
}

function sendSseError(res, message) {
  try {
    sseWrite(res, { error: message });
    sseWrite(res, { content: message });
    sseWrite(res, { done: true });
    res.write('data: [DONE]\n\n');
    res.end();
  } catch (_) {
    try { res.end(); } catch (_) {}
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin());
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });
  let wantStream = false;
  let sseStarted = false;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const messages = body?.messages;
    if (!messages || !Array.isArray(messages)) return res.status(400).json({ error: 'messages array is required' });
    const user = await getUserFromAuthHeader(req);
    if (!user) return res.status(401).json({ error: 'Sign in required' });
    if (!allowRequest(`chat:${user.id}`, RATE_LIMIT, RATE_WINDOW_MS)) {
      return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
    }
    wantStream = body?.stream === true;
    let memory = [];
    let project = null;
    let connected = { gmail: false, drive: false, docs: false, sheets: false, calendar: false, outlook: false, excel: false };
    let tools = [];
    const [connectorsResult, memoryResult, projectResult, mcpServers] = await Promise.all([
      loadConnectorsAndTools(user).catch(() => ({ connected, tools: [] })),
      user ? loadUserMemory(user.id) : Promise.resolve([]),
      user && body?.projectId ? loadProjectContext(user.id, body.projectId) : Promise.resolve(null),
      user ? loadMcpServers(user.id) : Promise.resolve([]),
    ]);
    connected = connectorsResult.connected;
    tools = connectorsResult.tools;
    memory = memoryResult;
    project = projectResult;

    // Anthropic connects to these itself, so there is nothing to execute here
    // and nothing to add to the local tool list - only the two request fields.
    const mcp = buildMcpRequest(mcpServers);

    const systemPrompt = {
      // Which servers are connected belongs in the static block: it changes
      // when someone adds one, not every request, so it stays cached.
      staticPrompt: buildStaticSystemPrompt({ connected }) + mcpPromptLines(mcpServers),
      dynamicContext: buildDynamicContext({
        memory,
        project,
        firstName: body?.firstName || null,
        query: queryFromMessages(messages),
      }),
    };

    let anthropicMessages = trimHistory(
      messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.role === 'assistant' ? String(m.content) : toAnthropicContent(m.content),
      }))
    );

    // Measured once, before the loop starts adding to the prompt: this is the
    // conversation the user actually sent, separate from what the tool loop
    // appends to it.
    const historyChars = JSON.stringify(anthropicMessages).length;
    const meter = createUsageMeter({
      userId: user.id,
      conversationId: body?.conversationId || null,
      endpoint: 'chat',
      model: MODEL,
    });
    let assistantChars = 0;

    /**
     * Write the usage row while the response is still open.
     *
     * This used to live only in a finally after res.end(). On Vercel the
     * function can be frozen the moment the response completes, so that insert
     * frequently never landed — chat recorded 6 turns in an hour where the
     * suggestions endpoint, which records before it replies, recorded 19. The
     * tokens were billed either way; only the record was lost.
     *
     * The cost is one insert before the final SSE event, by which point the
     * answer is already on screen, so the user waits for nothing.
     */
    const finishUsage = async () => {
      meter.setComposition({
        system_prompt: systemPrompt.staticPrompt.length,
        user_context: (systemPrompt.dynamicContext || '').length,
        tools: tools.length ? JSON.stringify(tools).length : 0,
        history: historyChars,
        tool_results: toolCharsUsed,
        assistant: assistantChars,
      });
      await meter.flush();
    };

    if (wantStream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      sseStarted = true;
      try { sseWrite(res, { status: 'started' }); } catch (_) {}
    }

    // Per-result and cumulative ceilings on tool output. Once the running total
    // is spent, later results are trimmed hard rather than dropped, so the model
    // still sees that a tool ran and can answer from what it already has.
    const MAX_TOOL_RESULT_CHARS = 20_000;
    const MAX_TOOL_RESULT_CHARS_TIGHT = 2_000;
    const TOTAL_TOOL_BUDGET_CHARS = 300_000;
    let toolCharsUsed = 0;

    const capToolResults = (results) =>
      results.map((r) => {
        if (typeof r?.content !== 'string') return r;
        const overBudget = toolCharsUsed >= TOTAL_TOOL_BUDGET_CHARS;
        const cap = overBudget ? MAX_TOOL_RESULT_CHARS_TIGHT : MAX_TOOL_RESULT_CHARS;
        if (r.content.length <= cap) {
          toolCharsUsed += r.content.length;
          return r;
        }
        toolCharsUsed += cap;
        const dropped = r.content.length - cap;
        return {
          ...r,
          content:
            `${r.content.slice(0, cap)}\n\n[Truncated: ${dropped} more characters not shown` +
            `${overBudget ? ', tool-output budget for this turn is spent' : ''}. ` +
            'Narrow the query or request a specific item rather than re-running the same search.]',
        };
      });

    const maxRounds = 24;
    // Kept moderate on purpose: the auto-continuation loop below is what actually
    // guards against truncation now, so a very high single-shot ceiling here would
    // only inflate worst-case cost (ceiling x continuations) without helping.
    const maxTokens = 8192;
    const MAX_CONTINUATIONS = 2;
    let continuations = 0;
    let accumulatedText = '';
    /** Reissuing a cut-off tool call is worth a couple of tries, not an unbounded loop. */
    const MAX_TRUNCATION_RETRIES = 2;
    let truncationRetries = 0;
    /** Resumes after a server tool pauses the turn. Bounded like every other retry. */
    const MAX_PAUSES = 6;
    let pauses = 0;

    // Usage is written no matter how the turn ends — normal finish, tool-step
    // ceiling, or a thrown provider error mid-loop — so cost reporting cannot
    // silently under-count the turns that went wrong. The client already has
    // its bytes by then, so the insert costs it nothing.
    try {
      for (let round = 0; round < maxRounds; round++) {
        let data;
        if (wantStream) {
          data = await runClaudeStream({
            apiKey,
            system: systemPrompt,
            messages: anthropicMessages,
            tools: tools.length ? tools : undefined,
            maxTokens,
            mcp,
            onDelta: (delta) => {
              try {
                // Raw, unstripped: stripEmDashes needs to see whole words/phrases, and
                // Anthropic's delta chunks split mid-token, so per-chunk stripping can
                // miss patterns straddling a chunk boundary. The final { content } event
                // below carries the fully-stripped text and overwrites this on the client.
                sseWrite(res, { delta });
              } catch (_) {}
            },
          });
        } else {
          data = await runClaude({
            apiKey,
            system: systemPrompt,
            messages: anthropicMessages,
            tools: tools.length ? tools : undefined,
            maxTokens,
            mcp,
          });
        }
        const { content, dropped: orphanedServerTools } = reconcileServerToolBlocks(
          dropThinkingBlocks(data.content)
        );
        meter.addRound();
        meter.addUsage(data.usage);
        meter.setStopReason(data.stop_reason);
        assistantChars += JSON.stringify(content).length;
        /**
         * A tool call cut off by the token ceiling is the worst way for a turn
         * to go wrong, because it does not look wrong.
         *
         * The block was dropped for having no usable name, the turn then read
         * as text-only, and the max_tokens branch below asked the model to
         * "continue where you left off" - so it carried on writing prose from a
         * context in which it believed it had called the tool. The tool never
         * ran. The user was told it had.
         *
         * Truncated calls are therefore never dropped and never continued as
         * prose. The incomplete blocks are removed from the turn so no tool_use
         * is left without a matching tool_result, and the model is told plainly
         * that the call did not run so it reissues it.
         */
        const truncatedTools = content.filter((b) => b.type === 'tool_use' && b.truncated);
        if (truncatedTools.length > 0 && truncationRetries < MAX_TRUNCATION_RETRIES) {
          truncationRetries += 1;
          const kept = content.filter((b) => !(b.type === 'tool_use' && b.truncated));
          const named = truncatedTools.map((b) => b.name).filter(Boolean);
          if (kept.length > 0) anthropicMessages = [...anthropicMessages, { role: 'assistant', content: kept }];
          anthropicMessages = [
            ...anthropicMessages,
            {
              role: 'user',
              content:
                `[System] Your ${named.length ? named.join(' and ') + ' call' : 'tool call'} was cut off before it ` +
                'was complete, so it did not run and returned nothing. Nothing has happened yet. Issue the call ' +
                'again, keeping any preamble short so it fits.',
            },
          ];
          continue;
        }
        // Out of retries: say so rather than answering as though the call ran.
        if (truncatedTools.length > 0) {
          const msg =
            'I could not complete that: my tool call kept getting cut off before it was finished, so it never ' +
            'ran and nothing was changed. Ask me again, ideally narrowing it to one step.';
          await finishUsage();
          if (wantStream) {
            sseWrite(res, { content: msg });
            sseWrite(res, { done: true });
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          return res.status(200).json({ content: msg });
        }

        const clientToolBlocks = content.filter((b) => b.type === 'tool_use' && b.name);
        /**
         * MCP tools run on Anthropic's side, so they arrive as mcp_tool_use
         * rather than tool_use and were counted as nothing at all. A turn that
         * listed eleven Make scenarios and read a blueprint was recorded as
         * zero tool calls in one round - which is not a small inaccuracy on a
         * usage dashboard, it is the dashboard saying the expensive thing did
         * not happen. They are counted here; they still never reach the local
         * executor, which is the distinction that matters for execution.
         */
        const mcpToolBlocks = content.filter((b) => b.type === 'mcp_tool_use');
        // Orphans are counted too: the call was attempted and billed, it just
        // did not come back. A dashboard that hides attempts understates what
        // the turn actually cost.
        meter.addToolCalls(clientToolBlocks.length + mcpToolBlocks.length + orphanedServerTools.length);
        if (clientToolBlocks.length === 0) {
          const textOut = (wantStream ? data.text : extractText(content)) || extractText(content) || '';
          accumulatedText += textOut;
          /**
           * A server-side tool - web search, web fetch, an MCP server - can
           * hand the turn back mid-flight with pause_turn, meaning "I am not
           * finished, send this straight back to continue". Treating that as
           * the end of the turn stops the work half done and presents whatever
           * had been said so far as the answer. Passing the turn back is the
           * documented way to resume it.
           */
          if (data.stop_reason === 'pause_turn' && pauses < MAX_PAUSES && content.length > 0) {
            pauses += 1;
            anthropicMessages = [...anthropicMessages, { role: 'assistant', content }];
            continue;
          }
          if (data.stop_reason === 'max_tokens' && continuations < MAX_CONTINUATIONS) {
            continuations += 1;
            // If the ceiling landed mid tool call, the call was removed above
            // to keep the turn valid. Saying so is the difference between the
            // model reissuing it and the model carrying on as though it had
            // the answer - the same failure as a truncated local tool call.
            const cont = orphanedServerTools.length
              ? `Your ${[...new Set(orphanedServerTools)].join(' and ')} call was cut off before its result came back, so it did not complete and returned nothing. Do not describe its result. Issue it again if you still need it, then continue where you left off.`
              : 'Continue exactly where you left off, mid-sentence or mid-code-block if needed. Do not repeat anything already written, do not add any preamble or acknowledgement.';
            anthropicMessages = [
              ...anthropicMessages,
              // Dropping an orphan can empty the turn entirely, and an
              // assistant message with no content is itself a 400.
              ...(content.length ? [{ role: 'assistant', content }] : []),
              { role: 'user', content: cont },
            ];
            continue;
          }
          const finalText = accumulatedText || 'Sorry, I could not generate a response.';
          await finishUsage();
          if (wantStream) {
            sseWrite(res, { content: stripEmDashes(finalText) });
            sseWrite(res, { done: true });
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          return res.status(200).json({ content: stripEmDashes(finalText) });
        }
        if (wantStream) {
          try {
            const names = clientToolBlocks.map((b) => b.name).filter(Boolean);
            sseWrite(res, {
              status: 'tool_use',
              tool: names[0] || 'tool',
              tools: names,
              round: round + 1,
              message: 'Running: ' + names.join(', '),
            });
          } catch (_) {}
        }
        anthropicMessages = [...anthropicMessages, { role: 'assistant', content }];
        const toolResults = (
          await Promise.all(
            clientToolBlocks.map(async (block) => {
              const started = Date.now();
              try {
                const result = await runTool(block, user, {
                  projectId: project?.id || null,
                  projectName: project?.name || null,
                  // F09: irreversible Gmail actions are released only by the user pressing Confirm on this card.
                  onApprovalRequired: wantStream ? (card) => sseWrite(res, { status: 'approval_required', approval: card }) : undefined,
                });
                if (wantStream) {
                  try {
                    sseWrite(res, {
                      status: 'tool_done',
                      tool: block.name,
                      ms: Date.now() - started,
                      ok: !(result && result.is_error),
                    });
                  } catch (_) {}
                }
                return result;
              } catch (e) {
                if (wantStream) {
                  try {
                    sseWrite(res, {
                      status: 'tool_done',
                      tool: block.name,
                      ms: Date.now() - started,
                      ok: false,
                      detail: e?.message || String(e),
                    });
                  } catch (_) {}
                }
                return {
                  type: 'tool_result',
                  tool_use_id: block.id,
                  is_error: true,
                  content: `Tool error: ${e?.message || String(e)}`,
                };
              }
            })
          )
        ).filter(Boolean);
        if (toolResults.length === 0) {
          const fallback = 'Tool step produced no results. Please try a more specific request.';
          await finishUsage();
          if (wantStream) {
            sseWrite(res, { content: fallback });
            sseWrite(res, { done: true });
            res.write('data: [DONE]\n\n');
            return res.end();
          }
          return res.status(200).json({ content: fallback });
        }
        // Tool output is the one part of the prompt with no natural ceiling: up
        // to maxRounds of results accumulate here, and every earlier round stays
        // in the request. Uncapped, a few large Gmail/Drive hits can push the
        // whole call past the model's context limit and fail the turn outright.
        anthropicMessages.push({ role: 'user', content: capToolResults(toolResults) });
      }
      const limitMsg = 'I reached the tool-step ceiling. Ask me to continue from where I left off.';
      await finishUsage();
      if (wantStream) {
        sseWrite(res, { content: limitMsg });
        sseWrite(res, { done: true });
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      return res.status(200).json({ content: limitMsg });
    } finally {
      // Backstop for paths that throw before reaching a response. flush() is
      // idempotent, so a turn that already recorded is not written twice.
      await finishUsage();
    }
  } catch (err) {
    console.error('Handler error:', err);
    const msg =
      err?.status === 401
        ? 'AI provider auth failed. Check ANTHROPIC_API_KEY on the server.'
        : err?.status === 429
          ? 'AI rate limit hit. Wait a moment and try again.'
          : err?.status
            ? `AI provider error (${err.status}). ${String(err.details || '').slice(0, 180)}`
            : err?.message || 'Internal server error';
    if (sseStarted || wantStream) {
      return sendSseError(res, msg);
    }
    if (err.status) return res.status(502).json({ error: msg, status: err.status, details: err.details });
    return res.status(500).json({ error: msg });
  }
}
