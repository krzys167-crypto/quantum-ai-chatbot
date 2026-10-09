/** Tool defs + execution for chat connectors */
import { randomUUID } from 'crypto';
import { getAdminClient } from './supabaseAdmin.js';
import { getValidConnectorToken } from './connectorTokens.js';
import {
  getGoogleConfig,
  refreshAccessToken,
  searchGmail,
  searchDrive,
  readGoogleDoc,
  createGoogleDoc,
  appendGoogleDocText,
  findDriveFolders,
  moveFileToFolder,
  searchSheets,
  readSheetRange,
  createSpreadsheet,
  updateSheetValues,
  readSheetNotes,
  setSheetNote,
  listFileComments,
  createFileComment,
  replyToFileComment,
  sendGmail,
  createGmailDraft,
  modifyGmailMessage,
  trashGmailMessage,
  listCalendarEvents,
  createCalendarEvent,
  updateCalendarEvent,
  deleteCalendarEvent,
  uploadDriveFile,
} from './google.js';
import { generateExecutivePdf } from './pdfGenerator.js';
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
import { terms as termsOf } from './memoryRetrieval.js';

/**
 * The longest a single saved fact may be.
 *
 * Facts are matched against the conversation and injected into prompts, so
 * length is a recurring cost, not a one-off storage one. The existing store
 * has facts of 3,342 and 5,330 characters; at that size one fact is most of a
 * memory block on its own.
 */
const MAX_FACT_CHARS = 800;
import {
  SHEET_HISTORY_TOOLS,
  SHEET_HISTORY_TOOL_NAMES,
  handleSheetHistoryTool,
  captureValuesBefore,
  recordSheetEdit,
} from './sheetHistory.js';

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
  description:
    'Read a Google Doc by document ID. Long documents come back in pages: if the result has truncated=true, read again with offset=next_offset to continue. Never treat a truncated result as the end of the document.',
  input_schema: {
    type: 'object',
    properties: {
      document_id: { type: 'string' },
      offset: { type: 'integer', description: 'Character offset to start from. Use next_offset from a truncated result.' },
      max_chars: { type: 'integer', description: 'Max characters to return (default 80000).' },
    },
    required: ['document_id'],
  },
};

export const CREATE_DOC_TOOL = {
  name: 'create_google_doc',
  description:
    'Create a new Google Doc with styled formatting (headings #/##/###, bold text, bullet lists, quotes). By default it lands in My Drive; pass folder_id, or folder_name to file it into a Drive folder. Use Markdown in body to automatically produce formatted headings, bullet lists, and styling.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Document title' },
      body: { type: 'string', description: 'Document body in Markdown format (# Heading 1, ## Heading 2, - bullets, **bold**)' },
      folder_id: { type: 'string', description: 'Drive folder id, if already known.' },
      folder_name: {
        type: 'string',
        description: 'Folder name to look up instead of an id. If several match, the doc is left in My Drive and matches are returned.',
      },
    },
    required: ['title'],
  },
};

