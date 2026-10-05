/** Tool defs + execution for chat connectors */
import { randomUUID } from 'crypto';
import { guardIrreversible } from './sendGuard.js';
import { getAdminClient } from './supabaseAdmin.js';
import {
  getGoogleConfig,
  refreshAccessToken,
  searchGmail,
  searchDrive,
  readGoogleDoc,
  createGoogleDoc,
  appendGoogleDocText,
  searchSheets,
  readSheetRange,
  createSpreadsheet,
  updateSheetValues,
  sendGmail,
  createGmailDraft,
  modifyGmailMessage,
  trashGmailMessage,
  listCalendarEvents,
  createCalendarEvent,
} from './google.js';
import {
  replyGmail,
  forwardGmail,
  listGmailLabels,
  batchModifyGmail,
  getGmailMessage,
} from './gmailDeep.js';
import {
  getMicrosoftConfig,
  refreshMicrosoftToken,
  searchOutlook,
  searchExcelFiles,
} from './microsoft.js';
import { READ_DRIVE_FILE_TOOL, LIST_DRIVE_FOLDER_TOOL, handleReadDriveFile, handleListDriveFolder } from './driveRead.js';

/** Anthropic server-side tools — executed by Anthropic, not by us */
export const ANTHROPIC_WEB_SEARCH_TOOL = {
  type: 'web_search_20260209',
  name: 'web_search',
  max_uses: 5,
};

export const ANTHROPIC_WEB_FETCH_TOOL = {
  type: 'web_fetch_20260209',
  name: 'web_fetch',
  max_uses: 5,
};

export const GMAIL_TOOL = {
  name: 'search_gmail',
  description: 'Search the user Gmail inbox. Returns id, threadId, subject, from, snippet, body.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Gmail search query' },
      max_results: { type: 'number', description: '1-15, default 10' },
    },
    required: ['query'],
  },
};

export const SEND_EMAIL_TOOL = {
  name: 'send_email',
  description:
    'Send a new email from Gmail. Irreversible — only after the user explicitly confirmed To, Subject, and Body. Set user_confirmed=true only after confirmation.',
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Recipient email' },
      subject: { type: 'string', description: 'Subject line' },
      body: { type: 'string', description: 'Email body' },
      cc: { type: 'string' },
      bcc: { type: 'string' },
      user_confirmed: { type: 'boolean', description: 'Must be true after user confirmed send' },
      approval_token: { type: 'string', description: 'Server-issued approval for exactly these arguments (only when the app asks for it). Never invent one.' },
    },
    required: ['to', 'subject', 'body'],
  },
};

export const DRAFT_EMAIL_TOOL = {
  name: 'create_email_draft',
  description: 'Create a Gmail draft without sending.',
  input_schema: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      subject: { type: 'string' },
      body: { type: 'string' },
      cc: { type: 'string' },
      bcc: { type: 'string' },
    },
    required: ['to', 'subject', 'body'],
  },
};

export const REPLY_EMAIL_TOOL = {
  name: 'reply_email',
  description:
    'Reply to an existing Gmail message. Confirm body first; set user_confirmed=true after user agrees.',
  input_schema: {
    type: 'object',
    properties: {
      message_id: { type: 'string' },
      body: { type: 'string' },
      reply_all: { type: 'boolean' },
      cc: { type: 'string' },
      bcc: { type: 'string' },
      user_confirmed: { type: 'boolean' },
      approval_token: { type: 'string', description: 'Server-issued approval for exactly these arguments (only when the app asks for it). Never invent one.' },
    },
    required: ['message_id', 'body'],
  },
};

export const FORWARD_EMAIL_TOOL = {
  name: 'forward_email',
  description:
    'Forward a Gmail message. Confirm recipient first; set user_confirmed=true after user agrees.',
  input_schema: {
    type: 'object',
    properties: {
      message_id: { type: 'string' },
      to: { type: 'string' },
      body: { type: 'string' },
      cc: { type: 'string' },
      bcc: { type: 'string' },
      user_confirmed: { type: 'boolean' },
      approval_token: { type: 'string', description: 'Server-issued approval for exactly these arguments (only when the app asks for it). Never invent one.' },
    },
    required: ['message_id', 'to'],
  },
};

