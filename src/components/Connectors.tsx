import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, ChevronLeft, ChevronRight, Check } from 'lucide-react'
import { supabase, CONNECTOR_CATALOG, type Connector } from '../lib/supabase'
import {
  GmailIcon, DriveIcon, SheetsIcon, DocsIcon, CalendarIcon, OutlookIcon, ExcelIcon,
} from './BrandIcons'

type Props = {
  dark: boolean
  accessToken: string
  onClose?: () => void
}

// Codes the connect callbacks redirect back with (?connector_error=...). Anything else is shown generically: the value
// comes from the URL, so it is never displayed verbatim unless it has the harmless shape of a provider error code.
const CONNECTOR_ERRORS: Record<string, string> = {
  access_denied: 'Connection cancelled. Nothing was connected.',
  missing_code: 'The provider did not return an authorization code. Please try again.',
  invalid_state: 'This connection link is no longer valid (expired, already used, or started in another browser). Please start again from this page.',
  state_store_unavailable: 'Connecting is temporarily unavailable. Please try again later.',
  exchange_failed: 'The provider refused the connection. Please try again.',
  save_failed: 'The connection could not be saved. Please try again.',
  token_key_invalid: 'Connecting is temporarily unavailable (server configuration). Please try again later.',
  callback_failed: 'Something went wrong while connecting. Please try again.',
}

export function connectorErrorMessage(code: string): string {
  if (Object.prototype.hasOwnProperty.call(CONNECTOR_ERRORS, code)) return CONNECTOR_ERRORS[code]
  return /^[A-Za-z0-9_.-]{1,64}$/.test(code)
    ? `The connection did not complete (${code}). Nothing was connected.`
    : 'The connection did not complete. Nothing was connected.'
}

const BRAND: Record<string, React.ReactNode> = {
  gmail: <GmailIcon size={22} />,
  google_drive: <DriveIcon size={22} />,
  google_sheets: <SheetsIcon size={22} />,
  google_docs: <DocsIcon size={22} />,
  google_calendar: <CalendarIcon size={22} />,
  outlook: <OutlookIcon size={22} />,
  excel: <ExcelIcon size={22} />,
}

