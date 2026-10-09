import { useEffect, useState } from 'react'
import { Calendar, Check, Loader2, Mail, MessageSquare, ShieldCheck, X } from 'lucide-react'

// F09: the assistant can never send, reply, forward, invite or notify guests, or comment on a shared file on its own.
// When it asks to, the server stores the exact content and streams it here as an "approval_required" event. Nothing
// reaches another person until the signed-in user presses Confirm on this card; the server then executes the STORED
// content (this component only sends the id).

export type ApprovalAction =
  | 'send_email'
  | 'reply_email'
  | 'forward_email'
  | 'create_calendar_event'
  | 'update_calendar_event'
  | 'delete_calendar_event'
  | 'add_file_comment'
  | 'reply_to_file_comment'

export interface ApprovalCard {
  id: string
  action: ApprovalAction
  fields: Record<string, string | boolean | string[]>
  context?: {
    original?: { from?: string; subject?: string; date?: string }
    recipients?: { to?: string; cc?: string; bcc?: string }
    event?: { summary?: string; start?: string; end?: string; guests?: string[]; recurring?: boolean }
    file?: { name?: string; type?: string }
  } | null
  expires_at: string
}

export type ApprovalStatus = 'pending' | 'working' | 'done' | 'cancelled' | 'failed' | 'expired'
export interface ApprovalCardState extends ApprovalCard {
  status: ApprovalStatus
  message?: string
}

/** Adds a card from the stream. The same request re-announced by the server (same id) is not duplicated. */
export function addApprovalCard(list: ApprovalCardState[], card: ApprovalCard): ApprovalCardState[] {
  if (!card || typeof card.id !== 'string' || !card.fields || list.some((c) => c.id === card.id)) return list
  return [...list, { ...card, status: 'pending' }]
}

const text = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''))
const has = (f: ApprovalCard['fields'], k: string) => f[k] !== undefined

type Kind = 'mail' | 'calendar' | 'comment'
const kindOf = (a: ApprovalAction): Kind =>
  a === 'create_calendar_event' || a === 'update_calendar_event' || a === 'delete_calendar_event' ? 'calendar'
  : a === 'add_file_comment' || a === 'reply_to_file_comment' ? 'comment'
  : 'mail'

function titleOf(c: ApprovalCard): string {
  const guests = c.context?.event?.guests
  switch (c.action) {
    case 'send_email': return 'Send this email?'
    case 'reply_email': return 'Send this reply?'
    case 'forward_email': return 'Forward this message?'
    case 'create_calendar_event': return 'Create this event and invite the guests?'
    case 'update_calendar_event': return Array.isArray(guests) && guests.length > 0 ? 'Change this event that has guests?' : 'Change this event and invite new guests?'
    case 'delete_calendar_event': return 'Cancel this event that has guests?'
    case 'add_file_comment': return 'Post this comment on the file?'
    case 'reply_to_file_comment': return 'Post this reply on the file?'
  }
}

const DONE: Record<ApprovalAction, string> = {
  send_email: 'Sent.',
  reply_email: 'Sent.',
  forward_email: 'Sent.',
  create_calendar_event: 'Event created.',
  update_calendar_event: 'Event updated.',
  delete_calendar_event: 'Event cancelled.',
  add_file_comment: 'Comment posted.',
  reply_to_file_comment: 'Reply posted.',
}
const CANCELLED: Record<ApprovalAction, string> = {
  send_email: 'Cancelled. Nothing was sent.',
  reply_email: 'Cancelled. Nothing was sent.',
  forward_email: 'Cancelled. Nothing was sent.',
  create_calendar_event: 'Cancelled. Nothing was created.',
  update_calendar_event: 'Cancelled. Nothing was changed.',
  delete_calendar_event: 'Cancelled. The event was not cancelled.',
  add_file_comment: 'Cancelled. Nothing was posted.',
  reply_to_file_comment: 'Cancelled. Nothing was posted.',
}
const NOTHING_UNTIL: Record<Kind, string> = {
  mail: 'Nothing is sent until you confirm.',
  calendar: 'Nothing is changed or shared until you confirm.',
  comment: 'Nothing is posted until you confirm.',
}
const UNREACHABLE: Record<Kind, string> = {
  mail: 'Could not reach the server. It may or may not have been sent: check your Sent folder before asking again.',
  calendar: 'Could not reach the server. The change may or may not have been made: check your calendar before asking again.',
  comment: 'Could not reach the server. The comment may or may not have been posted: check the file before asking again.',
}
const UNCLEAR: Record<Kind, string> = {
  mail: 'The server did not confirm the result. It may or may not have gone through: check your Sent folder before asking again.',
  calendar: 'The server did not confirm the result. It may or may not have gone through: check your calendar before asking again.',
  comment: 'The server did not confirm the result. It may or may not have gone through: check the file before asking again.',
}

function whenText(f: ApprovalCard['fields']) {
  const start = text(f.start)
  const end = text(f.end)
  return [end ? `${start} - ${end}` : start, f.all_day === true ? 'all day' : '', text(f.time_zone)].filter(Boolean).join(' · ')
}

