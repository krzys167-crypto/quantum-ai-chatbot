import { useEffect, useState } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Loader2, ChevronLeft, ChevronRight, Check, Plug, Plus, Trash2 } from 'lucide-react'
import { supabase, CONNECTOR_CATALOG, type Connector } from '../lib/supabase'
import {
  GmailIcon, DriveIcon, SheetsIcon, DocsIcon, CalendarIcon, OutlookIcon, ExcelIcon,
} from './BrandIcons'

/** The token is never returned by the API, so it is absent here by design. */
type McpServer = {
  id: string
  name: string
  label: string | null
  url: string
  enabled: boolean
  allowed_tools: string[] | null
  last_error: string | null
}

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

export default function Connectors({ accessToken, onClose }: Props) {
  const [connectors, setConnectors] = useState<Connector[]>([])
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [mcp, setMcp] = useState<McpServer[]>([])
  const [mcpMissing, setMcpMissing] = useState(false)
  const [showMcpForm, setShowMcpForm] = useState(false)
  const [mcpUrl, setMcpUrl] = useState('')
  const [mcpLabel, setMcpLabel] = useState('')
  const [mcpToken, setMcpToken] = useState('')
  const [mcpTools, setMcpTools] = useState('')
  const [mcpBusy, setMcpBusy] = useState(false)
  const [mcpError, setMcpError] = useState<string | null>(null)
  const [justConnected, setJustConnected] = useState<string | null>(null)

  const bg = 'bg-settings-canvas'
  const textMain = 'text-foreground'
  const textMuted = 'text-muted-foreground'
  const card = 'bg-settings-surface shadow-sm'
  const rowBorder = 'border-border'
  const iconBg = 'bg-secondary'

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

  /**
   * MCP servers come from the API rather than straight from Supabase, because
   * the row's auth token is not readable by the browser at all - the endpoint
   * is the only thing that can see it, and it never sends it back.
   */
  const loadMcp = async () => {
    try {
      const res = await fetch('/api/connectors/mcp', {
        headers: { Authorization: 'Bearer ' + accessToken },
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) return
      setMcpMissing(!!body.not_installed)
      setMcp((body.servers || []) as McpServer[])
    } catch {
      /* offline; the rest of the panel still works */
    }
  }

  const saveMcp = async () => {
    const url = mcpUrl.trim()
    if (!url || mcpBusy) return
    setMcpBusy(true)
    setMcpError(null)
    try {
      const res = await fetch('/api/connectors/mcp', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
        body: JSON.stringify({
          url,
          label: mcpLabel.trim() || null,
          token: mcpToken.trim() || null,
          allowed_tools: mcpTools.trim() || null,
        }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        setMcpError(body.error || 'Could not add that server')
        return
      }
      setMcpUrl(''); setMcpLabel(''); setMcpToken(''); setMcpTools(''); setShowMcpForm(false)
      await loadMcp()
    } catch (e: any) {
      setMcpError(e?.message || 'Could not add that server')
    } finally {
      setMcpBusy(false)
    }
  }

  const toggleMcp = async (server: McpServer) => {
    setMcp((p) => p.map((s) => (s.id === server.id ? { ...s, enabled: !s.enabled } : s)))
    await fetch('/api/connectors/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + accessToken },
      body: JSON.stringify({ id: server.id, enabled: !server.enabled }),
    }).catch(() => {})
  }

  const removeMcp = async (server: McpServer) => {
    setMcp((p) => p.filter((s) => s.id !== server.id))
    await fetch('/api/connectors/mcp?id=' + encodeURIComponent(server.id), {
      method: 'DELETE',
      headers: { Authorization: 'Bearer ' + accessToken },
    }).catch(() => {})
  }

  useEffect(() => {
    load()
    loadMcp()
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
          className="absolute left-4 w-9 h-9 rounded-full flex items-center justify-center bg-secondary text-foreground shadow-sm"
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
              className="rounded-2xl px-4 py-3 text-[14px] flex items-center gap-2 bg-secondary text-foreground"
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
            className="rounded-2xl px-4 py-3 text-[14px] bg-destructive/10 text-destructive"
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
              className="w-full h-12 rounded-2xl text-[16px] font-medium text-destructive bg-destructive/10 active:bg-destructive/15 disabled:opacity-50"
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
                        className="w-[18px] h-[18px] shrink-0 text-muted-foreground"
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
                          <p className="text-[12.5px] leading-snug text-destructive">
                            Access was revoked or expired. Reconnect to use it again.
                          </p>
                        </div>
                        <button
                          type="button"
                          onClick={() => connect(item.provider)}
                          disabled={isBusy}
                          className="shrink-0 h-[30px] px-3.5 rounded-full text-[13px] font-medium transition disabled:opacity-50 bg-secondary text-foreground active:bg-accent"
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
                          className="shrink-0 h-[30px] px-3.5 rounded-full text-[13px] font-medium transition disabled:opacity-50 bg-secondary text-foreground active:bg-accent"
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

            {/* Anything speaking MCP. Unlike the connectors above, adding one
                needs no code and no deploy: paste a URL and its tools are
                available on the next message. */}
            <div>
              <div className="flex items-center justify-between px-1 mb-2">
                <p className={`text-[13px] font-medium ${textMuted}`}>MCP servers</p>
                {!showMcpForm && !mcpMissing && (
                  <button
                    type="button"
                    onClick={() => { setShowMcpForm(true); setMcpError(null) }}
                    className={`flex items-center gap-1 text-[13px] font-medium ${textMain}`}
                  >
                    <Plus className="w-3.5 h-3.5" /> Add
                  </button>
                )}
              </div>

              {mcpMissing ? (
                <div className={`rounded-[20px] ${card} px-4 py-4`}>
                  <p className={`text-[14px] ${textMuted}`}>
                    Run supabase/mcp-servers.sql to enable custom MCP servers.
                  </p>
                </div>
              ) : (
                <div className={`rounded-[20px] overflow-hidden ${card}`}>
                  {mcp.map((server, i) => (
                    <div
                      key={server.id}
                      className={`flex items-center gap-3.5 px-3.5 py-[14px] ${
                        i < mcp.length - 1 || showMcpForm ? `border-b ${rowBorder}` : ''
                      }`}
                    >
                      <div className={`w-10 h-10 rounded-[12px] flex items-center justify-center shrink-0 ${iconBg}`}>
                        <Plug className={`w-[18px] h-[18px] ${server.enabled ? textMain : textMuted}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={`text-[16px] font-medium truncate ${textMain}`}>
                          {server.label || server.name}
                        </p>
                        <p className={`text-[12px] truncate ${server.last_error ? 'text-destructive' : textMuted}`}>
                          {server.last_error
                            || (server.allowed_tools?.length
                              ? `${server.allowed_tools.length} tool${server.allowed_tools.length === 1 ? '' : 's'} · ${server.url}`
                              : server.url)}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => toggleMcp(server)}
                        className={`shrink-0 h-[30px] px-3 rounded-full text-[13px] font-medium transition ${
                          server.enabled ? 'bg-secondary text-foreground' : `${textMuted}`
                        }`}
                      >
                        {server.enabled ? 'On' : 'Off'}
                      </button>
                      <button
                        type="button"
                        onClick={() => removeMcp(server)}
                        aria-label={`Remove ${server.label || server.name}`}
                        className={`shrink-0 p-1.5 ${textMuted} hover:text-destructive`}
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  ))}

                  {showMcpForm && (
                    <div className="px-3.5 py-3.5 space-y-2.5">
                      <input
                        autoFocus
                        value={mcpUrl}
                        onChange={(e) => setMcpUrl(e.target.value)}
                        placeholder="https://mcp.example.com/sse"
                        className="w-full h-11 rounded-xl px-3 text-[15px] outline-none glass-panel text-foreground placeholder:text-muted-foreground"
                      />
                      <input
                        value={mcpLabel}
                        onChange={(e) => setMcpLabel(e.target.value)}
                        placeholder="Name (optional)"
                        className="w-full h-11 rounded-xl px-3 text-[15px] outline-none glass-panel text-foreground placeholder:text-muted-foreground"
                      />
                      <input
                        value={mcpToken}
                        onChange={(e) => setMcpToken(e.target.value)}
                        type="password"
                        autoComplete="off"
                        placeholder="Access token (optional)"
                        className="w-full h-11 rounded-xl px-3 text-[15px] outline-none glass-panel text-foreground placeholder:text-muted-foreground"
                      />
                      {/* Every tool a server offers is sent with every message,
                          so a large server is a standing cost. Naming the ones
                          actually used keeps the rest out of the prompt. */}
                      <input
                        value={mcpTools}
                        onChange={(e) => setMcpTools(e.target.value)}
                        placeholder="Only these tools, comma separated (optional)"
                        className="w-full h-11 rounded-xl px-3 text-[15px] outline-none glass-panel text-foreground placeholder:text-muted-foreground"
                      />
                      {mcpError && <p className="text-[13px] text-destructive">{mcpError}</p>}
                      <p className={`text-[12px] ${textMuted}`}>
                        Quantumy will be able to use whatever tools this server offers. Only add
                        servers you trust.
                      </p>
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => { setShowMcpForm(false); setMcpError(null) }}
                          className={`flex-1 h-10 rounded-xl text-[14px] font-medium ${textMuted}`}
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={saveMcp}
                          disabled={!mcpUrl.trim() || mcpBusy}
                          className="flex-1 h-10 rounded-xl text-[14px] font-medium bg-primary text-primary-foreground disabled:opacity-40 flex items-center justify-center gap-1.5"
                        >
                          {mcpBusy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
                          Connect
                        </button>
                      </div>
                    </div>
                  )}

                  {mcp.length === 0 && !showMcpForm && (
                    <button
                      type="button"
                      onClick={() => setShowMcpForm(true)}
                      className={`w-full flex items-center gap-3.5 px-3.5 py-[14px] text-left active:opacity-80`}
                    >
                      <div className={`w-10 h-10 rounded-[12px] flex items-center justify-center shrink-0 ${iconBg}`}>
                        <Plug className={`w-[18px] h-[18px] ${textMuted}`} />
                      </div>
                      <div className="flex-1">
                        <p className={`text-[16px] font-medium ${textMain}`}>Add an MCP server</p>
                        <p className={`text-[12px] ${textMuted}`}>Slack, Linear, Notion, your own</p>
                      </div>
                      <ChevronRight className="w-[18px] h-[18px] shrink-0 text-muted-foreground" />
                    </button>
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
