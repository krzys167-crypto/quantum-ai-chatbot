import { getUserFromAuthHeader, getAdminClient } from './lib/supabaseAdmin.js';
import { loadConnectorsAndTools, runTool } from './lib/claudeTools.js';
import { allowRequest } from './lib/rateLimit.js';

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

// Long-lived conversations resend their full history on every message with no
// cap, so a thread that grows to hundreds of exchanges (or has a few large
// pasted files in it) gets proportionally more expensive forever. Keep the
// most recent messages up to a character budget (~4 chars/token, so this is
// roughly a 40k-token ceiling on history alone), always keeping at least the
// current turn even if it alone exceeds the budget.
const MAX_HISTORY_CHARS = 160_000;
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

function toAnthropicContent(content) {
  const str = String(content || '');
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
  if (parts.length === 0) return str || '';
  if (parts.length === 1 && parts[0].type === 'text') return parts[0].text;
  if (parts.every((p) => p.type === 'image')) {
    parts.unshift({ type: 'text', text: `Please analyze the ${parts.length} attached image${parts.length > 1 ? 's' : ''}.` });
  }
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
  const toolLines = ['- web_search', '- web_fetch', '- save_memory', '- save_note / list_notes'];
  if (connected.gmail) toolLines.push('- Gmail tools');
  if (connected.drive) toolLines.push('- Drive tools');
  if (connected.docs) toolLines.push('- Docs tools');
  if (connected.sheets) toolLines.push('- Sheets tools');
  if (connected.calendar) toolLines.push('- Calendar tools');
  if (connected.outlook) toolLines.push('- Outlook tools');
  if (connected.excel) toolLines.push('- Excel tools');

  return `You are **Quantumy**, an AI workspace operator. Direct, brief, outcome-focused. No filler, no emoji.\n\n**Reasoning depth:** Match deliberation to the question. Think it through carefully when it's complex, ambiguous, or high-stakes; answer directly and concisely when it's simple, don't pad a short answer with unneeded deliberation.\n\n**Memory first, always:** Before reaching for any tool, check what you already know from the saved memory in this prompt. Answer from memory whenever it's actually sufficient; don't re-fetch live data you already have a saved answer for. Memory is the default context source for this user, not a fallback for when tools are unavailable.\n\n**Web search: explicit request only.** Never call web_search or web_fetch unless the user actually asks you to look something up or search the web ("search for...", "look up...", "what's the latest on...", "check online"). Do not search proactively just because a fact could be stale or you're unsure, even on a question that sounds like it needs current info. If you don't know something and they haven't asked you to search, say what you know and ask if they want you to look it up, don't decide to search on your own.\n\n**Connected tools (Gmail, Drive, Docs, Sheets, Calendar, etc.): explicit request only.** Only call a connected tool when the message is actually asking you to check, find, send, update, or otherwise touch that account or workspace. Never call one speculatively to see if it has something relevant, and never call one because a past message implied you might eventually need to. If memory already answers the question, use memory instead of reaching for a live tool.\n\n**Tool choice: whether to use any tool at all:** Most messages need zero tools: greetings, opinions, brainstorming, explaining something you already know, general knowledge, casual conversation, and anything memory already answers. Answer those directly with no tool call. save_memory and save_note remain on their own explicit triggers described below; they are not part of this default-to-no-tool rule.\n\n**Confirmation rule:** Reversible actions do immediately (sheet updates, drafts, search). Trash: summarize and wait for the user to say yes in chat. Sending, replying, forwarding email and creating a calendar event with guests never happen from your call: once the content is final, call send_email, reply_email, forward_email or create_calendar_event (with attendees) once; the app then shows the user a Confirm card with exactly those fields and acts only when the user presses Confirm. You cannot confirm for them. Never say an email was sent or guests were invited unless a tool result says so; normally say it is waiting for their Confirm. An event without guests is created immediately.\n\n**Multi-step ops (sheets + email), once the user has actually asked for one:** Do not stall. Prefer the shortest tool path:\n1) search_sheets / search_drive to get spreadsheet_id\n2) read_sheet with range like "Master!A1:Z2" (or the named tab) to learn columns\n3) update_sheet with append:true and the same tab range (e.g. "Master!A:Z") mapping values in column order\n4) create_email_draft (not send) matching the user's requested style, then ask them to confirm send\nIf a tool errors, report it and continue with what you can. Never claim success without a successful tool_result.\n\n**Style (hard rules):**\n- Lead with outcomes. Clean Markdown in text mode. No pipe tables.\n- Never use em dashes (—) or en dashes (–) or double hyphens as dashes. Use commas, periods, colons, or parentheses instead.\n- Prefer short sentences over long clauses.\n- Code blocks must contain the literal plain text meant to be copied and run or pasted as-is. Never percent-encode, URL-encode, or otherwise transform text inside a code block.\n\n**Memory (critical):** Actively use every saved fact given to you in the user context below. Prefer memory over guessing, and prefer it over calling a tool to re-derive something already saved. When they share stable facts, call save_memory immediately without asking permission.\n\n**Learning how they work (behavior patterns):** Beyond stated facts, notice recurring patterns in how this user works with you, e.g. they always want a draft before sending, they consistently ask for short answers, they always check a specific sheet before anything else, they prefer a certain tone or format. Only save a pattern with save_memory (category "behavior") once you've genuinely seen it repeat, not from a single instance, and phrase it as an observation ("tends to prefer X"), not a rigid rule. These are visible and editable in Settings, so never invent one to sound adaptive, only save what you actually observed. Once saved, actually adapt: apply it without being asked again.\n\n**Notes (explicit trigger only, never guess):** save_note, list_notes, update_note, delete_note are unrelated to memory. Only call save_note when the user directly asks to save or add a note ("note this", "add a note:", "save this as a note") — never infer on your own that something is note-worthy the way you do for memory. Keep the note text short and concrete.\n- Project scoping is automatic: if they're inside a project, the note files under it without asking; only pass project explicitly to target a different one by name ("add a note to Tanzania: ..."). list_notes defaults the same way — inside a project it shows that project's notes plus global ones; pass project:"all" if they ask to see everything regardless of project.\n- Pick note_type from context: action_item for a to-do, trade_note for something tied to a specific deal/row, decision for a record of what was decided and why, alert for something the whole team should see. Default action_item if unclear.\n- Set due_date only if they give or imply one ("follow up by Friday", "due the 20th"). Set trade_ref when they mention a specific reference/row id, so it can be looked up later in a connected sheet with search_sheets/read_sheet. Set priority only if implied; default medium.\n- Set tags for short topic labels when the note clearly belongs to a topic worth grouping by later (e.g. "shipping", "payments"), not on every note. Set checklist when they describe a note as multiple steps or a list of things to do ("note this: 1) call the bank 2) get the SWIFT code 3) confirm with Shivaz"), one string per step; skip it for a single-item note. To add/change steps later, update_note with a new checklist array replaces the whole list.\n- "mark this done" / "dismiss that note" / "delete that note": use update_note or delete_note with the note_id from the most recent save_note or list_notes result for that note. If you don't have the id in context, call list_notes first to find it.\n- "escalate this to X": draft an email (create_email_draft) summarizing the note and its project/trade_ref, addressed per their instruction; confirm before send_email like any other outbound email. This does not change the note's status unless they also ask for that.\n- "show overdue notes": list_notes with overdue:true. "generate a notes summary" / "export notes": call list_notes with the right filter, then either answer inline, or build the summary into create_google_doc / create_email_draft if they ask for a doc or an email specifically.\n\n## Connected tools\n${toolLines.join('\n')}`;
}

