import { useEffect, useState } from 'react'
import { Check, Loader2, Mail, ShieldCheck, X } from 'lucide-react'

// F09: the assistant can never send, reply or forward on its own. When it asks to, the server stores the exact
// content and streams it here as an "approval_required" event. Nothing leaves the account until the signed-in
// user presses Confirm on this card; the server then sends the STORED content (this component only sends the id).

export type ApprovalAction = 'send_email' | 'reply_email' | 'forward_email'

export interface ApprovalCard {
  id: string
  action: ApprovalAction
  fields: Record<string, string | boolean>
  context?: { original?: { from?: string; subject?: string; date?: string } } | null
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

const TITLE: Record<ApprovalAction, string> = { send_email: 'Send this email?', reply_email: 'Send this reply?', forward_email: 'Forward this message?' }

function Row({ label, value, dark }: { label: string; value: string; dark: boolean }) {
  if (!value) return null
  return (
    <div className="flex gap-2 text-[13px] leading-5">
      <span className={'w-14 shrink-0 ' + (dark ? 'text-slate-400' : 'text-slate-500')}>{label}</span>
      <span className="min-w-0 break-words">{value}</span>
    </div>
  )
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
      if (res.ok && data?.ok) patch(card.id, { status: data.status === 'sent' ? 'sent' : 'cancelled' })
      else patch(card.id, { status: res.status === 410 ? 'expired' : 'failed', message: String(data?.error || 'The request failed. Nothing was sent.') })
    } catch {
      patch(card.id, { status: 'failed', message: 'Could not reach the server. It may or may not have been sent: check your Sent folder before asking again.' })
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
              {c.action !== 'reply_email' && <Row dark={dark} label="To" value={String(f.to ?? '')} />}
              {c.action === 'reply_email' && <Row dark={dark} label="Mode" value={f.reply_all === true ? 'Reply to all' : 'Reply to sender'} />}
              <Row dark={dark} label="Cc" value={String(f.cc ?? '')} />
              <Row dark={dark} label="Bcc" value={String(f.bcc ?? '')} />
              {c.action === 'send_email' && <Row dark={dark} label="Subject" value={String(f.subject ?? '')} />}
            </div>
            {String(f.body ?? '') !== '' && (
              <pre data-testid="approval-body" className={'mt-2 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-xl p-2.5 text-[13px] leading-5 font-sans ' + (dark ? 'bg-black/30' : 'bg-slate-50')}>
                {String(f.body)}
              </pre>
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
                  {timedOut ? 'Expired. Ask the assistant to prepare it again.' : `Nothing is sent until you confirm. Expires in ${Math.floor(left / 60000)}:${String(Math.floor((left % 60000) / 1000)).padStart(2, '0')}`}
                </span>
              </div>
            ) : (
              <p role="status" className={'mt-3 flex items-center gap-1.5 text-[13px] ' + (c.status === 'sent' ? 'text-emerald-500' : c.status === 'cancelled' ? (dark ? 'text-slate-400' : 'text-slate-500') : 'text-amber-500')}>
                {c.status === 'sent' && <Check className="w-4 h-4" />}
                {c.status === 'sent' ? 'Sent.' : c.status === 'cancelled' ? 'Cancelled. Nothing was sent.' : c.message || 'This request is no longer valid.'}
              </p>
            )}
          </section>
        )
      })}
    </div>
  )
}