export const MODIFY_GMAIL_TOOL = {
  name: 'modify_gmail',
  description:
    'Archive, star, mark read/unread, or trash a Gmail message. action: archive | unarchive | star | unstar | read | unread | trash.',
  input_schema: {
    type: 'object',
    properties: {
      message_id: { type: 'string' },
      action: { type: 'string' },
      add_labels: { type: 'array', items: { type: 'string' } },
      remove_labels: { type: 'array', items: { type: 'string' } },
    },
    required: ['message_id', 'action'],
  },
};

export const LIST_LABELS_TOOL = {
  name: 'list_gmail_labels',
  description: 'List Gmail labels (system + user) with unread counts.',
  input_schema: { type: 'object', properties: {}, required: [] },
};

export const BULK_ARCHIVE_TOOL = {
  name: 'bulk_archive_gmail',
  description: 'Archive up to 50 Gmail messages by id. Confirm the set with the user first.',
  input_schema: {
    type: 'object',
    properties: {
      message_ids: { type: 'array', items: { type: 'string' } },
    },
    required: ['message_ids'],
  },
};

export const GET_MESSAGE_TOOL = {
  name: 'get_gmail_message',
  description: 'Fetch full details for one Gmail message by id.',
  input_schema: {
    type: 'object',
    properties: { message_id: { type: 'string' } },
    required: ['message_id'],
  },
};

export const DRIVE_TOOL = {
  name: 'search_drive',
  description: 'Search Google Drive by short keywords or folder/file name.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      max_results: { type: 'number' },
    },
    required: ['query'],
  },
};

export const DOCS_TOOL = {
  name: 'read_google_doc',
  description: 'Read a Google Doc by document ID.',
  input_schema: {
    type: 'object',
    properties: { document_id: { type: 'string' } },
    required: ['document_id'],
  },
};

export const CREATE_DOC_TOOL = {
  name: 'create_google_doc',
  description: 'Create a new Google Doc with optional body text.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      body: { type: 'string' },
    },
    required: ['title'],
  },
};

export const APPEND_DOC_TOOL = {
  name: 'append_google_doc',
  description: 'Append text to the end of an existing Google Doc.',
  input_schema: {
    type: 'object',
    properties: {
      document_id: { type: 'string' },
      text: { type: 'string' },
    },
    required: ['document_id', 'text'],
  },
};

export const SHEETS_LIST_TOOL = {
  name: 'search_sheets',
  description: 'List Google Spreadsheets.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      max_results: { type: 'number' },
    },
    required: ['query'],
  },
};

export const SHEETS_READ_TOOL = {
  name: 'read_sheet',
  description: 'Read cells from a spreadsheet.',
  input_schema: {
    type: 'object',
    properties: {
      spreadsheet_id: { type: 'string' },
      range: { type: 'string' },
    },
    required: ['spreadsheet_id'],
  },
};

export const CREATE_SHEET_TOOL = {
  name: 'create_spreadsheet',
  description: 'Create a new Google Spreadsheet with optional headers and rows.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      headers: { type: 'array', items: { type: 'string' } },
      rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    },
    required: ['title'],
  },
};

export const UPDATE_SHEET_TOOL = {
  name: 'update_sheet',
  description: 'Write or append values to a Google Spreadsheet.',
  input_schema: {
    type: 'object',
    properties: {
      spreadsheet_id: { type: 'string' },
      range: { type: 'string' },
      values: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
      append: { type: 'boolean' },
    },
    required: ['spreadsheet_id', 'values'],
  },
};

export const CALENDAR_TOOL = {
  name: 'list_calendar_events',
  description: 'List upcoming Google Calendar events.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      days_ahead: { type: 'number' },
      max_results: { type: 'number' },
    },
    required: [],
  },
};

export const CREATE_EVENT_TOOL = {
  name: 'create_calendar_event',
  description: 'Create a Google Calendar event. Confirm first if attendees are included.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      description: { type: 'string' },
      location: { type: 'string' },
      start: { type: 'string' },
      end: { type: 'string' },
      all_day: { type: 'boolean' },
      time_zone: { type: 'string' },
      attendees: { type: 'array', items: { type: 'string' } },
    },
    required: ['summary', 'start'],
  },
};

export const OUTLOOK_TOOL = {
  name: 'search_outlook',
  description: 'Search Microsoft Outlook mail.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      max_results: { type: 'number' },
    },
    required: ['query'],
  },
};

export const EXCEL_TOOL = {
  name: 'search_excel',
  description: 'Search OneDrive for Excel workbooks.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string' },
      max_results: { type: 'number' },
    },
    required: ['query'],
  },
};

