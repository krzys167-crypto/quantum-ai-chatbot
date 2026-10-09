import { useEffect, useState } from 'react'
import { Check, Loader2, Mail, ShieldCheck, X } from 'lucide-react'

// F09: the assistant can never send, reply, forward or invite guests on its own. When it asks to, the server stores
// the exact content and streams it here as an "approval_required" event. Nothing leaves the account until the
// signed-in user presses Confirm on this card; the server then executes the STORED content (this component only sends the id).

export type ApprovalAction = 'send_email' | 'reply_email' | 'forward_email' | 'create_calendar_event'

export interface ApprovalCard {
  id: string
  action: ApprovalAction
  fields: Record<string, string | boolean | string[]>
  context?: {
    original?: { from?: string; subject?: string; date?: string }
    recipients?: { to?: string; cc?: string; bcc?: string }
  } | null
  expires_at: string
}

export type ApprovalStatus = 'pending' | 'working' | 'sent' | 'cancelled' | 'failed' | 'expired'
export interface ApprovalCardState extends ApprovalCard {
  status: ApprovalStatus
  message?: string
}

/** Adds a card from the stream. The same request re-announced by the server (same id) is not duplicated. */
export function addApprovalCard(list: ApprovalCardState[], card: ApprovalCard): ApprovalCardState[] {
  if (!card || typeof card.id !== 'string' || !card.fields || list.some((c) => c.id === card.id)) return list
  return [...list, { ...card, status: 'pending' }]
}

const TITLE: Record<ApprovalAction, string> = {
  send_email: 'Send this email?',
  reply_email: 'Send this reply?',
  forward_email: 'Forward this message?',
  create_calendar_event: 'Create this event and invite the guests?',
}

const text = (v: unknown) => (Array.isArray(v) ? v.join(', ') : String(v ?? ''))

function whenText(f: ApprovalCard['fields']) {
  const start = text(f.start)
  const end = text(f.end)
  return [end ? `${start} - ${end}` : start, f.all_day === true ? 'all day' : '', text(f.time_zone)].filter(Boolean).join(' · ')
}