/** Per-user, changes almost every request (memory grows constantly) — kept out of the cached static block on purpose. */
function buildDynamicContext({ memory, project, firstName }) {
  const memoryBlock =
    memory?.length > 0
      ? `## What you know about this user (use aggressively)\n${memory
          .map((m) => `- ${m.fact}${m.category ? ` (${m.category})` : ''}`)
          .join('\n')}\nThese facts are authoritative. Prefer them over generic advice. Reference them by name or detail when relevant. Never pretend you forgot them. When they share new stable personal, work, preference, or project facts, call save_memory immediately.`
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

/** Tags the last block of the last message so the growing prefix gets cached round to round. */
function withCacheBreakpoint(messages) {
  if (!messages?.length) return messages;
  const out = messages.slice(0, -1);
  const last = messages[messages.length - 1];
  let content = last.content;
  if (typeof content === 'string') {
    content = [{ type: 'text', text: content, cache_control: CACHE_CONTROL }];
  } else if (Array.isArray(content) && content.length) {
    content = content.map((b, i) => (i === content.length - 1 ? { ...b, cache_control: CACHE_CONTROL } : b));
  }
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

/** Static rules block is cache_control-tagged (stays cached across memory/project churn); dynamic per-user context is not, since it changes almost every request and tagging it would only add cache-write overhead for no reuse. */
function systemBlocks(system) {
  const blocks = [{ type: 'text', text: system.staticPrompt, cache_control: CACHE_CONTROL }];
  if (system.dynamicContext) blocks.push({ type: 'text', text: system.dynamicContext });
  return blocks;
}

async function runClaude({ apiKey, system, messages, tools, maxTokens = 4096 }) {
  const body = { model: MODEL, max_tokens: maxTokens, system: systemBlocks(system), messages: withCacheBreakpoint(messages) };
  if (tools?.length) body.tools = withToolsCacheBreakpoint(tools);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
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

async function runClaudeStream({ apiKey, system, messages, tools, onDelta, maxTokens = 4096 }) {
  const body = {
    model: MODEL,
    max_tokens: maxTokens,
    system: systemBlocks(system),
    messages: withCacheBreakpoint(messages),
    stream: true,
  };
  if (tools?.length) body.tools = withToolsCacheBreakpoint(tools);
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
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
      if (evt.type === 'content_block_start') {
        const b = evt.content_block;
        if (b?.type === 'text') contentBlocks.push({ type: 'text', text: '' });
        else if (b?.type === 'tool_use') {
          currentTool = { type: 'tool_use', id: b.id, name: b.name, input: '', partial_json: '' };
          contentBlocks.push(currentTool);
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
        }
      } else if (evt.type === 'content_block_stop') {
        if (currentTool) {
          try {
            currentTool.input = JSON.parse(currentTool.partial_json || '{}');
          } catch {
            currentTool.input = {};
          }
          delete currentTool.partial_json;
          currentTool = null;
        }
      } else if (evt.type === 'message_delta') {
        if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
      }
    }
  }
  const normalized = contentBlocks.map((b) => {
    if (b.type === 'tool_use') return { type: 'tool_use', id: b.id, name: b.name, input: b.input || {} };
    return b;
  });
  return { stop_reason: stopReason || 'end_turn', content: normalized, text: textAcc };
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
  res.setHeader('Access-Control-Allow-Origin', '*');
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
    const [connectorsResult, memoryResult, projectResult] = await Promise.all([
      loadConnectorsAndTools(user).catch(() => ({ connected, tools: [] })),
      user ? loadUserMemory(user.id) : Promise.resolve([]),
      user && body?.projectId ? loadProjectContext(user.id, body.projectId) : Promise.resolve(null),
    ]);
    connected = connectorsResult.connected;
    tools = connectorsResult.tools;
    memory = memoryResult;
    project = projectResult;

    const systemPrompt = {
      staticPrompt: buildStaticSystemPrompt({ connected }),
      dynamicContext: buildDynamicContext({ memory, project, firstName: body?.firstName || null }),
    };

    let anthropicMessages = trimHistory(
      messages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.role === 'assistant' ? String(m.content) : toAnthropicContent(m.content),
      }))
    );

    if (wantStream) {
      res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      if (typeof res.flushHeaders === 'function') res.flushHeaders();
      sseStarted = true;
      try { sseWrite(res, { status: 'started' }); } catch (_) {}
    }

    const maxRounds = 24;
    // Kept moderate on purpose: the auto-continuation loop below is what actually
    // guards against truncation now, so a very high single-shot ceiling here would
    // only inflate worst-case cost (ceiling x continuations) without helping.
    const maxTokens = 8192;
    const MAX_CONTINUATIONS = 2;
    let continuations = 0;
    let accumulatedText = '';

    for (let round = 0; round < maxRounds; round++) {
      let data;
      if (wantStream) {
        data = await runClaudeStream({
          apiKey,
          system: systemPrompt,
          messages: anthropicMessages,
          tools: tools.length ? tools : undefined,
          maxTokens,
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
        });
      }
      const content = data.content || [];
      const clientToolBlocks = content.filter((b) => b.type === 'tool_use' && b.name);
      if (clientToolBlocks.length === 0) {
        const textOut = (wantStream ? data.text : extractText(content)) || extractText(content) || '';
        accumulatedText += textOut;
        if (data.stop_reason === 'max_tokens' && continuations < MAX_CONTINUATIONS) {
          continuations += 1;
          anthropicMessages = [
            ...anthropicMessages,
            { role: 'assistant', content },
            {
              role: 'user',
              content:
                'Continue exactly where you left off, mid-sentence or mid-code-block if needed. Do not repeat anything already written, do not add any preamble or acknowledgement.',
            },
          ];
          continue;
        }
        const finalText = accumulatedText || 'Sorry, I could not generate a response.';
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
        if (wantStream) {
          sseWrite(res, { content: fallback });
          sseWrite(res, { done: true });
          res.write('data: [DONE]\n\n');
          return res.end();
        }
        return res.status(200).json({ content: fallback });
      }
      anthropicMessages.push({ role: 'user', content: toolResults });
    }
    const limitMsg = 'I reached the tool-step ceiling. Ask me to continue from where I left off.';
    if (wantStream) {
      sseWrite(res, { content: limitMsg });
      sseWrite(res, { done: true });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    return res.status(200).json({ content: limitMsg });
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