function Row({ label, value }: { label: string; value: string }) {
  if (!value) return null
  return (
    <div className="flex gap-2 text-[13px] leading-5">
      <span className="w-24 shrink-0 text-muted-foreground">{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  )
}

function lineCount(s: string) {
  return s === '' ? 0 : s.split(/\r\n|\r|\n/).length
}

function remaining(expiresAt: string, now: number) {
  const ms = Date.parse(expiresAt) - now
  return Number.isFinite(ms) ? Math.max(0, ms) : 0
}

/** The text block of the card: the e-mail body, the event description, the comment or the reply. */
function bodyOf(c: ApprovalCard): string {
  const f = c.fields
  switch (c.action) {
    case 'create_calendar_event':
    case 'update_calendar_event': return text(f.description)
    case 'delete_calendar_event': return ''
    case 'add_file_comment': return text(f.comment)
    // Drive refuses an empty reply, so a bare resolve is posted with this text (see replyToFileComment): show what it will say.
    case 'reply_to_file_comment': return text(f.reply) || (f.resolve === true ? 'Resolved.' : '')
    default: return text(f.body)
  }
}

function notifyText(f: ApprovalCard['fields']) {
  return f.notify === true ? 'Yes - the guests get an e-mail' : f.notify === false ? 'No e-mail to the guests' : 'Calendar default'
}

/** The rows above the text block. Everything comes from the stored arguments, plus read-only context resolved by the server. */
function Rows({ c }: { c: ApprovalCard }) {
  const f = c.fields
  const orig = c.context?.original
  const rcpt = c.context?.recipients
  const ev = c.context?.event
  const file = c.context?.file
  switch (c.action) {
    case 'create_calendar_event':
      return (<>
        <Row label="Event" value={text(f.summary)} />
        <Row label="When" value={whenText(f)} />
        <Row label="Where" value={text(f.location)} />
        <Row label="Guests" value={text(f.attendees)} />
      </>)
    case 'update_calendar_event':
      return (<>
        <Row label="Event" value={ev ? text(ev.summary) || '(untitled)' : 'Unknown event - do not confirm, cancel and ask again'} />
        <Row label="Now" value={ev ? [ev.start, ev.end].filter(Boolean).join(' - ') : ''} />
        <Row label="Guests now" value={ev ? text(ev.guests) || 'none' : ''} />
        <Row label="Series" value={ev?.recurring ? 'Part of a recurring series' : ''} />
        <Row label="New title" value={has(f, 'summary') ? text(f.summary) || '(cleared)' : ''} />
        <Row label="New time" value={has(f, 'start') || has(f, 'end') || has(f, 'all_day') || has(f, 'time_zone') ? whenText(f) : ''} />
        <Row label="New place" value={has(f, 'location') ? text(f.location) || '(cleared)' : ''} />
        <Row label="Invite" value={text(f.add_attendees)} />
        <Row label="Remove" value={text(f.remove_attendees)} />
        <Row label="Guests become" value={has(f, 'attendees') ? text(f.attendees) || 'nobody' : ''} />
        <Row label="Notify" value={notifyText(f)} />
        <Row label="Description" value={has(f, 'description') && text(f.description) === '' ? '(cleared)' : ''} />
      </>)
    case 'delete_calendar_event':
      return (<>
        <Row label="Event" value={ev ? text(ev.summary) || '(untitled)' : 'Unknown event - do not confirm, cancel and ask again'} />
        <Row label="When" value={ev ? [ev.start, ev.end].filter(Boolean).join(' - ') : ''} />
        <Row label="Guests" value={ev ? text(ev.guests) || 'none' : ''} />
        <Row label="Series" value={ev?.recurring ? 'Part of a recurring series' : ''} />
        <Row label="Notify" value={notifyText(f)} />
      </>)
    case 'add_file_comment':
      return (<>
        <Row label="File" value={file?.name ? text(file.name) : `Unknown file (${text(f.file_id)})`} />
        <Row label="About cell" value={text(f.cell)} />
        <Row label="Visible to" value="Everyone with access to the file" />
      </>)
    case 'reply_to_file_comment':
      return (<>
        <Row label="File" value={file?.name ? text(file.name) : `Unknown file (${text(f.file_id)})`} />
        <Row label="Comment id" value={text(f.comment_id)} />
        <Row label="Resolve" value={f.resolve === true ? 'Yes - marks the thread resolved' : ''} />
        <Row label="Visible to" value="Everyone with access to the file" />
      </>)
    default: {
      const isReply = c.action === 'reply_email'
      return (<>
        {orig && <Row label={c.action === 'forward_email' ? 'Message' : 'Replying'} value={[orig.from, orig.subject].filter(Boolean).join(' - ')} />}
        {!isReply && <Row label="To" value={text(f.to)} />}
        {isReply && <Row label="Mode" value={f.reply_all === true ? 'Reply to all' : 'Reply to sender'} />}
        {isReply && <Row label="To" value={rcpt?.to ? text(rcpt.to) : 'Unknown - do not confirm, cancel and ask again'} />}
        <Row label="Cc" value={isReply ? text(rcpt?.cc ?? f.cc) : text(f.cc)} />
        <Row label="Bcc" value={isReply ? text(rcpt?.bcc ?? f.bcc) : text(f.bcc)} />
        {c.action === 'send_email' && <Row label="Subject" value={text(f.subject)} />}
      </>)
    }
  }
}

interface Props {
  cards: ApprovalCardState[]
  setCards: (updater: (prev: ApprovalCardState[]) => ApprovalCardState[]) => void
  accessToken?: string
}

export default function ApprovalTray({ cards, setCards, accessToken }: Props) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!cards.some((c) => c.status === 'pending')) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [cards])

  if (cards.length === 0) return null
  const patch = (id: string, p: Partial<ApprovalCardState>) => setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...p } : c)))

  const decide = async (card: ApprovalCardState, decision: 'approve' | 'reject') => {
    const kind = kindOf(card.action)
    patch(card.id, { status: 'working', message: undefined })
    try {
      const res = await fetch('/api/approve-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}) },
        body: JSON.stringify({ id: card.id, decision }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok && data.status === 'cancelled') patch(card.id, { status: 'cancelled' })
      else if (res.ok && data?.ok && (data.status === 'sent' || data.status === 'created' || data.status === 'done')) patch(card.id, { status: 'done' })
      // Anything else is not a confirmed result: never show "Cancelled. Nothing was sent." for an answer we did not understand.
      else patch(card.id, { status: res.status === 410 ? 'expired' : 'failed', message: String(data?.error || UNCLEAR[kind]) })
    } catch {
      patch(card.id, { status: 'failed', message: UNREACHABLE[kind] })
    }
  }

  return (
    <div className="px-3 sm:px-4 pb-2 space-y-2 max-h-[55dvh] overflow-y-auto" data-testid="approval-tray">
      {cards.map((c) => {
        const left = remaining(c.expires_at, now)
        const open = c.status === 'pending' || c.status === 'working'
        const timedOut = c.status === 'pending' && left === 0
        const kind = kindOf(c.action)
        const Icon = kind === 'calendar' ? Calendar : kind === 'comment' ? MessageSquare : Mail
        const title = titleOf(c)
        const bodyText = bodyOf(c)
        return (
          <section key={c.id} role="group" aria-label={title} data-testid="approval-card" data-status={c.status}
            className="mx-auto w-full max-w-3xl rounded-2xl border border-border bg-card text-card-foreground shadow-sm p-3.5">
            <div className="flex items-center gap-2 text-[14px] font-semibold">
              <Icon className="w-4 h-4 shrink-0" />
              <span className="flex-1">{title}</span>
              {!open && (
                <button type="button" aria-label="Dismiss" onClick={() => setCards((prev) => prev.filter((x) => x.id !== c.id))} className="opacity-60 hover:opacity-100">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <div className="mt-2 space-y-0.5">
              <Rows c={c} />
            </div>
            {bodyText !== '' && (
              <pre data-testid="approval-body" className="mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl border border-border bg-secondary p-2.5 text-[13px] leading-5 font-sans">
                {bodyText}
              </pre>
            )}
            {bodyText !== '' && (
              <p data-testid="approval-body-size" className="mt-1 text-[11px] text-muted-foreground">
                {lineCount(bodyText)} lines, {bodyText.length} characters. Scroll the box to read all of it before confirming.
              </p>
            )}
            {open ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" disabled={c.status === 'working' || timedOut} onClick={() => void decide(c, 'approve')}
                  className="inline-flex items-center gap-1.5 rounded-full bg-primary text-primary-foreground px-4 py-2 text-[13px] font-semibold disabled:opacity-50">
                  {c.status === 'working' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                  Confirm
                </button>
                <button type="button" disabled={c.status === 'working'} onClick={() => void decide(c, 'reject')}
                  className="rounded-full border border-border px-4 py-2 text-[13px] font-medium hover:bg-accent disabled:opacity-50">
                  Cancel
                </button>
                <span className="text-[12px] text-muted-foreground">
                  {timedOut ? 'Expired. Ask the assistant to prepare it again.' : `${NOTHING_UNTIL[kind]} Expires in ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`}
                </span>
              </div>
            ) : (
              <p role="status" className={'mt-3 flex items-center gap-1.5 text-[13px] ' + (c.status === 'done' ? 'text-emerald-500' : c.status === 'cancelled' ? 'text-muted-foreground' : 'text-amber-500')}>
                {c.status === 'done' && <Check className="w-4 h-4" />}
                {c.status === 'done' ? DONE[c.action] : c.status === 'cancelled' ? CANCELLED[c.action] : c.message || 'This request is no longer valid.'}
              </p>
            )}
          </section>
        )
      })}
    </div>
  )
}