export const GENERATE_PDF_TOOL = {
  name: 'generate_pdf_document',
  description:
    'Generate an executive-grade, polished PDF document or report. Features cover banner, status badge, metadata, optional KPI summary metric cards, summary callout box, styled data tables with alternating row shading, and dynamic headers/footers with page numbers. If Google Drive is connected, it automatically saves to Drive and returns the link. Also provides an instant chat download link.',
  input_schema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Document title' },
      subtitle: { type: 'string', description: 'Subtitle or brief description' },
      author: { type: 'string', description: 'Author or organization' },
      date: { type: 'string', description: 'Document date string' },
      status_badge: { type: 'string', description: 'Header status badge, e.g. "CONFIDENTIAL", "EXECUTIVE SUMMARY", "FINAL"' },
      theme: { type: 'string', enum: ['navy', 'emerald', 'charcoal'], description: 'Visual color theme (default "navy")' },
      summary_box: { type: 'string', description: 'Executive summary or key highlights callout box' },
      metrics: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            label: { type: 'string', description: 'Metric label (e.g. "Total Revenue")' },
            value: { type: 'string', description: 'Metric value (e.g. "$1.2M")' },
          },
          required: ['label', 'value'],
        },
        description: 'Up to 4 key KPI metric cards',
      },
      sections: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Section title' },
            content: { type: 'string', description: 'Paragraph text' },
            bullets: { type: 'array', items: { type: 'string' }, description: 'Bullet points' },
            table: {
              type: 'object',
              properties: {
                headers: { type: 'array', items: { type: 'string' } },
                rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
              },
            },
          },
          required: ['title'],
        },
        description: 'Document sections with content, bullet lists, and tables',
      },
      folder_name: { type: 'string', description: 'Optional Drive folder name to file into' },
      folder_id: { type: 'string', description: 'Optional Drive folder ID to file into' },
    },
    required: ['title', 'sections'],
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
  description:
    'Read cells from a spreadsheet. Defaults to a wide range (A1:BZ2000), so omit range unless you need a specific block. Large sheets come back in pages: if the result has truncated=true, read again with offset=next_offset to continue. Never conclude the sheet ends at the last row shown — check truncated first.',
  input_schema: {
    type: 'object',
    properties: {
      spreadsheet_id: { type: 'string' },
      range: { type: 'string', description: 'A1 notation, e.g. "Sheet1!A1:Z500". Defaults to A1:BZ2000.' },
      offset: { type: 'integer', description: 'Row offset within the range. Use next_offset from a truncated result.' },
      max_rows: { type: 'integer', description: 'Max rows to return (default/max 1000).' },
      max_chars: { type: 'integer', description: 'Max characters to return (default 80000).' },
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
  description:
    'Write or append values to a Google Spreadsheet. The cells being replaced are recorded first, ' +
    'so the result carries an undo_id and the change can be reversed with undo_sheet_edit. Mention ' +
    'that undo is available when a write replaces existing data.',
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

export const READ_NOTES_TOOL = {
  name: 'read_sheet_notes',
  description:
    'Read the in-cell notes on a Google Sheet — the plain note attached to a cell, shown as a small ' +
    'corner marker. These are NOT comments: notes have no author and no replies, and a sheet can carry ' +
    'both independently. Use read_file_comments for comment threads. Returns each note with its cell ' +
    'reference and the cell value. Pass range to look at one tab or block instead of the whole file.',
  input_schema: {
    type: 'object',
    properties: {
      spreadsheet_id: { type: 'string' },
      range: { type: 'string', description: 'A1 range to limit the scan, e.g. Positions or Positions!A1:H50. Optional.' },
      max_results: { type: 'number', description: '1-200, default 100.' },
    },
    required: ['spreadsheet_id'],
  },
};

export const SET_NOTE_TOOL = {
  name: 'set_sheet_note',
  description:
    'Write or clear the in-cell note on one Google Sheet cell. Replaces whatever note is there, so ' +
    'read it first if it should be kept. The cell value and formatting are untouched. Pass an empty ' +
    'note to clear it. This writes to a shared file, so confirm the cell and wording with the user first. ' +
    'The previous note is recorded, so this can be reversed with undo_sheet_edit.',
  input_schema: {
    type: 'object',
    properties: {
      spreadsheet_id: { type: 'string' },
      cell: { type: 'string', description: 'A single cell, e.g. B12 or Positions!B12. Defaults to the first tab if no tab is named.' },
      note: { type: 'string', description: 'Note text. Empty string clears the note.' },
    },
    required: ['spreadsheet_id', 'cell', 'note'],
  },
};

export const READ_COMMENTS_TOOL = {
  name: 'read_file_comments',
  description:
    'Read the comments on a Google Sheet or Doc by file id. Returns each comment with its author, ' +
    'text, whether it is resolved, any replies, and the cell or passage it is attached to when the ' +
    'file records one. Resolved comments are left out unless asked for. Get the file id from ' +
    'search_sheets, search_drive or list_drive_folder.',
  input_schema: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'Spreadsheet or document id.' },
      include_resolved: { type: 'boolean', description: 'Include comments already resolved. Default false.' },
      max_results: { type: 'number', description: '1-100, default 30.' },
    },
    required: ['file_id'],
  },
};

