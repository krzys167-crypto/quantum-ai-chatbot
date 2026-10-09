import { useEffect, useState } from 'react'
import { Loader2, RefreshCw, Users, MessageSquare, MessagesSquare, Plug } from 'lucide-react'
import { supabase } from '../../lib/supabase'

type Props = {
  dark: boolean
}

type Stats = {
  users: number | null
  conversations: number | null
  messagesToday: number | null
  connectors: number | null
}

// `column` defaults to '*'. Tables with column-level grants (connectors: tokens are not readable by
// clients) must be counted on an allowed column, because '*' expands to every column.
async function countTable(table: string, filter?: { column: string; value: string }, column = '*'): Promise<number | null> {
  try {
    let q = supabase.from(table).select(column, { count: 'exact', head: true })
    if (filter) q = q.eq(filter.column, filter.value)
    const { count, error } = await q
    if (error) {
      console.warn('count', table, error.message)
      return null
    }
    return count ?? 0
  } catch (e) {
    console.warn('count exception', table, e)
    return null
  }
}

async function countMessagesToday(): Promise<number | null> {
  try {
    const start = new Date()
    start.setHours(0, 0, 0, 0)
    const { count, error } = await supabase
      .from('messages')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', start.toISOString())
    if (error) {
      console.warn('count messages today', error.message)
      return null
    }
    return count ?? 0
  } catch (e) {
    console.warn('count messages today exception', e)
    return null
  }
}

export default function Overview({ dark }: Props) {
  const [stats, setStats] = useState<Stats>({
    users: null,
    conversations: null,
    messagesToday: null,
    connectors: null,
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null)

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const [users, conversations, messagesToday, connectors] = await Promise.all([
        countTable('profiles'),
        countTable('conversations'),
        countMessagesToday(),
        countTable('connectors', { column: 'status', value: 'connected' }, 'id'),
      ])
      setStats({ users, conversations, messagesToday, connectors })
      setUpdatedAt(new Date())
      if (users === null && conversations === null && messagesToday === null && connectors === null) {
        setError('Could not load stats. Check RLS policies allow admin reads.')
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load stats')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const fmt = (n: number | null) => {
    if (n === null) return '—'
    return n.toLocaleString()
  }

  const cards = [
    {
      label: 'Total users',
      value: fmt(stats.users),
      hint: 'Rows in profiles',
      icon: Users,
    },
    {
      label: 'Conversations',
      value: fmt(stats.conversations),
      hint: 'All chats',
      icon: MessageSquare,
    },
    {
      label: 'Messages today',
      value: fmt(stats.messagesToday),
      hint: 'Since midnight local',
      icon: MessagesSquare,
    },
    {
      label: 'Active connectors',
      value: fmt(stats.connectors),
      hint: 'Status = connected',
      icon: Plug,
    },
  ]

  const cardBg = dark ? 'bg-white/[0.03] border-white/10' : 'bg-white border-slate-200 shadow-sm'
  const muted = dark ? 'text-slate-400' : 'text-slate-500'
  const title = dark ? 'text-white' : 'text-slate-900'

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className={'text-xl font-semibold tracking-tight ' + title}>Overview</h2>
          <p className={'mt-1 text-sm ' + muted}>
            Live counts from Supabase. Refresh anytime.
          </p>
        </div>
        <button
          type="button"
          onClick={load}
          disabled={loading}
          className={
            'h-9 px-3 rounded-xl text-sm font-medium flex items-center gap-2 transition disabled:opacity-50 ' +
            (dark
              ? 'bg-white/10 text-slate-200 hover:bg-white/15'
              : 'bg-slate-100 text-slate-700 hover:bg-slate-200')
          }
        >
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <RefreshCw className="w-4 h-4" />
          )}
          Refresh
        </button>
      </div>

      {error && (
        <div
          className={
            'rounded-xl border px-4 py-3 text-sm ' +
            (dark
              ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
              : 'border-amber-200 bg-amber-50 text-amber-800')
          }
        >
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        {cards.map((c) => {
          const Icon = c.icon
          return (
            <div key={c.label} className={'rounded-2xl border p-4 ' + cardBg}>
              <div className="flex items-center justify-between gap-2">
                <div
                  className={
                    'text-[11px] font-medium uppercase tracking-wider ' +
                    (dark ? 'text-slate-500' : 'text-slate-400')
                  }
                >
                  {c.label}
                </div>
                <Icon
                  className={'w-4 h-4 shrink-0 ' + (dark ? 'text-slate-500' : 'text-slate-400')}
                />
              </div>
              <div className={'mt-2 text-2xl font-semibold tabular-nums ' + title}>
                {loading && stats.users === null ? (
                  <Loader2 className="w-5 h-5 animate-spin opacity-50" />
                ) : (
                  c.value
                )}
              </div>
              <div className={'mt-1 text-xs ' + (dark ? 'text-slate-600' : 'text-slate-400')}>
                {c.hint}
              </div>
            </div>
          )
        })}
      </div>

      <div className={'rounded-2xl border p-5 ' + cardBg}>
        <h3 className={'text-sm font-semibold ' + title}>About these numbers</h3>
        <p className={'mt-1.5 text-sm leading-relaxed ' + muted}>
          Counts use the logged-in admin session. If RLS only allows each user to see their own
          rows, totals will under-count. For full product-wide metrics, add policies that let{' '}
          <code
            className={
              'text-xs px-1.5 py-0.5 rounded ' + (dark ? 'bg-white/10' : 'bg-slate-100')
            }
          >
            is_admin = true
          </code>{' '}
          read all rows on profiles, conversations, messages, and connectors — or move aggregates
          to a server function.
        </p>
        {updatedAt && (
          <p className={'mt-3 text-xs ' + (dark ? 'text-slate-600' : 'text-slate-400')}>
            Last updated {updatedAt.toLocaleTimeString()}
          </p>
        )}
      </div>
    </div>
  )
}