export const SAVE_MEMORY_TOOL = {
  name: 'save_memory',
  description:
    'Save a lasting fact about the user, or a recurring behavioral pattern noticed across multiple interactions (e.g. always wants a draft before sending, prefers short answers, always checks the Master sheet first). Use category "behavior" for patterns, distinct from stated facts. These are visible and editable by the user in Settings, never hidden.',
  input_schema: {
    type: 'object',
    properties: {
      fact: { type: 'string' },
      category: { type: 'string', description: '"general", "preference", "instruction", "work", "people", "project", or "behavior" for a noticed interaction pattern' },
    },
    required: ['fact'],
  },
};

export const SAVE_NOTE_TOOL = {
  name: 'save_note',
  description:
    'Save a short, explicit note or action item. Only call this when the user directly asks to save/add a note (e.g. "add a note", "note this", "save this as a note"). Never infer or save a note on your own judgment; for facts about the user to remember and use unprompted, use save_memory instead. If the user is currently inside a project, the note is filed under it automatically; pass project only to explicitly save into a different project by name.',
  input_schema: {
    type: 'object',
    properties: {
      note: { type: 'string', description: 'The note text' },
      project: { type: 'string', description: 'Optional: file this note under a specific project by name, overriding the current active project' },
      note_type: { type: 'string', description: '"action_item" (default), "trade_note", "decision", or "alert"' },
      priority: { type: 'string', description: '"low", "medium" (default), or "high"' },
      due_date: { type: 'string', description: 'Optional ISO 8601 date/time this note is due or should be followed up by' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional short topic tags for grouping/filtering' },
      trade_ref: { type: 'string', description: 'Optional reference (e.g. a trade/row id) this note is about, for later lookup in a connected sheet' },
      checklist: { type: 'array', items: { type: 'string' }, description: 'Optional sub-steps to break this note into a checklist' },
    },
    required: ['note'],
  },
};

export const LIST_NOTES_TOOL = {
  name: 'list_notes',
  description:
    "List the user's saved notes. If the user is currently inside a project, defaults to that project's notes plus global notes; pass project to look at a different project by name, or \"all\" to ignore project scoping entirely.",
  input_schema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Filter to a specific project by name, or "all" for every project' },
      status: { type: 'string', description: '"open", "done", or "dismissed"; omit for all' },
      note_type: { type: 'string', description: 'Filter to "action_item", "trade_note", "decision", or "alert"' },
      overdue: { type: 'boolean', description: 'If true, only notes that are open and past their due_date' },
      tag: { type: 'string', description: 'Filter to notes carrying this tag' },
    },
    required: [],
  },
};

export const UPDATE_NOTE_TOOL = {
  name: 'update_note',
  description:
    'Update an existing note\'s status, priority, or due date — e.g. "mark this done", "dismiss that note". Needs the note_id from a prior save_note or list_notes result.',
  input_schema: {
    type: 'object',
    properties: {
      note_id: { type: 'string' },
      status: { type: 'string', description: '"open", "done", or "dismissed"' },
      priority: { type: 'string', description: '"low", "medium", or "high"' },
      due_date: { type: 'string', description: 'ISO 8601 date/time, or empty string to clear it' },
      checklist: { type: 'array', items: { type: 'string' }, description: 'Replaces the whole checklist with these steps, e.g. when the user asks to add or change checklist items' },
    },
    required: ['note_id'],
  },
};

export const DELETE_NOTE_TOOL = {
  name: 'delete_note',
  description: 'Delete a note. Needs the note_id from a prior save_note or list_notes result.',
  input_schema: {
    type: 'object',
    properties: {
      note_id: { type: 'string' },
    },
    required: ['note_id'],
  },
};

/**
 * Cheap connectivity probe for deciding which tools to offer — no refresh,
 * no write. Actual token validity/refresh happens in getValidToken(Microsoft)
 * at the moment a tool is invoked, which is the only place a usable access
 * token is actually needed.
 */
async function isConnectorActive(userId, provider) {
  const admin = getAdminClient();
  const { data } = await admin
    .from('connectors')
    .select('id')
    .eq('user_id', userId)
    .eq('provider', provider)
    .eq('status', 'connected')
    .maybeSingle();
  return !!data;
}