export const ADD_COMMENT_TOOL = {
  name: 'add_file_comment',
  description:
    'Post a comment on a Google Sheet or Doc. Everyone with access sees it, so confirm the wording ' +
    'with the user first. Pass cell to name the cell or range it concerns, such as B12 or ' +
    'Positions!C4:C9, and it is written into the comment text. Google does not let the API pin a ' +
    'comment to a cell the way the Sheets UI does, so it lands as a file-level comment naming the cell.',
  input_schema: {
    type: 'object',
    properties: {
      file_id: { type: 'string' },
      comment: { type: 'string', description: 'The comment text.' },
      cell: { type: 'string', description: 'Cell or range the comment is about. Optional.' },
    },
    required: ['file_id', 'comment'],
  },
};

export const REPLY_COMMENT_TOOL = {
  name: 'reply_to_file_comment',
  description:
    'Reply to an existing comment on a Google Sheet or Doc, and optionally mark it resolved. ' +
    'Get comment_id from read_file_comments. Replies are visible to everyone with access, so ' +
    'confirm the wording first. Resolving hides the thread from the default view.',
  input_schema: {
    type: 'object',
    properties: {
      file_id: { type: 'string' },
      comment_id: { type: 'string', description: 'Comment id from read_file_comments.' },
      reply: { type: 'string', description: 'Reply text.' },
      resolve: { type: 'boolean', description: 'Mark the thread resolved. Default false.' },
    },
    required: ['file_id', 'comment_id'],
  },
};