function Row({ label, value, dark }: { label: string; value: string; dark: boolean }) {
  if (!value) return null
  return (
    <div className="flex gap-2 text-[13px] leading-5">
      <span className={'w-14 shrink-0 ' + (dark ? 'text-slate-400' : 'text-slate-500')}>{label}</span>
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

interface Props {
  cards: ApprovalCardState[]
  setCards: (updater: (prev: ApprovalCardState[]) => ApprovalCardState[]) => void
  accessToken?: string
  dark: boolean
}

export default function ApprovalTray({ cards, setCards, accessToken, dark }: Props) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!cards.some((c) => c.status === 'pending')) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [cards])

  if (cards.length === 0) return null
  const patch = (id: string, p: Partial<ApprovalCardState>) => setCards((prev) => prev.map((c) => (c.id === id ? { ...c, ...p } : c)))

  const decide = async (card: ApprovalCardState, decision: 'approve' | 'reject') => {
    patch(card.id, { status: 'working', message: undefined })
    try {
      const res = await fetch('/api/approve-action', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(accessToken ? { Authorization: 'Bearer ' + accessToken } : {}) },
        body: JSON.stringify({ id: card.id, decision }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data?.ok) patch(card.id, { status: data.status === 'sent' || data.status === 'created' ? 'sent' : 'cancelled' })
      else patch(card.id, { status: res.status === 410 ? 'expired' : 'failed', message: String(data?.error || 'The server did not confirm the result. It may or may not have gone through: check your Sent folder or calendar before asking again.') })
    } catch {
      patch(card.id, { status: 'failed', message: card.action === 'create_calendar_event'
          ? 'Could not reach the server. The event may or may not have been created: check your calendar before asking again.'
          : 'Could not reach the server. It may or may not have been sent: check your Sent folder before asking again.' })
    }
  }

  const box = dark ? 'bg-white/5 border-white/10 text-slate-100' : 'bg-white border-slate-200 text-slate-800 shadow-sm'
  const ghost = dark ? 'border-white/15 text-slate-200 hover:bg-white/10' : 'border-slate-300 text-slate-700 hover:bg-slate-50'

  return (
    <div className="px-3 sm:px-4 pb-2 space-y-2 max-h-[55dvh] overflow-y-auto" data-testid="approval-tray">
      {cards.map((c) => {
        const f = c.fields
        const left = remaining(c.expires_at, now)
        const open = c.status === 'pending' || c.status === 'working'
        const timedOut = c.status === 'pending' && left === 0
        const orig = c.context?.original
        const isEvent = c.action === 'create_calendar_event'
        const isReply = c.action === 'reply_email'
        const rcpt = c.context?.recipients
        const bodyText = text(isEvent ? f.description : f.body)
        return (
          <section key={c.id} role="group" aria-label={TITLE[c.action]} data-testid="approval-card" data-status={c.status}
            className={'mx-auto w-full max-w-3xl rounded-2xl border p-3.5 ' + box}>
            <div className="flex items-center gap-2 text-[14px] font-semibold">
              <Mail className="w-4 h-4 shrink-0" />
              <span className="flex-1">{TITLE[c.action]}</span>
              {!open && (
                <button type="button" aria-label="Dismiss" onClick={() => setCards((prev) => prev.filter((x) => x.id !== c.id))} className="opacity-60 hover:opacity-100">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
            <div className="mt-2 space-y-0.5">
              {orig && (
                <Row dark={dark} label={c.action === 'forward_email' ? 'Message' : 'Replying'} value={[orig.from, orig.subject].filter(Boolean).join(' - ')} />
              )}
              {isEvent && <Row dark={dark} label="Event" value={text(f.summary)} />}
              {isEvent && <Row dark={dark} label="When" value={whenText(f)} />}
              {isEvent && <Row dark={dark} label="Where" value={text(f.location)} />}
              {isEvent && <Row dark={dark} label="Guests" value={text(f.attendees)} />}
              {!isEvent && !isReply && <Row dark={dark} label="To" value={text(f.to)} />}
              {isReply && <Row dark={dark} label="Mode" value={f.reply_all === true ? 'Reply to all' : 'Reply to sender'} />}
              {isReply && <Row dark={dark} label="To" value={rcpt?.to ? text(rcpt.to) : 'Unknown - do not confirm, cancel and ask again'} />}
              {!isEvent && <Row dark={dark} label="Cc" value={isReply ? text(rcpt?.cc ?? f.cc) : text(f.cc)} />}
              {!isEvent && <Row dark={dark} label="Bcc" value={isReply ? text(rcpt?.bcc ?? f.bcc) : text(f.bcc)} />}
              {c.action === 'send_email' && <Row dark={dark} label="Subject" value={text(f.subject)} />}
            </div>
            {bodyText !== '' && (
              <pre data-testid="approval-body" className={'mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl p-2.5 text-[13px] leading-5 font-sans ' + (dark ? 'bg-black/30' : 'bg-slate-50')}>
                {bodyText}
              </pre>
            )}
            {bodyText !== '' && (
              <p data-testid="approval-body-size" className={'mt-1 text-[11px] ' + (dark ? 'text-slate-400' : 'text-slate-500')}>
                {lineCount(bodyText)} lines, {bodyText.length} characters. Scroll the box to read all of it before confirming.
              </p>
            )}
            {open ? (
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button type="button" disabled={c.status === 'working' || timedOut} onClick={() => void decide(c, 'approve')}
                  className="inline-flex items-center gap-1.5 rounded-full bg-slate-900 text-white dark:bg-white dark:text-slate-900 px-4 py-2 text-[13px] font-semibold disabled:opacity-50"
                  style={dark ? { background: '#fff', color: '#0f172a' } : undefined}>
                  {c.status === 'working' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}
                  Confirm
                </button>
                <button type="button" disabled={c.status === 'working'} onClick={() => void decide(c, 'reject')}
                  className={'rounded-full border px-4 py-2 text-[13px] font-medium disabled:opacity-50 ' + ghost}>
                  Cancel
                </button>
                <span className={'text-[12px] ' + (dark ? 'text-slate-400' : 'text-slate-500')}>
                  {timedOut ? 'Expired. Ask the assistant to prepare it again.' : `${isEvent ? 'Nothing is created or shared until you confirm.' : 'Nothing is sent until you confirm.'} Expires in ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`}
                </span>
              </div>
            ) : (
              <p role="status" className={'mt-3 flex items-center gap-1.5 text-[13px] ' + (c.status === 'sent' ? 'text-emerald-500' : c.status === 'cancelled' ? (dark ? 'text-slate-400' : 'text-slate-500') : 'text-amber-500')}>
                {c.status === 'sent' && <Check className="w-4 h-4" />}
                {c.status === 'sent' ? (isEvent ? 'Event created.' : 'Sent.') : c.status === 'cancelled' ? (isEvent ? 'Cancelled. Nothing was created.' : 'Cancelled. Nothing was sent.') : c.message || 'This request is no longer valid.'}
              </p>
            )}
          </section>
        )
      })}
    </div>
  )
}