export async function getValidToken(userId, provider) {
  const admin = getAdminClient();
  const { data: connector } = await admin
    .from('connectors')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', provider)
    .eq('status', 'connected')
    .maybeSingle();
  if (!connector?.access_token) return null;
  const expires = connector.token_expires_at ? new Date(connector.token_expires_at).getTime() : 0;
  const needsRefresh = !expires || expires < Date.now() + 60_000;
  if (!needsRefresh) return connector.access_token;
  if (!connector.refresh_token) return connector.access_token;
  const { clientId, clientSecret } = getGoogleConfig();
  const refreshed = await refreshAccessToken({
    clientId,
    clientSecret,
    refreshToken: connector.refresh_token,
  });
  const tokenExpiresAt = refreshed.expires_in
    ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
    : null;
  await admin
    .from('connectors')
    .update({
      access_token: refreshed.access_token,
      token_expires_at: tokenExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', connector.id);
  return refreshed.access_token;
}

export async function getValidMicrosoftToken(userId, provider) {
  const admin = getAdminClient();
  const { data: connector } = await admin
    .from('connectors')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', provider)
    .eq('status', 'connected')
    .maybeSingle();
  if (!connector?.access_token) return null;
  const expires = connector.token_expires_at ? new Date(connector.token_expires_at).getTime() : 0;
  const needsRefresh = !expires || expires < Date.now() + 60_000;
  if (!needsRefresh) return connector.access_token;
  if (!connector.refresh_token) return connector.access_token;
  const { clientId, clientSecret, tenant } = getMicrosoftConfig();
  if (!clientId || !clientSecret) return connector.access_token;
  const refreshed = await refreshMicrosoftToken({
    clientId,
    clientSecret,
    refreshToken: connector.refresh_token,
    tenant,
  });
  const tokenExpiresAt = refreshed.expires_in
    ? new Date(Date.now() + refreshed.expires_in * 1000).toISOString()
    : null;
  await admin
    .from('connectors')
    .update({
      access_token: refreshed.access_token,
      token_expires_at: tokenExpiresAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', connector.id);
  return refreshed.access_token;
}

function gmailNotConnected(id) {
  return {
    type: 'tool_result',
    tool_use_id: id,
    content: 'Gmail is not connected.',
    is_error: true,
  };
}

/** Case-insensitive project lookup by name, scoped to the user. Returns { id, name } or null. */
async function resolveProjectByName(admin, userId, name) {
  const clean = String(name || '').trim();
  if (!clean) return null;
  const { data } = await admin
    .from('projects')
    .select('id, name')
    .eq('user_id', userId)
    .ilike('name', clean)
    .maybeSingle();
  return data || null;
}

export async function runTool(block, user, context = {}) {
  const id = block.id;
  const name = block.name;
  const input = block.input || {};
  try {
    if (name === 'search_gmail' && user) {
      const token = await getValidToken(user.id, 'gmail');
      if (!token) return gmailNotConnected(id);
      const results = await searchGmail(
        token,
        input.query || 'in:inbox newer_than:14d',
        Math.min(15, Math.max(1, Number(input.max_results) || 10))
      );
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({ count: results.length, messages: results }),
      };
    }
    if (name === 'get_gmail_message' && user) {
      const token = await getValidToken(user.id, 'gmail');
      if (!token) return gmailNotConnected(id);
      const msg = await getGmailMessage(token, String(input.message_id || ''));
      return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(msg) };
    }
    if (name === 'send_email' && user) {
      const blockedText = guardIrreversible(name, input, user);
      if (blockedText) return { type: 'tool_result', tool_use_id: id, is_error: true, content: blockedText };
      const token = await getValidToken(user.id, 'gmail');
      if (!token) return gmailNotConnected(id);
      const result = await sendGmail(token, {
        to: String(input.to || ''),
        subject: String(input.subject || ''),
        body: String(input.body || ''),
        cc: input.cc ? String(input.cc) : undefined,
        bcc: input.bcc ? String(input.bcc) : undefined,
      });
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({ sent: true, ...result }),
      };
    }
    if (name === 'create_email_draft' && user) {
      const token = await getValidToken(user.id, 'gmail');
      if (!token) return gmailNotConnected(id);
      const result = await createGmailDraft(token, {
        to: String(input.to || ''),
        subject: String(input.subject || ''),
        body: String(input.body || ''),
        cc: input.cc ? String(input.cc) : undefined,
        bcc: input.bcc ? String(input.bcc) : undefined,
      });
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({ drafted: true, ...result }),
      };
    }
    if (name === 'reply_email' && user) {
      const blockedText = guardIrreversible(name, input, user);
      if (blockedText) return { type: 'tool_result', tool_use_id: id, is_error: true, content: blockedText };
      const token = await getValidToken(user.id, 'gmail');
      if (!token) return gmailNotConnected(id);
      const result = await replyGmail(token, {
        messageId: String(input.message_id || ''),
        body: String(input.body || ''),
        replyAll: !!input.reply_all,
        cc: input.cc ? String(input.cc) : undefined,
        bcc: input.bcc ? String(input.bcc) : undefined,
      });
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({ replied: true, ...result }),
      };
    }
    if (name === 'forward_email' && user) {
      const blockedText = guardIrreversible(name, input, user);
      if (blockedText) return { type: 'tool_result', tool_use_id: id, is_error: true, content: blockedText };
      const token = await getValidToken(user.id, 'gmail');
      if (!token) return gmailNotConnected(id);
      const result = await forwardGmail(token, {
        messageId: String(input.message_id || ''),
        to: String(input.to || ''),
        body: input.body ? String(input.body) : undefined,
        cc: input.cc ? String(input.cc) : undefined,
        bcc: input.bcc ? String(input.bcc) : undefined,
      });
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({ forwarded: true, ...result }),
      };
    }
    if (name === 'modify_gmail' && user) {
      const token = await getValidToken(user.id, 'gmail');
      if (!token) return gmailNotConnected(id);
      const messageId = String(input.message_id || '');
      const action = String(input.action || '').toLowerCase();
      if (action === 'trash') {
        const result = await trashGmailMessage(token, messageId);
        return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) };
      }
      let addLabelIds = Array.isArray(input.add_labels) ? input.add_labels.map(String) : [];
      let removeLabelIds = Array.isArray(input.remove_labels)
        ? input.remove_labels.map(String)
        : [];
      if (action === 'archive') removeLabelIds = [...removeLabelIds, 'INBOX'];
      if (action === 'unarchive') addLabelIds = [...addLabelIds, 'INBOX'];
      if (action === 'star') addLabelIds = [...addLabelIds, 'STARRED'];
      if (action === 'unstar') removeLabelIds = [...removeLabelIds, 'STARRED'];
      if (action === 'read') removeLabelIds = [...removeLabelIds, 'UNREAD'];
      if (action === 'unread') addLabelIds = [...addLabelIds, 'UNREAD'];
      const result = await modifyGmailMessage(token, messageId, { addLabelIds, removeLabelIds });
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({ action, ...result }),
      };
    }
    if (name === 'list_gmail_labels' && user) {
      const token = await getValidToken(user.id, 'gmail');
      if (!token) return gmailNotConnected(id);
      const labels = await listGmailLabels(token);
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({ count: labels.length, labels }),
      };
    }
    if (name === 'bulk_archive_gmail' && user) {
      const token = await getValidToken(user.id, 'gmail');
      if (!token) return gmailNotConnected(id);
      const ids = Array.isArray(input.message_ids) ? input.message_ids : [];
      const result = await batchModifyGmail(token, ids, { removeLabelIds: ['INBOX'] });
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({ archived: true, ...result }),
      };
    }
    if (name === 'search_drive' && user) {
      const token =
        (await getValidToken(user.id, 'google_drive')) ||
        (await getValidToken(user.id, 'google_docs'));
      if (!token)
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Google Drive is not connected.',
          is_error: true,
        };
      const results = await searchDrive(
        token,
        input.query || '',
        Math.min(15, Math.max(1, Number(input.max_results) || 10))
      );
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({ count: results.length, files: results }),
      };
    }
    if (name === 'read_drive_file' && user) {
      return handleReadDriveFile(block, user, getValidToken);
    }
    if (name === 'list_drive_folder' && user) {
      return handleListDriveFolder(block, user, getValidToken);
    }
    if (name === 'read_google_doc' && user) {
      const token =
        (await getValidToken(user.id, 'google_docs')) ||
        (await getValidToken(user.id, 'google_drive'));
      if (!token)
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Google Docs is not connected.',
          is_error: true,
        };
      const doc = await readGoogleDoc(token, String(input.document_id || ''));
      return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(doc) };
    }
    if (name === 'create_google_doc' && user) {
      const token = await getValidToken(user.id, 'google_docs');
      if (!token)
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Google Docs is not connected. Reconnect with write access.',
          is_error: true,
        };
      const result = await createGoogleDoc(token, {
        title: String(input.title || 'Untitled'),
        body: input.body ? String(input.body) : undefined,
      });
      return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) };
    }
    if (name === 'append_google_doc' && user) {
      const token = await getValidToken(user.id, 'google_docs');
      if (!token)
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Google Docs is not connected.',
          is_error: true,
        };
      const result = await appendGoogleDocText(
        token,
        String(input.document_id || ''),
        String(input.text || '')
      );
      return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) };
    }
    if (name === 'search_sheets' && user) {
      const token = await getValidToken(user.id, 'google_sheets');
      if (!token)
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Google Sheets is not connected.',
          is_error: true,
        };
      const results = await searchSheets(
        token,
        input.query || '',
        Math.min(15, Math.max(1, Number(input.max_results) || 8))
      );
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({ count: results.length, spreadsheets: results }),
      };
    }
    if (name === 'read_sheet' && user) {
      const token = await getValidToken(user.id, 'google_sheets');
      if (!token)
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Google Sheets is not connected.',
          is_error: true,
        };
      const data = await readSheetRange(
        token,
        String(input.spreadsheet_id || ''),
        input.range || 'A1:Z30'
      );
      return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(data) };
    }
    if (name === 'create_spreadsheet' && user) {
      const token = await getValidToken(user.id, 'google_sheets');
      if (!token)
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Google Sheets is not connected. Reconnect with write access.',
          is_error: true,
        };
      const result = await createSpreadsheet(token, {
        title: String(input.title || 'Untitled'),
        headers: input.headers,
        rows: input.rows,
      });
      return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) };
    }
    if (name === 'update_sheet' && user) {
      const token = await getValidToken(user.id, 'google_sheets');
      if (!token)
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Google Sheets is not connected.',
          is_error: true,
        };
      const result = await updateSheetValues(token, {
        spreadsheetId: String(input.spreadsheet_id || ''),
        range: input.range || 'A1',
        values: input.values || [],
        append: !!input.append,
      });
      return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) };
    }
    if (name === 'list_calendar_events' && user) {
      const token = await getValidToken(user.id, 'google_calendar');
      if (!token)
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: JSON.stringify({ count: 0, error: 'Google Calendar is not connected.' }),
          is_error: true,
        };
      const days = Math.min(30, Math.max(1, Number(input.days_ahead) || 7));
      const max = Math.min(25, Math.max(1, Number(input.max_results) || 15));
      const events = await listCalendarEvents(token, {
        timeMin: new Date().toISOString(),
        timeMax: new Date(Date.now() + days * 86400000).toISOString(),
        maxResults: max,
        query: input.query || undefined,
      });
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({ count: events.length, days_ahead: days, events }),
      };
    }
    if (name === 'create_calendar_event' && user) {
      const token = await getValidToken(user.id, 'google_calendar');
      if (!token)
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Google Calendar is not connected. Reconnect with write access.',
          is_error: true,
        };
      const result = await createCalendarEvent(token, {
        summary: String(input.summary || ''),
        description: input.description ? String(input.description) : undefined,
        location: input.location ? String(input.location) : undefined,
        start: String(input.start || ''),
        end: input.end ? String(input.end) : undefined,
        allDay: !!input.all_day,
        timeZone: input.time_zone ? String(input.time_zone) : undefined,
        attendees: Array.isArray(input.attendees) ? input.attendees : undefined,
      });
      return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) };
    }
    if (name === 'search_outlook' && user) {
      const token = await getValidMicrosoftToken(user.id, 'outlook');
      if (!token)
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Outlook is not connected.',
          is_error: true,
        };
      const results = await searchOutlook(
        token,
        input.query || '',
        Math.min(15, Math.max(1, Number(input.max_results) || 10))
      );
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({ count: results.length, messages: results }),
      };
    }
    if (name === 'search_excel' && user) {
      const token = await getValidMicrosoftToken(user.id, 'excel');
      if (!token)
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Excel / OneDrive is not connected.',
          is_error: true,
        };
      const results = await searchExcelFiles(
        token,
        input.query || '',
        Math.min(15, Math.max(1, Number(input.max_results) || 10))
      );
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({ count: results.length, files: results }),
      };
    }
    if (name === 'save_memory' && user) {
      const fact = String(input.fact || '').trim();
      if (!fact)
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Empty fact; nothing saved.',
          is_error: true,
        };
      const admin = getAdminClient();
      await admin.from('user_memory').insert({
        user_id: user.id,
        fact,
        category: input.category || 'general',
        source: 'chat',
      });
      return { type: 'tool_result', tool_use_id: id, content: `Saved memory: ${fact}` };
    }
    if (name === 'save_note' && user) {
      const note = String(input.note || '').trim();
      if (!note)
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Empty note; nothing saved.',
          is_error: true,
        };
      const admin = getAdminClient();
      let projectId = null;
      let projectName = null;
      if (input.project) {
        const resolved = await resolveProjectByName(admin, user.id, input.project);
        if (resolved) {
          projectId = resolved.id;
          projectName = resolved.name;
        } else {
          projectName = String(input.project).trim();
        }
      } else if (context.projectId) {
        projectId = context.projectId;
        projectName = context.projectName || null;
      }
      const noteType = ['action_item', 'trade_note', 'decision', 'alert'].includes(input.note_type)
        ? input.note_type
        : 'action_item';
      const priority = ['low', 'medium', 'high'].includes(input.priority) ? input.priority : 'medium';
      const dueDate = input.due_date ? new Date(input.due_date).toISOString() : null;
      const tags = Array.isArray(input.tags) ? input.tags.map(String).slice(0, 10) : null;
      const checklist = Array.isArray(input.checklist)
        ? input.checklist
            .map((t) => String(t).trim())
            .filter(Boolean)
            .slice(0, 30)
            .map((text) => ({ id: randomUUID(), text, done: false }))
        : [];
      const { data, error } = await admin
        .from('notes')
        .insert({
          user_id: user.id,
          note,
          project: projectName,
          project_id: projectId,
          note_type: noteType,
          priority,
          due_date: dueDate,
          tags,
          trade_ref: input.trade_ref ? String(input.trade_ref).trim() : null,
          checklist,
        })
        .select()
        .single();
      if (error)
        return { type: 'tool_result', tool_use_id: id, content: `Could not save note: ${error.message}`, is_error: true };
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: `Saved note (id ${data.id})${data.project ? ` [${data.project}]` : ''}: ${data.note}`,
      };
    }
    if (name === 'list_notes' && user) {
      const admin = getAdminClient();
      let query = admin.from('notes').select('*').eq('user_id', user.id).order('created_at', { ascending: false });

      const wantsAll = typeof input.project === 'string' && input.project.trim().toLowerCase() === 'all';
      if (input.project && !wantsAll) {
        const resolved = await resolveProjectByName(admin, user.id, input.project);
        query = resolved ? query.eq('project_id', resolved.id) : query.ilike('project', `%${String(input.project).trim()}%`);
      } else if (!wantsAll && context.projectId) {
        query = query.or(`project_id.eq.${context.projectId},project_id.is.null`);
      }

      if (input.status) query = query.eq('status', String(input.status).trim());
      if (input.note_type) query = query.eq('note_type', String(input.note_type).trim());
      if (input.tag) query = query.contains('tags', [String(input.tag).trim()]);
      if (input.overdue) query = query.eq('status', 'open').lt('due_date', new Date().toISOString());

      const { data, error } = await query.limit(100);
      if (error)
        return { type: 'tool_result', tool_use_id: id, content: `Could not list notes: ${error.message}`, is_error: true };
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({ count: data?.length || 0, notes: data || [] }),
      };
    }
    if (name === 'update_note' && user) {
      const noteId = String(input.note_id || '').trim();
      if (!noteId)
        return { type: 'tool_result', tool_use_id: id, content: 'note_id is required.', is_error: true };
      const patch = { updated_at: new Date().toISOString() };
      if (input.status && ['open', 'done', 'dismissed'].includes(input.status)) patch.status = input.status;
      if (input.priority && ['low', 'medium', 'high'].includes(input.priority)) patch.priority = input.priority;
      if (input.due_date !== undefined) patch.due_date = input.due_date ? new Date(input.due_date).toISOString() : null;
      if (Array.isArray(input.checklist)) {
        patch.checklist = input.checklist
          .map((t) => String(t).trim())
          .filter(Boolean)
          .slice(0, 30)
          .map((text) => ({ id: randomUUID(), text, done: false }));
      }
      const admin = getAdminClient();
      const { data, error } = await admin
        .from('notes')
        .update(patch)
        .eq('id', noteId)
        .eq('user_id', user.id)
        .select()
        .maybeSingle();
      if (error)
        return { type: 'tool_result', tool_use_id: id, content: `Could not update note: ${error.message}`, is_error: true };
      if (!data)
        return { type: 'tool_result', tool_use_id: id, content: 'No note found with that id.', is_error: true };
      return { type: 'tool_result', tool_use_id: id, content: `Updated note: ${data.note} (status: ${data.status})` };
    }
    if (name === 'delete_note' && user) {
      const noteId = String(input.note_id || '').trim();
      if (!noteId)
        return { type: 'tool_result', tool_use_id: id, content: 'note_id is required.', is_error: true };
      const admin = getAdminClient();
      const { error, count } = await admin
        .from('notes')
        .delete({ count: 'exact' })
        .eq('id', noteId)
        .eq('user_id', user.id);
      if (error)
        return { type: 'tool_result', tool_use_id: id, content: `Could not delete note: ${error.message}`, is_error: true };
      if (!count)
        return { type: 'tool_result', tool_use_id: id, content: 'No note found with that id.', is_error: true };
      return { type: 'tool_result', tool_use_id: id, content: 'Note deleted.' };
    }
    return {
      type: 'tool_result',
      tool_use_id: id,
      content: `Unknown tool: ${name}`,
      is_error: true,
    };
  } catch (e) {
    const status = e?.status || e?.code || '';
    const msg = e?.message || String(e);
    return {
      type: 'tool_result',
      tool_use_id: id,
      is_error: true,
      content: `API Error${status ? ` (${status})` : ''}: ${msg}. If auth failed, ask the user to reconnect in Settings.`,
    };
  }
}