export const CALENDAR_TOOL = {
  name: 'list_calendar_events',
  description:
    'List Google Calendar events. Returns each event id, which is required to update or cancel it. ' +
    'Use days_back to include events that have already started (a window that is running now, or one that just closed).',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Free-text match on title, description, location or attendee.' },
      days_ahead: { type: 'number', description: 'How far forward to look. Default 7, max 30.' },
      days_back: { type: 'number', description: 'How far back to look. Default 0, max 30.' },
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

export const UPDATE_EVENT_TOOL = {
  name: 'update_calendar_event',
  description:
    'Change an existing Google Calendar event: move it, rename it, or amend its guest list. ' +
    'Get event_id from list_calendar_events first. Only the fields you pass are changed; everything else is left alone. ' +
    'Moving an event by passing only "start" keeps its original duration, so use that to shift a deadline or a loading window. ' +
    'Guests are emailed about the change automatically when the event has any. ' +
    'For a repeating event, the id from list_calendar_events points at one occurrence, so only that occurrence moves. ' +
    'Confirm with the user before changing an event that has attendees.',
  input_schema: {
    type: 'object',
    properties: {
      event_id: { type: 'string', description: 'Event id from list_calendar_events.' },
      summary: { type: 'string', description: 'New title.' },
      description: { type: 'string' },
      location: { type: 'string' },
      start: { type: 'string', description: 'New start, ISO 8601. Alone, it moves the event and keeps its length.' },
      end: { type: 'string', description: 'New end, ISO 8601. For all-day events this is exclusive: the day after the last day.' },
      all_day: { type: 'boolean', description: 'Convert between timed and all-day. Omit to keep it as it is.' },
      time_zone: { type: 'string', description: 'IANA zone, e.g. Asia/Dubai. Defaults to the event\'s existing zone.' },
      attendees: {
        type: 'array',
        items: { type: 'string' },
        description: 'Replaces the whole guest list. Prefer add_attendees/remove_attendees, which leave existing RSVPs intact.',
      },
      add_attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses to invite, keeping current guests.' },
      remove_attendees: { type: 'array', items: { type: 'string' }, description: 'Email addresses to uninvite.' },
      notify: { type: 'boolean', description: 'Force guest emails on or off. Defaults to on when the event has guests.' },
    },
    required: ['event_id'],
  },
};

export const DELETE_EVENT_TOOL = {
  name: 'delete_calendar_event',
  description:
    'Cancel and remove a Google Calendar event. Get event_id from list_calendar_events first. ' +
    'This cannot be undone, and guests are emailed the cancellation. ' +
    'Always confirm with the user, naming the event and its date, before calling this.',
  input_schema: {
    type: 'object',
    properties: {
      event_id: { type: 'string', description: 'Event id from list_calendar_events.' },
      notify: { type: 'boolean', description: 'Force cancellation emails on or off. Defaults to on when the event has guests.' },
    },
    required: ['event_id'],
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

/**
 * The escape hatch for topic-filtered memory.
 *
 * Only the facts matching the current topic are put in the prompt (see
 * lib/memoryRetrieval.js). Without a way to reach the rest, filtering would
 * turn "I don't have that in the prompt" into "I never knew that", which is
 * the exact failure the honesty rules exist to prevent. This searches the
 * whole store, so nothing saved is ever actually unreachable.
 */
export const RECALL_MEMORY_TOOL = {
  name: 'recall_memory',
  description:
    'Search everything saved about this user, including facts not shown in the prompt. The prompt only carries the saved facts that matched the current topic, so call this whenever the user refers to something they told you before that you cannot see, asks what you remember, or asks about a person, project, or system you have no fact about in front of you. Prefer this over saying you do not remember.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Words to search for, e.g. a project, person, or system name. Omit to list everything saved.' },
    },
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
  const { clientId, clientSecret } = getGoogleConfig();
  return getValidConnectorToken({
    admin: getAdminClient(),
    userId,
    provider,
    refresh: (refreshToken) => refreshAccessToken({ clientId, clientSecret, refreshToken }),
  });
}

export async function getValidMicrosoftToken(userId, provider) {
  const { clientId, clientSecret, tenant } = getMicrosoftConfig();
  return getValidConnectorToken({
    admin: getAdminClient(),
    userId,
    provider,
    refresh:
      clientId && clientSecret
        ? (refreshToken) => refreshMicrosoftToken({ clientId, clientSecret, refreshToken, tenant })
        : null,
  });
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
      const msg = await getGmailMessage(token, String(input.message_id || ''), {
        maxBodyChars: 40_000,
      });
      return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(msg) };
    }
    if (name === 'send_email' && user) {
      if (input.user_confirmed !== true) {
        return {
          type: 'tool_result',
          tool_use_id: id,
          is_error: true,
          content:
            'Send blocked: user_confirmed must be true. Confirm To/Subject/Body with the user first, then call send_email with user_confirmed=true. Prefer create_email_draft if unconfirmed.',
        };
      }
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
      if (input.user_confirmed !== true) {
        return {
          type: 'tool_result',
          tool_use_id: id,
          is_error: true,
          content: 'Reply blocked: user_confirmed must be true. Confirm the reply with the user first.',
        };
      }
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
      if (input.user_confirmed !== true) {
        return {
          type: 'tool_result',
          tool_use_id: id,
          is_error: true,
          content: 'Forward blocked: user_confirmed must be true. Confirm recipient with the user first.',
        };
      }
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
      const doc = await readGoogleDoc(token, String(input.document_id || ''), {
        offset: input.offset,
        max_chars: input.max_chars,
      });
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

      const wantsFolder = input.folder_id || input.folder_name;
      if (wantsFolder && result?.documentId) {
        // Folder lookup and the move both need the full `drive` scope; a
        // google_docs token only has drive.file and cannot see folders it
        // didn't create. Never fail the whole call over filing — the doc
        // already exists, so report where it ended up instead.
        const driveToken = await getValidToken(user.id, 'google_drive');
        try {
          if (!driveToken) {
            return {
              type: 'tool_result',
              tool_use_id: id,
              content: JSON.stringify({
                ...result,
                filed: false,
                reason: 'Google Drive is not connected, so the doc was left in My Drive. Connect Drive to file documents into folders.',
              }),
            };
          }

          let folderId = input.folder_id ? String(input.folder_id) : null;
          let folderName = input.folder_name ? String(input.folder_name) : null;

          if (!folderId && folderName) {
            const matches = await findDriveFolders(driveToken, folderName);
            if (matches.length === 0) {
              return {
                type: 'tool_result',
                tool_use_id: id,
                content: JSON.stringify({
                  ...result,
                  filed: false,
                  reason: `No Drive folder matching "${folderName}". The doc is in My Drive. Ask the user which folder to use, or create one.`,
                }),
              };
            }
            if (matches.length > 1) {
              return {
                type: 'tool_result',
                tool_use_id: id,
                content: JSON.stringify({
                  ...result,
                  filed: false,
                  reason: `Several folders match "${folderName}". The doc is in My Drive — ask the user which one, then move it with folder_id.`,
                  folder_matches: matches,
                }),
              };
            }
            folderId = matches[0].id;
            folderName = matches[0].name;
          }

          const moved = await moveFileToFolder(driveToken, result.documentId, folderId);
          return {
            type: 'tool_result',
            tool_use_id: id,
            content: JSON.stringify({
              ...result,
              filed: true,
              folder_id: folderId,
              folder_name: folderName || undefined,
              parents: moved.parents,
            }),
          };
        } catch (e) {
          return {
            type: 'tool_result',
            tool_use_id: id,
            content: JSON.stringify({
              ...result,
              filed: false,
              reason: `Doc created but could not be filed: ${e?.message || String(e)}`,
            }),
          };
        }
      }

      return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) };
    }
    if (name === 'generate_pdf_document') {
      const pdfBuffer = await generateExecutivePdf({
        title: input.title,
        subtitle: input.subtitle,
        author: input.author || (user?.email ? user.email.split('@')[0] : 'Quantum AI Workspace'),
        date: input.date,
        statusBadge: input.status_badge || 'CONFIDENTIAL',
        theme: input.theme || 'navy',
        summaryBox: input.summary_box,
        metrics: input.metrics,
        sections: input.sections,
      });

      let driveResult = null;
      const driveToken = user
        ? (await getValidToken(user.id, 'google_drive')) || (await getValidToken(user.id, 'google_docs'))
        : null;

      if (driveToken && user) {
        try {
          let folderId = input.folder_id ? String(input.folder_id) : null;
          const folderName = input.folder_name ? String(input.folder_name) : null;

          if (!folderId && folderName) {
            const matches = await findDriveFolders(driveToken, folderName);
            if (matches.length > 0) {
              folderId = matches[0].id;
            }
          }

          const filename = `${String(input.title || 'Document').replace(/[/\\?%*:|"<>]/g, '-')}.pdf`;
          driveResult = await uploadDriveFile(driveToken, {
            name: filename,
            mimeType: 'application/pdf',
            buffer: pdfBuffer,
            folderId,
          });
        } catch (err) {
          console.warn('PDF drive upload failed:', err.message);
        }
      }

      const base64Data = pdfBuffer.toString('base64');
      const safeTitle = String(input.title || 'document').replace(/[/\\?%*:|"<>]/g, '-');
      const dataUrl = `data:application/pdf;base64,${base64Data}`;

      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({
          generated: true,
          title: input.title,
          size_bytes: pdfBuffer.length,
          drive_file: driveResult
            ? {
                id: driveResult.id,
                name: driveResult.name,
                view_link: driveResult.link,
                download_link: driveResult.downloadLink,
              }
            : null,
          markdown_download: `[📄 Download ${safeTitle}.pdf](${dataUrl})`,
          message: driveResult
            ? `Successfully generated executive PDF and saved to Google Drive: "${driveResult.name}".`
            : `Successfully generated executive PDF (${(pdfBuffer.length / 1024).toFixed(1)} KB).`,
        }),
      };
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
        input.range || undefined,
        { offset: input.offset, max_rows: input.max_rows, max_chars: input.max_chars }
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
      // Undoing a creation bins the file rather than destroying it, so this is
      // recorded like any other edit and is just as reversible.
      const journal = await recordSheetEdit(getAdminClient(), {
        userId: user.id,
        spreadsheetId: result.spreadsheetId,
        kind: 'create',
        range: 'file',
        before: null,
        after: { title: result.title },
      });
      return { type: 'tool_result', tool_use_id: id, content: JSON.stringify({ ...result, ...journal }) };
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
      const spreadsheetId = String(input.spreadsheet_id || '');
      const range = input.range || 'A1';
      const values = input.values || [];
      const admin = getAdminClient();

      // An append lands wherever the data currently ends, which is not known
      // until the write comes back — so the block it created is journalled
      // afterwards, with an empty before-image. A plain write goes to a range
      // we can work out in advance, so the old cells are read first.
      if (input.append) {
        const result = await updateSheetValues(token, { spreadsheetId, range, values, append: true });
        const written = result.updatedRange;
        const journal = written
          ? await recordSheetEdit(admin, {
              userId: user.id,
              spreadsheetId,
              kind: 'values',
              range: written,
              before: null,
              after: values.map((row) => (Array.isArray(row) ? row.map((c) => (c == null ? '' : String(c))) : [String(row ?? '')])),
            })
          : { undo_id: null, undoable: false };
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: JSON.stringify({
            ...result,
            ...journal,
            ...(journal.undoable
              ? { undo_note: 'Undoing this clears the appended cells; the empty rows themselves stay.' }
              : {}),
          }),
        };
      }

      const captured = await captureValuesBefore(token, spreadsheetId, range, values);
      const result = await updateSheetValues(token, { spreadsheetId, range, values, append: false });
      const journal = await recordSheetEdit(admin, {
        userId: user.id,
        spreadsheetId,
        kind: 'values',
        range: captured.range,
        before: captured.before,
        after: values.map((row) => (Array.isArray(row) ? row.map((c) => (c == null ? '' : String(c))) : [String(row ?? '')])),
        tooLarge: captured.tooLarge,
      });
      return { type: 'tool_result', tool_use_id: id, content: JSON.stringify({ ...result, ...journal }) };
    }
    if (
      (name === 'read_file_comments' || name === 'add_file_comment' || name === 'reply_to_file_comment') &&
      user
    ) {
      // Comments are a Drive feature, so this needs a Drive-family token even
      // when the file is a spreadsheet. drive.file from the Sheets or Docs
      // connector only reaches files Quantumy itself created, which is why the
      // full Drive connector is named first in the failure message.
      const token =
        (await getValidToken(user.id, 'google_drive')) ||
        (await getValidToken(user.id, 'google_sheets')) ||
        (await getValidToken(user.id, 'google_docs'));
      if (!token) {
        return {
          type: 'tool_result',
          tool_use_id: id,
          content:
            'Comments need the Google Drive connector. Sheets or Docs alone can only reach files ' +
            'Quantumy created itself.',
          is_error: true,
        };
      }
      const fileId = String(input.file_id || '');
      try {
        if (name === 'read_file_comments') {
          const result = await listFileComments(token, fileId, {
            maxResults: input.max_results,
            includeResolved: !!input.include_resolved,
          });
          return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) };
        }
        if (name === 'add_file_comment') {
          const result = await createFileComment(token, fileId, {
            content: String(input.comment || ''),
            cell: input.cell ? String(input.cell) : undefined,
          });
          return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) };
        }
        const result = await replyToFileComment(token, fileId, String(input.comment_id || ''), {
          content: String(input.reply || ''),
          resolve: !!input.resolve,
        });
        return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) };
      } catch (e) {
        const msg = e?.message || String(e);
        return {
          type: 'tool_result',
          tool_use_id: id,
          // 403 on a comment is a sharing problem, not a bug — say which.
          content: /\b403\b/.test(msg)
            ? `${msg} — this account may have view-only access to that file; commenting needs comment or edit access.`
            : msg,
          is_error: true,
        };
      }
    }
    if (SHEET_HISTORY_TOOL_NAMES.has(name) && user) {
      // Undoing a values or note edit needs Sheets; undoing a creation needs
      // Drive, which the Sheets connector covers for files it made itself.
      const token = await getValidToken(user.id, 'google_sheets');
      if (!token) {
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Google Sheets is not connected.',
          is_error: true,
        };
      }
      return handleSheetHistoryTool(block, user, getAdminClient(), token);
    }
    if ((name === 'read_sheet_notes' || name === 'set_sheet_note') && user) {
      const token = await getValidToken(user.id, 'google_sheets');
      if (!token) {
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Google Sheets is not connected.',
          is_error: true,
        };
      }
      try {
        if (name === 'read_sheet_notes') {
          const result = await readSheetNotes(token, String(input.spreadsheet_id || ''), {
            range: input.range ? String(input.range) : undefined,
            maxResults: input.max_results,
          });
          return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) };
        }
        const spreadsheetId = String(input.spreadsheet_id || '');
        const cell = String(input.cell || '');
        // Writing a note replaces whatever was there, so the old text is read
        // back first — otherwise the only copy of it is gone.
        let previous = null;
        try {
          const existing = await readSheetNotes(token, spreadsheetId, { range: cell, maxResults: 1 });
          previous = existing.notes[0]?.note ?? null;
        } catch { /* no note there, or the range does not resolve yet */ }
        const result = await setSheetNote(token, spreadsheetId, {
          cell,
          note: String(input.note ?? ''),
        });
        const journal = await recordSheetEdit(getAdminClient(), {
          userId: user.id,
          spreadsheetId,
          kind: 'note',
          // The write resolves the tab name, so the journalled cell is the
          // fully qualified one and undo cannot land on the wrong tab.
          range: result.cell,
          before: previous,
          after: result.note,
        });
        return { type: 'tool_result', tool_use_id: id, content: JSON.stringify({ ...result, ...journal }) };
      } catch (e) {
        return { type: 'tool_result', tool_use_id: id, content: e?.message || String(e), is_error: true };
      }
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
      // Editing an in-flight window means finding an event that already
      // started, so the search can reach backwards as well as forwards.
      const back = Math.min(30, Math.max(0, Number(input.days_back) || 0));
      const max = Math.min(25, Math.max(1, Number(input.max_results) || 15));
      const events = await listCalendarEvents(token, {
        timeMin: new Date(Date.now() - back * 86400000).toISOString(),
        timeMax: new Date(Date.now() + days * 86400000).toISOString(),
        maxResults: max,
        query: input.query || undefined,
      });
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({ count: events.length, days_ahead: days, days_back: back, events }),
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
    if (name === 'update_calendar_event' && user) {
      const token = await getValidToken(user.id, 'google_calendar');
      if (!token)
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Google Calendar is not connected. Reconnect with write access.',
          is_error: true,
        };
      // Undefined and empty string mean different things here: undefined leaves
      // a field alone, '' clears it. Only pass through what was actually sent.
      const opt = (v) => (v === undefined ? undefined : String(v));
      const list = (v) => (Array.isArray(v) ? v : undefined);
      const result = await updateCalendarEvent(token, String(input.event_id || ''), {
        summary: opt(input.summary),
        description: opt(input.description),
        location: opt(input.location),
        start: opt(input.start),
        end: opt(input.end),
        allDay: input.all_day === undefined ? undefined : !!input.all_day,
        timeZone: opt(input.time_zone),
        attendees: list(input.attendees),
        addAttendees: list(input.add_attendees),
        removeAttendees: list(input.remove_attendees),
        notify: input.notify === undefined ? undefined : !!input.notify,
      });
      return { type: 'tool_result', tool_use_id: id, content: JSON.stringify(result) };
    }
    if (name === 'delete_calendar_event' && user) {
      const token = await getValidToken(user.id, 'google_calendar');
      if (!token)
        return {
          type: 'tool_result',
          tool_use_id: id,
          content: 'Google Calendar is not connected. Reconnect with write access.',
          is_error: true,
        };
      const result = await deleteCalendarEvent(token, String(input.event_id || ''), {
        notify: input.notify === undefined ? undefined : !!input.notify,
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
      // Facts are retrieved and put in prompts, so an essay saved as one
      // "fact" is billed on every turn it matches and crowds out the others.
      // Rejected rather than truncated: half a fact that reads as whole is
      // worse than no fact, and the model can split it and call again.
      if (fact.length > MAX_FACT_CHARS) {
        return {
          type: 'tool_result',
          tool_use_id: id,
          content:
            `Not saved: that fact is ${fact.length} characters and the limit is ${MAX_FACT_CHARS}. ` +
            'Split it into several separate facts, each one self-contained and about a single thing, and save them one at a time.',
          is_error: true,
        };
      }
      const admin = getAdminClient();
      await admin.from('user_memory').insert({
        user_id: user.id,
        fact,
        category: input.category || 'general',
        source: 'chat',
      });
      return { type: 'tool_result', tool_use_id: id, content: `Saved memory: ${fact}` };
    }
    if (name === 'recall_memory' && user) {
      const admin = getAdminClient();
      const { data, error } = await admin
        .from('user_memory')
        .select('fact, category, updated_at')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })
        .limit(200);
      if (error) {
        return { type: 'tool_result', tool_use_id: id, content: `Could not read memory: ${error.message}`, is_error: true };
      }
      const all = data || [];
      const wanted = [...termsOf(input.query)];
      // No query means "what do you know about me": return everything, newest
      // first, rather than nothing.
      const hits = wanted.length
        ? all.filter((m) => {
            const hay = `${m.fact} ${m.category || ''}`.toLowerCase();
            return wanted.some((t) => hay.includes(t));
          })
        : all;
      return {
        type: 'tool_result',
        tool_use_id: id,
        content: JSON.stringify({
          searched: all.length,
          matched: hits.length,
          facts: hits.slice(0, 40).map((m) => ({ fact: m.fact, category: m.category })),
        }),
      };
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
    RECALL_MEMORY_TOOL,
    SAVE_NOTE_TOOL,
    LIST_NOTES_TOOL,
    UPDATE_NOTE_TOOL,
    DELETE_NOTE_TOOL,
    GENERATE_PDF_TOOL,
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
    tools.push(SHEETS_LIST_TOOL, SHEETS_READ_TOOL, CREATE_SHEET_TOOL, UPDATE_SHEET_TOOL, READ_NOTES_TOOL, SET_NOTE_TOOL);
    tools.push(...SHEET_HISTORY_TOOLS);
  }
  // Comments live in Drive, not in Sheets or Docs, so they are offered whenever
  // any of the three is connected — the file to comment on could be either.
  if (sheetsTok || driveTok || docsTok) {
    tools.push(READ_COMMENTS_TOOL, ADD_COMMENT_TOOL, REPLY_COMMENT_TOOL);
  }
  if (calTok) {
    connected.calendar = true;
    tools.push(CALENDAR_TOOL, CREATE_EVENT_TOOL, UPDATE_EVENT_TOOL, DELETE_EVENT_TOOL);
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