export default function Connectors({ dark, accessToken, onClose }: Props) {
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [justConnected, setJustConnected] = useState<string | null>(null)

  const bg = dark ? 'bg-[#0a0a0c]' : 'bg-[#f2f2f7]'
  const textMain = dark ? 'text-white' : 'text-slate-900'
  const textMuted = dark ? 'text-white/40' : 'text-slate-500'
  const card = dark ? 'bg-[#1c1c1e]' : 'bg-white shadow-sm'
  const rowBorder = dark ? 'border-white/[0.06]' : 'border-black/[0.06]'
  const iconBg = dark ? 'bg-white/[0.08]' : 'bg-[#f0f0f5]'

  const load = async () => {
    setLoading(true)
    setError(null)
    try {
      const { data: sessionData } = await supabase.auth.getSession()
      const uid = sessionData.session?.user?.id
      if (!uid) {
        setConnectors([])
        return
      }
      // Strict isolation: only this user's connectors (never other users')
      const { data, error: err } = await supabase
        .from('connectors')
        .select('id, user_id, provider, account_email, status, scopes, created_at, updated_at')
        .eq('user_id', uid)
        .in('status', ['connected', 'revoked'])
      if (err) {
        setError(err.message || 'Failed to load connectors')
        setConnectors([])
      } else {
        setConnectors((data || []) as Connector[])
      }
    } catch (e: any) {
      setError(e?.message || 'Failed to load connectors')
      setConnectors([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
    const params = new URLSearchParams(window.location.search)
    const connected = params.get('connected')
    const connectorError = params.get('connector_error')
    if (connected || connectorError) {
      load()
      if (connected) {
        setJustConnected(connected)
        setTimeout(() => setJustConnected(null), 2200)
      }
      if (connectorError) setError(connectorErrorMessage(connectorError))
      const url = new URL(window.location.href)
      url.searchParams.delete('connected')
      url.searchParams.delete('connector_error')
      window.history.replaceState({}, '', url.pathname)
    }
  }, [])

  const getConnected = (provider: string) =>
    connectors.find((c) => c.provider === provider && c.status === 'connected')
  // The provider revoked the grant (or the refresh token no longer works): the app keeps the row so it can say so.
  const getRevoked = (provider: string) =>
    connectors.find((c) => c.provider === provider && c.status === 'revoked')

  const connect = async (provider: string) => {
    setError(null)
    setBusy(provider)
    try {
      const isMs = provider === 'outlook' || provider === 'excel'
      const startPath = isMs
        ? `/api/connectors/microsoft-start?provider=${provider}`
        : `/api/connectors/google-start?provider=${provider}`
      const res = await fetch(startPath, {
        headers: { Authorization: `Bearer ${accessToken}` },
      })
      const data = await res.json()
      if (!res.ok || !data.url) throw new Error(data.error || 'Could not start connection')
      window.location.href = data.url
    } catch (e: any) {
      setError(e.message || 'Failed to connect')
      setBusy(null)
    }
  }

  const disconnect = async (provider: string) => {
    setError(null)
    setBusy(provider)
    try {
      const res = await fetch('/api/connectors/disconnect', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ provider }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Disconnect failed')
      setConnectors((prev) => prev.filter((c) => c.provider !== provider))
      setSelected(null)
    } catch (e: any) {
      setError(e.message || 'Failed to disconnect')
    } finally {
      setBusy(null)
    }
  }

  const available = CONNECTOR_CATALOG.filter((c) => c.available)
  const connectedList = available.filter((c) => getConnected(c.provider))
  const reconnectList = available.filter((c) => !getConnected(c.provider) && getRevoked(c.provider))
  const suggestedList = available.filter((c) => !getConnected(c.provider) && !getRevoked(c.provider))

  const selectedItem = selected
    ? available.find((c) => c.provider === selected)
    : null
  const selectedConn = selected ? getConnected(selected) : null

  return (
    <div className={`flex flex-col h-full min-h-0 ${bg}`}>
      <div className="relative flex items-center justify-center h-[52px] shrink-0 px-4">
        <button
          type="button"
          onClick={() => (selected ? setSelected(null) : onClose?.())}
          className={`absolute left-4 w-9 h-9 rounded-full flex items-center justify-center ${
            dark ? 'bg-white/10 text-white' : 'bg-white text-slate-800 shadow-sm'
          }`}
          aria-label="Back"
        >
          <ChevronLeft className="w-5 h-5" strokeWidth={2.25} />
        </button>
        <h2 className={`text-[17px] font-semibold tracking-tight ${textMain}`}>
          {selectedItem ? selectedItem.name : 'Connectors'}
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto px-4 pb-8 space-y-6">
        <AnimatePresence>
          {justConnected && (
            <motion.div
              initial={{ opacity: 0, y: -8, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -6 }}
              className={`rounded-2xl px-4 py-3 text-[14px] flex items-center gap-2 ${
                dark ? 'bg-emerald-500/15 text-emerald-200' : 'bg-emerald-50 text-emerald-800'
              }`}
            >
              <motion.span
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: 'spring', stiffness: 500, damping: 18 }}
              >
                <Check className="w-4 h-4" />
              </motion.span>
              Connected successfully
            </motion.div>
          )}
        </AnimatePresence>

        {error && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            className={`rounded-2xl px-4 py-3 text-[14px] ${
              dark ? 'bg-amber-500/10 text-amber-200' : 'bg-amber-50 text-amber-800'
            }`}
          >
            {error}
          </motion.div>
        )}

        {loading ? (
          <div className="flex justify-center py-16">
            <Loader2 className={`w-6 h-6 animate-spin ${textMuted}`} />
          </div>
        ) : selectedItem ? (
          <motion.div
            key={selectedItem.provider}
            initial={{ opacity: 0, x: 16 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -12 }}
            transition={{ duration: 0.25 }}
            className="space-y-4"
          >
            <div className={`rounded-2xl ${card} px-4 py-6 flex flex-col items-center text-center`}>
              <motion.div
                initial={{ scale: 0.85, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                transition={{ type: 'spring', stiffness: 380, damping: 22 }}
                className={`w-16 h-16 rounded-2xl flex items-center justify-center ${iconBg}`}
              >
                {BRAND[selectedItem.provider]}
              </motion.div>
              <p className={`mt-3 text-[18px] font-semibold ${textMain}`}>{selectedItem.name}</p>
              <p className={`text-[14px] mt-1 ${textMuted}`}>
                {selectedConn?.account_email || selectedItem.description}
              </p>
              <p className={`text-[13px] mt-3 ${textMuted}`}>{selectedItem.scopesLabel}</p>
            </div>
            <button
              type="button"
              onClick={() => disconnect(selectedItem.provider)}
              disabled={busy === selectedItem.provider}
              className="w-full h-12 rounded-2xl text-[16px] font-medium text-red-500 bg-red-500/10 active:bg-red-500/15 disabled:opacity-50"
            >
              {busy === selectedItem.provider ? (
                <Loader2 className="w-4 h-4 animate-spin inline" />
              ) : (
                'Disconnect'
              )}
            </button>
          </motion.div>
        ) : (
          <>
            {connectedList.length > 0 && (
              <div>
                <p className={`text-[13px] font-medium px-1 mb-2 ${textMuted}`}>Connected</p>
                <div className={`rounded-[20px] overflow-hidden ${card}`}>
                  {connectedList.map((item, i) => (
                    <motion.button
                      key={item.provider}
                      type="button"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      transition={{ delay: i * 0.04, duration: 0.25 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => setSelected(item.provider)}
                      className={`w-full flex items-center gap-3.5 px-3.5 py-[14px] text-left active:opacity-80 ${
                        i < connectedList.length - 1 ? `border-b ${rowBorder}` : ''
                      }`}
                    >
                      <div
                        className={`w-10 h-10 rounded-[12px] flex items-center justify-center shrink-0 ${iconBg}`}
                      >
                        {BRAND[item.provider]}
                      </div>
                      <p className={`flex-1 text-[16px] font-medium ${textMain}`}>{item.name}</p>
                      <ChevronRight
                        className={`w-[18px] h-[18px] shrink-0 ${dark ? 'text-white/25' : 'text-slate-300'}`}
                      />
                    </motion.button>
                  ))}
                </div>
              </div>
            )}

            {reconnectList.length > 0 && (
              <div data-testid="reconnect-section">
                <p className={`text-[13px] font-medium px-1 mb-2 ${textMuted}`}>Needs reconnecting</p>
                <div className={`rounded-[20px] overflow-hidden ${card}`}>
                  {reconnectList.map((item, i) => {
                    const isBusy = busy === item.provider
                    return (
                      <div
                        key={item.provider}
                        className={`flex items-center gap-3.5 px-3.5 py-[14px] ${
                          i < reconnectList.length - 1 ? `border-b ${rowBorder}` : ''
                        }`}
                      >
                        <div className={`w-10 h-10 rounded-[12px] flex items-center justify-center shrink-0 ${iconBg}`}>
                          {BRAND[item.provider]}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className={`text-[16px] font-medium ${textMain}`}>{item.name}</p>
                          <p className={`text-[12.5px] leading-snug ${dark ? 'text-amber-200' : 'text-amber-700'}`}>
                            Access was revoked or expired. Reconnect to use it again.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => connect(item.provider)}
                          disabled={isBusy}
                          className={`shrink-0 h-[30px] px-3.5 rounded-full text-[13px] font-medium transition disabled:opacity-50 ${
                            dark
                              ? 'bg-white/10 text-white active:bg-white/15'
                              : 'bg-[#e8e8ed] text-slate-800 active:bg-[#dddde3]'
                          }`}
                        >
                          {isBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Reconnect'}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {suggestedList.length > 0 && (
              <div>
                <p className={`text-[13px] font-medium px-1 mb-2 ${textMuted}`}>Suggested</p>
                <div className={`rounded-[20px] overflow-hidden ${card}`}>
                  {suggestedList.map((item, i) => {
                    const isBusy = busy === item.provider
                    return (
                      <motion.div
                        key={item.provider}
                        initial={{ opacity: 0, y: 8 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.05 + i * 0.04, duration: 0.25 }}
                        className={`flex items-center gap-3.5 px-3.5 py-[14px] ${
                          i < suggestedList.length - 1 ? `border-b ${rowBorder}` : ''
                        }`}
                      >
                        <div
                          className={`w-10 h-10 rounded-[12px] flex items-center justify-center shrink-0 ${iconBg}`}
                        >
                          {BRAND[item.provider]}
                        </div>
                        <p className={`flex-1 text-[16px] font-medium ${textMain}`}>{item.name}</p>
                        <motion.button
                          type="button"
                          whileTap={{ scale: 0.94 }}
                          onClick={() => connect(item.provider)}
                          disabled={isBusy}
                          className={`shrink-0 h-[30px] px-3.5 rounded-full text-[13px] font-medium transition disabled:opacity-50 ${
                            dark
                              ? 'bg-white/10 text-white active:bg-white/15'
                              : 'bg-[#e8e8ed] text-slate-800 active:bg-[#dddde3]'
                          }`}
                        >
                          {isBusy ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            'Connect'
                          )}
                        </motion.button>
                      </motion.div>
                    )
                  })}
                </div>
              </div>
            )}

            {connectedList.length === 0 && reconnectList.length === 0 && suggestedList.length === 0 && (
              <p className={`text-center py-12 text-[15px] ${textMuted}`}>No connectors available</p>
            )}
          </>
        )}
      </div>
    </div>
  )
}