export async function loadConnectorsAndTools(user) {
  const connected = {
    gmail: false,
    drive: false,
    docs: false,
    sheets: false,
    calendar: false,
    outlook: false,
    excel: false,
  };
  const tools = [
    ANTHROPIC_WEB_SEARCH_TOOL,
    ANTHROPIC_WEB_FETCH_TOOL,
    SAVE_MEMORY_TOOL,
    SAVE_NOTE_TOOL,
    LIST_NOTES_TOOL,
    UPDATE_NOTE_TOOL,
    DELETE_NOTE_TOOL,
  ];
  if (!user) return { connected, tools };

  const [gmailTok, driveTok, docsTok, sheetsTok, calTok, outlookTok, excelTok] = await Promise.all([
    isConnectorActive(user.id, 'gmail'),
    isConnectorActive(user.id, 'google_drive'),
    isConnectorActive(user.id, 'google_docs'),
    isConnectorActive(user.id, 'google_sheets'),
    isConnectorActive(user.id, 'google_calendar'),
    isConnectorActive(user.id, 'outlook'),
    isConnectorActive(user.id, 'excel'),
  ]);

  if (gmailTok) {
    connected.gmail = true;
    tools.push(
      GMAIL_TOOL,
      GET_MESSAGE_TOOL,
      SEND_EMAIL_TOOL,
      DRAFT_EMAIL_TOOL,
      REPLY_EMAIL_TOOL,
      FORWARD_EMAIL_TOOL,
      MODIFY_GMAIL_TOOL,
      LIST_LABELS_TOOL,
      BULK_ARCHIVE_TOOL
    );
  }
  if (driveTok) {
    connected.drive = true;
    tools.push(DRIVE_TOOL, READ_DRIVE_FILE_TOOL, LIST_DRIVE_FOLDER_TOOL);
  }
  if (docsTok) {
    connected.docs = true;
    tools.push(DOCS_TOOL, CREATE_DOC_TOOL, APPEND_DOC_TOOL);
    if (!connected.drive) {
      connected.drive = true;
      tools.push(DRIVE_TOOL, READ_DRIVE_FILE_TOOL, LIST_DRIVE_FOLDER_TOOL);
    }
  }
  if (sheetsTok) {
    connected.sheets = true;
    tools.push(SHEETS_LIST_TOOL, SHEETS_READ_TOOL, CREATE_SHEET_TOOL, UPDATE_SHEET_TOOL);
  }
  if (calTok) {
    connected.calendar = true;
    tools.push(CALENDAR_TOOL, CREATE_EVENT_TOOL);
  }
  if (outlookTok) {
    connected.outlook = true;
    tools.push(OUTLOOK_TOOL);
  }
  if (excelTok) {
    connected.excel = true;
    tools.push(EXCEL_TOOL);
  }
  return { connected, tools };
}
