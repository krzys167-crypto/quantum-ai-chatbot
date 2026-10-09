import { useState, useRef, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'framer-motion'
import { Menu, Loader2, PenLine, Sun, Moon, PanelLeft, ArrowLeft, ChevronRight } from 'lucide-react'
import { supabase, type Conversation, type DbMessage, type Project, makeChatTitle } from './lib/supabase'
import { useTheme } from './lib/theme'
import Auth from './components/Auth'
import Sidebar from './components/Sidebar'
import Settings from './components/Settings'
import Connectors from './components/Connectors'
import Logo from './components/Logo'
import MessageList, { type ChatMessage } from './components/MessageList'
import EmptyState from './components/EmptyState'
import ChatInput, { type PendingFile, type VoiceLanguage } from './components/ChatInput'
import InstallPWA from './components/InstallPWA'
import CommandPalette from './components/CommandPalette'
import ProjectsWorkspace from './components/ProjectsWorkspace'
import ProjectDashboard from './components/ProjectDashboard'
import NotesDashboard from './components/NotesDashboard'
import ApprovalTray, { addApprovalCard, type ApprovalCardState } from './components/ApprovalTray'
import ConnectorStatusBadges from './components/ConnectorStatusBadges'

const MODEL = { id: 'quantumy', name: 'Quantumy', anthropic: 'claude-sonnet-5' as const }

/** Shown in tooltips so the shortcut reads correctly on either platform. */
const MOD_LABEL =
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)
    ? '\u2318'
    : 'Ctrl+'

function generateId() {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

function creativeGreeting(firstName: string) {
  const n = (firstName || '').trim()
  if (n && n.toLowerCase() !== 'there') return 'What can I help you with today, ' + n + '?'
  return 'What can I help you with today?'
}

/** Starter prompts shown above the type bar on a new chat */
const EMPTY_STARTERS = [
  'Summarize my last emails',
  'Draft a professional reply',
  'Help me plan my week',
  'Explain something simply',
  'Brainstorm product ideas',
  'Write a short update message',
]

/** Which full-page workspace the main column is showing, if not a conversation. */
type WorkspacePage = 'chat' | 'projects' | 'project' | 'notes'

function buildUserContent(text: string, files: PendingFile[]): string {
  const parts: string[] = []
  if (text.trim()) parts.push(text.trim())
  for (const f of files) {
    if (f.type.startsWith('image/') && f.dataUrl) parts.push('![' + f.name + '](' + f.dataUrl + ')')
    else if (f.type === 'application/pdf' && f.dataUrl) parts.push('[\ud83d\udcc4 ' + f.name + '](' + f.dataUrl + ')')
    else if (f.type.startsWith('text/') || f.text) {
      const body = (f.text || '').slice(0, 40_000)
      parts.push('📎 **' + f.name + '**\n```\n' + body + '\n```')
    } else parts.push('📎 **' + f.name + '** _(file attached)_')
  }
  return parts.join('\n\n')
}

function stripAttachmentsForTitle(raw: string): string {
  return raw
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/\[\ud83d\udcc4[^\]]*\]\(data:application\/pdf[^)]+\)/g, '')
    .replace(/📎\s*\*\*[^*]+\*\*[\s\S]*?(?=\n\n|$)/g, '')
    .replace(/---\s*File:[^-]+---[\s\S]*?(?=\n\n|$)/g, '')
    .replace(/\[Image attached:[^\]]+\]/g, '')
    .replace(/\[File attached:[^\]]+\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export default function App() {
  const { dark, setDark, cycleTheme, themeMode } = useTheme()
  const [glass, setGlass] = useState(() => { try { return localStorage.getItem('quantumy-glass') !== '0' } catch { return true } })
  const [session, setSession] = useState<any>(null)
  const [authLoading, setAuthLoading] = useState(true)
  const [mobileSidebar, setMobileSidebar] = useState(false)
  // Remembered per browser: someone who works with the sidebar closed should
  // not have to close it again on every visit.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try { return localStorage.getItem('quantumy:sidebar-collapsed') === '1' } catch { return false }
  })
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [messagesLoading, setMessagesLoading] = useState(false)
  const messagesCacheRef = useRef<Map<string, ChatMessage[]>>(new Map())
  const activeLoadRef = useRef<string | null>(null)
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  /** Conversation IDs with an in-flight generation (survives chat switches) */
  const [generatingConvIds, setGeneratingConvIds] = useState<Record<string, true>>({})
  const generatingConvIdsRef = useRef<Record<string, true>>({})
  const [conversations, setConversations] = useState<Conversation[]>([])
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(null)
  const [hasEarlier, setHasEarlier] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  // Oldest message timestamp loaded per conversation — the cursor for paging back.
  const oldestLoadedRef = useRef<Record<string, string | null>>({})
  const [projects, setProjects] = useState<Project[]>([])
  const [currentProjectId, setCurrentProjectId] = useState<string | null>(null)
  const [pendingFiles, setPendingFiles] = useState<PendingFile[]>([])
  const [approvals, setApprovals] = useState<ApprovalCardState[]>([])
  const thinkStartedAt = useRef<number | null>(null)
  const [thoughtSeconds, setThoughtSeconds] = useState<number | null>(null)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [showSettings, setShowSettings] = useState(false)
  const [showConnectors, setShowConnectors] = useState(false)
  const [showCommandPalette, setShowCommandPalette] = useState(false)
  // Projects and Notes are pages, not dialogs: they replace the conversation in
  // the main column while the sidebar stays put, so getting back to a chat is
  // one click on the chat you want rather than dismissing a sheet first.
  const [page, setPage] = useState<WorkspacePage>('chat')
  const [openProjectId, setOpenProjectId] = useState<string | null>(null)
  const [glowDone, setGlowDone] = useState(false)
  const [composerFocused, setComposerFocused] = useState(false)
  const [voiceLanguage] = useState<VoiceLanguage>(() => {
    try {
      const v = localStorage.getItem('quantumy-language')
      if (v === 'en' || v === 'ha') return v
    } catch { /* ignore */ }
    return 'en'
  })
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [lastUserPrompt, setLastUserPrompt] = useState('')
  const [greetingLine, setGreetingLine] = useState('')
  const [errorHint, setErrorHint] = useState<string | null>(null)
  const [toolStatus, setToolStatus] = useState<string | null>(null)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const abortRef = useRef<AbortController | null>(null)
  /** Per-conversation abort controllers so switching chats never kills background work */
  const abortByConvRef = useRef<Map<string, AbortController>>(new Map())
  const messagesRef = useRef<ChatMessage[]>([])
  const currentConversationIdRef = useRef<string | null>(null)
  const [activeConnectors, setActiveConnectors] = useState<string[]>([])

  const loadActiveConnectors = useCallback(async () => {
    const uid = session?.user?.id
    if (!uid) {
      setActiveConnectors([])
      return
    }
    try {
      const { data } = await supabase
        .from('connectors')
        .select('provider')
        .eq('user_id', uid)
        .eq('status', 'connected')
      if (data) {
        setActiveConnectors(data.map((r: any) => r.provider))
      }
    } catch {
      /* ignore */
    }
  }, [session?.user?.id])

  useEffect(() => {
    loadActiveConnectors()
  }, [loadActiveConnectors, showConnectors])

  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => { currentConversationIdRef.current = currentConversationId }, [currentConversationId])
  useEffect(() => { generatingConvIdsRef.current = generatingConvIds }, [generatingConvIds])
  useEffect(() => {
    document.documentElement.classList.toggle('glass-on', glass)
    try { localStorage.setItem('quantumy-glass', glass ? '1' : '0') } catch {}
  }, [glass])

  useEffect(() => {
    const root = document.documentElement
    const apply = () => {
      const vv = window.visualViewport
      if (vv) {
        root.style.setProperty('--app-vh', Math.round(vv.height) + 'px')
        root.style.setProperty('--app-offset', Math.round(vv.offsetTop) + 'px')
      } else {
        root.style.setProperty('--app-vh', window.innerHeight + 'px')
        root.style.setProperty('--app-offset', '0px')
      }
    }
    apply()
    const vv = window.visualViewport
    vv?.addEventListener('resize', apply)
    vv?.addEventListener('scroll', apply)
    window.addEventListener('resize', apply)
    window.addEventListener('orientationchange', apply)
    return () => {
      vv?.removeEventListener('resize', apply)
      vv?.removeEventListener('scroll', apply)
      window.removeEventListener('resize', apply)
      window.removeEventListener('orientationchange', apply)
    }
  }, [])

  useEffect(() => {
    const empty = messages.length === 0 && !isLoading
    document.documentElement.classList.toggle('is-empty-chat', empty)
    return () => document.documentElement.classList.remove('is-empty-chat')
  }, [messages.length, isLoading])

  useEffect(() => {
    try { localStorage.setItem('quantumy:sidebar-collapsed', sidebarCollapsed ? '1' : '0') } catch { /* private mode */ }
  }, [sidebarCollapsed])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault()
        setShowCommandPalette((v) => !v)
        return
      }
      if (mod && (e.key === 'b' || e.key === 'B') && !e.shiftKey) {
        // Deliberately works while typing too: mod+B does nothing in a plain
        // textarea, and reaching for the mouse mid-sentence is the whole
        // problem a shortcut exists to solve.
        e.preventDefault()
        setSidebarCollapsed((v) => !v)
        return
      }
      if (mod && (e.key === 'n' || e.key === 'N') && !e.shiftKey) {
        const t = e.target as HTMLElement | null
        const tag = t?.tagName?.toLowerCase()
        if (tag === 'input' || tag === 'textarea' || t?.isContentEditable) return
        e.preventDefault()
        setShowCommandPalette(false)
        setPage('chat')
        setMessages([])
        setHasEarlier(false)
    setCurrentConversationId(null)
        setIsLoading(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (isLoading) { setGlowDone(false); return }
    if (messages.length === 0) return
    setGlowDone(true)
    const t = window.setTimeout(() => setGlowDone(false), 700)
    return () => clearTimeout(t)
  }, [isLoading])

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => { setSession(data.session); setAuthLoading(false) })
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_e, s) => { setSession(s); setAuthLoading(false) })
    return () => subscription.unsubscribe()
  }, [])

  // Pending Confirm cards carry the text of mails and events and belong to the account that was signed in when they were
  // created. Drop them whenever the signed-in user changes, sign-out included (a token refresh keeps the same id), so the
  // next person using this browser never sees them. The server rejects another user's approval id anyway.
  const sessionUserId = session?.user?.id
  useEffect(() => { setApprovals([]) }, [sessionUserId])

  const user = session?.user
  const firstName =
    user?.user_metadata?.preferred_name ||
    user?.user_metadata?.full_name?.split(' ')?.[0] ||
    user?.user_metadata?.name?.split(' ')?.[0] ||
    user?.email?.split('@')?.[0] ||
    'there'

  const loadConversations = useCallback(async () => {
    if (!user) return
    const { data } = await supabase.from('conversations').select('*').eq('user_id', user.id).order('updated_at', { ascending: false }).limit(50)
    if (data) setConversations(data as Conversation[])
  }, [user])

  const loadProjects = useCallback(async () => {
    if (!user) return
    const { data } = await supabase.from('projects').select('*').eq('user_id', user.id).order('updated_at', { ascending: false })
    if (data) setProjects(data as Project[])
  }, [user])

  useEffect(() => { if (user) { loadConversations(); loadProjects() } }, [user, loadConversations, loadProjects])

  const createProject = async (name: string, description?: string, color?: string) => {
    if (!user) return
    const { data, error } = await supabase.from('projects').insert({ user_id: user.id, name: name.trim(), description: description?.trim() || null, color: color || '#0a0a0a' }).select().single()
    if (error || !data) throw error || new Error('Could not create project')
    setProjects((prev) => [data as Project, ...prev])
    setCurrentProjectId(data.id)
  }

  const updateProject = async (id: string, patch: { name?: string; description?: string | null; color?: string }) => {
    if (!user) return
    const { data, error } = await supabase.from('projects').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).eq('user_id', user.id).select().single()
    if (error || !data) throw error || new Error('Could not update project')
    setProjects((prev) => prev.map((p) => (p.id === id ? (data as Project) : p)))
  }

  const deleteProject = async (id: string) => {
    if (!user) return
    await supabase.from('conversations').update({ project_id: null }).eq('project_id', id).eq('user_id', user.id)
    await supabase.from('projects').delete().eq('id', id).eq('user_id', user.id)
    setProjects((prev) => prev.filter((p) => p.id !== id))
    if (currentProjectId === id) setCurrentProjectId(null)
  }

  const openNotesForProject = (id: string) => {
    setCurrentProjectId(id)
    setPage('notes')
  }

  const openProjectPage = (id: string) => {
    setCurrentProjectId(id)
    setOpenProjectId(id)
    setPage('project')
  }

  const newChatInProject = (id: string) => {
    setCurrentProjectId(id)
    setOpenProjectId(null)
    startNewChat()
  }

  const selectChatFromDashboard = (id: string) => {
    setOpenProjectId(null)
    loadMessages(id)
  }

  /** Turns fetched per page. Large enough that most chats open complete. */
  const MESSAGE_PAGE_SIZE = 50

  const loadMessages = async (conversationId: string) => {
    if (currentConversationId && currentConversationId !== conversationId) {
      messagesCacheRef.current.set(currentConversationId, messages)
    }
    // Opening a chat is also how you leave a workspace page — from the sidebar,
    // which stays on screen, so there is nothing to dismiss first.
    setPage('chat')
    if (conversationId === currentConversationId) return
    activeLoadRef.current = conversationId
    setCurrentConversationId(conversationId)
    setMobileSidebar(false)
    setErrorHint(null)
    setComposerFocused(false)
    // Do NOT abort in-flight generations — they keep running in the background
    setIsLoading(!!generatingConvIdsRef.current[conversationId])
    setToolStatus(null)
    setSuggestions([])
    const cached = messagesCacheRef.current.get(conversationId)
    if (cached) { setMessages(cached); setMessagesLoading(false) }
    else { setMessages([]); setMessagesLoading(true) }
    // Two things made long chats slow to open. select('*') pulled every column
    // including content_tsv, the search vector added alongside full-text search
    // — a large blob per row that the UI never reads. And there was no limit at
    // all: attachments live inline in content as base64 data URLs, so one chat
    // with a few PDFs in it is tens of megabytes before a single word renders.
    // Newest page first, with older turns fetched on request.
    const { data } = await supabase
      .from('messages')
      .select('id, role, content, created_at')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: false })
      .limit(MESSAGE_PAGE_SIZE + 1)
    if (activeLoadRef.current !== conversationId) return
    // If this chat is still generating in the background, prefer live cache over DB snapshot
    if (generatingConvIdsRef.current[conversationId] && messagesCacheRef.current.has(conversationId)) {
      setMessages(messagesCacheRef.current.get(conversationId) || [])
      setIsLoading(true)
    } else if (data) {
      // One extra row is requested purely to answer "is there more?" without a
      // second count query; it is dropped before display.
      const page = (data as DbMessage[]).slice(0, MESSAGE_PAGE_SIZE).reverse()
      setHasEarlier(data.length > MESSAGE_PAGE_SIZE)
      oldestLoadedRef.current[conversationId] = page[0]?.created_at ?? null
      const mapped = page.map((m) => ({ id: m.id, role: m.role, content: m.content }))
      messagesCacheRef.current.set(conversationId, mapped)
      setMessages(mapped)
      setIsLoading(false)
    }
    setMessagesLoading(false)
  }

  const startNewChat = () => {
    setPage('chat')
    if (currentConversationId) messagesCacheRef.current.set(currentConversationId, messages)
    activeLoadRef.current = null
    // Keep background generations running — only explicit Stop aborts
    setIsLoading(false)
    setMessagesLoading(false)
    setSuggestions([])
    setToolStatus(null)
    setCurrentConversationId(null)
    setMessages([])
    setMobileSidebar(false)
    setErrorHint(null)
    setComposerFocused(false)
    setGreetingLine(creativeGreeting(firstName))
  }

  const ensureConversation = async (firstUserText: string) => {
    if (currentConversationId) return currentConversationId
    const clean = stripAttachmentsForTitle(firstUserText)
    const title = makeChatTitle(clean || 'New chat')
    const { data, error } = await supabase.from('conversations').insert({ user_id: user.id, title, project_id: currentProjectId || null }).select().single()
    if (error || !data) throw error || new Error('Could not create conversation')
    setCurrentConversationId(data.id)
    setConversations((prev) => [data as Conversation, ...prev])
    return data.id as string
  }

  const refineConversationTitle = async (conversationId: string, userText: string, assistantText: string) => {
    try {
      const userClean = stripAttachmentsForTitle(userText)
      let title: string | null = null
      try {
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (session?.access_token) headers.Authorization = 'Bearer ' + session.access_token
        const res = await fetch('/api/title', { method: 'POST', headers, body: JSON.stringify({ userText: userClean, assistantText: assistantText.slice(0, 800) }) })
        if (res.ok) {
          const data = await res.json()
          if (data?.title) title = data.title
        }
      } catch { /* fall through */ }
      if (!title) {
        let source = userClean
        if (!source || source.length < 8) source = assistantText.replace(/\s+/g, ' ').trim().slice(0, 80)
        title = makeChatTitle(source)
      }
      if (!title || title === 'New chat') return
      await supabase.from('conversations').update({ title, updated_at: new Date().toISOString() }).eq('id', conversationId)
      setConversations((prev) => prev.map((c) => (c.id === conversationId ? { ...c, title } : c)))
    } catch { /* best-effort */ }
  }

  const fetchSuggestions = async (userText: string, assistantText: string) => {
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      if (session?.access_token) headers.Authorization = 'Bearer ' + session.access_token
      const res = await fetch('/api/suggestions', { method: 'POST', headers, body: JSON.stringify({ userText, assistantText: assistantText.slice(0, 1500) }) })
      if (!res.ok) return
      const data = await res.json()
      if (Array.isArray(data?.suggestions) && data.suggestions.length) setSuggestions(data.suggestions)
    } catch { /* best-effort */ }
  }

  const saveMessage = async (conversationId: string, role: 'user' | 'assistant', content: string) => {
    await supabase.from('messages').insert({ conversation_id: conversationId, role, content })
    await supabase.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId)
  }

  const deleteConversation = async (id: string) => {
    setDeletingId(id)
    try {
      await supabase.from('messages').delete().eq('conversation_id', id)
      await supabase.from('conversations').delete().eq('id', id)
      setConversations((prev) => prev.filter((c) => c.id !== id))
      if (currentConversationId === id) startNewChat()
    } finally { setDeletingId(null) }
  }


  /** Update messages for a conversation — writes cache always; live UI only if that chat is open */
  const applyMessagesForConv = (convId: string, updater: (prev: ChatMessage[]) => ChatMessage[]) => {
    const viewing = currentConversationIdRef.current === convId
    if (viewing) {
      setMessages((prev) => {
        const next = updater(prev)
        messagesCacheRef.current.set(convId, next)
        messagesRef.current = next
        return next
      })
    } else {
      const prev = messagesCacheRef.current.get(convId) || []
      const next = updater(prev)
      messagesCacheRef.current.set(convId, next)
    }
  }

  const loadEarlierMessages = async () => {
    const convId = currentConversationIdRef.current
    if (!convId || loadingEarlier) return
    const cursor = oldestLoadedRef.current[convId]
    if (!cursor) return
    setLoadingEarlier(true)
    try {
      const { data } = await supabase
        .from('messages')
        .select('id, role, content, created_at')
        .eq('conversation_id', convId)
        .lt('created_at', cursor)
        .order('created_at', { ascending: false })
        .limit(MESSAGE_PAGE_SIZE + 1)
      if (!data) return
      const page = (data as DbMessage[]).slice(0, MESSAGE_PAGE_SIZE).reverse()
      setHasEarlier(data.length > MESSAGE_PAGE_SIZE)
      if (page.length > 0) oldestLoadedRef.current[convId] = page[0].created_at ?? null
      const older = page.map((m) => ({ id: m.id, role: m.role, content: m.content }))
      applyMessagesForConv(convId, (prev) => [...older, ...prev])
    } finally {
      setLoadingEarlier(false)
    }
  }

  const streamAI = async (userMessage: string, history: ChatMessage[], assistantId: string, convId: string) => {
    const setToolIfViewing = (v: string | null) => {
      if (currentConversationIdRef.current === convId) setToolStatus(v)
    }
    const model = MODEL
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'text/event-stream' }
    if (session?.access_token) headers.Authorization = 'Bearer ' + session.access_token
    // Abort only a previous request for THIS conversation, not other chats
    try { abortByConvRef.current.get(convId)?.abort() } catch { /* ignore */ }
    const ac = new AbortController()
    abortByConvRef.current.set(convId, ac)
    // Keep global abortRef for the currently viewed chat's Stop button
    if (currentConversationIdRef.current === convId) abortRef.current = ac
    const buildHistoryPayload = (h: ChatMessage[]) =>
      h.map((m) => ({
        role: m.role,
        content:
          m.role === 'user'
            ? String(m.content || '')
                .replace(/!\[[^\]]*\]\(data:image\/[^)]+\)/g, '[Image attached]')
                .replace(/\[[^\]]*\]\(data:application\/pdf[^)]+\)/g, '[PDF attached]')
            : m.content,
      }))

    // Hard client-side cap: a conversation that's accumulated enough messages
    // (e.g. repeated failed sends during a bad connection) can otherwise grow
    // the request body past Vercel's payload limit, which gets rejected
    // before any of our code runs — every future send in that thread fails,
    // even "hello". Keep the most recent messages within a safe budget.
    const MAX_SEND_HISTORY_CHARS = 200_000
    const cappedHistory = (() => {
      let total = 0
      const kept: ChatMessage[] = []
      for (let i = history.length - 1; i >= 0; i--) {
        const len = JSON.stringify(history[i].content ?? '').length
        if (kept.length > 0 && total + len > MAX_SEND_HISTORY_CHARS) break
        kept.unshift(history[i])
        total += len
      }
      return kept
    })()

    const sendChat = (h: ChatMessage[], stream: boolean) =>
      fetch('/api/chat', {
        method: 'POST',
        headers: stream
          ? headers
          : { 'Content-Type': 'application/json', ...(session?.access_token ? { Authorization: 'Bearer ' + session.access_token } : {}) },
        signal: ac.signal,
        body: JSON.stringify({
          messages: [...buildHistoryPayload(h), { role: 'user', content: userMessage }],
          firstName,
          projectId: currentProjectId,
          conversationId: convId,
          model: model.anthropic,
          modelId: model.id,
          stream,
        }),
      })

    let response = await sendChat(cappedHistory, true)
    if (response.status === 413 && cappedHistory.length > 0) {
      // Even the capped history was too large for this thread — forget the
      // backlog entirely and send just this message so the conversation can
      // keep going instead of failing forever.
      response = await sendChat([], true)
    }
    const ctype = response.headers.get('content-type') || ''
    if (!ctype.includes('text/event-stream')) {
      const data = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(data.error || data.message || data.hint || 'Request failed')
      if (!data.content) throw new Error(data.error || 'Empty response')
      applyMessagesForConv(convId, (p) => p.map((m) => (m.id === assistantId ? { ...m, content: data.content } : m)))
      return data.content as string
    }
    if (!response.ok || !response.body) {
      const data = await response.json().catch(() => ({}))
      throw new Error(data.error || data.message || 'Request failed')
    }
    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''
    let streamError: string | null = null
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n')
        buffer = parts.pop() || ''
        for (const line of parts) {
          const trimmed = line.trim()
          if (!trimmed.startsWith('data:')) continue
          const payload = trimmed.slice(5).trim()
          if (payload === '[DONE]') continue
          try {
            const evt = JSON.parse(payload)
            if (evt.status === 'started') continue
            if (evt.status === 'approval_required' && evt.approval) {
              setApprovals((p) => addApprovalCard(p, evt.approval))
              continue
            }
            if (evt.status === 'tool_use') {
              const names = Array.isArray(evt.tools) ? evt.tools.filter(Boolean) : []
              const label = (typeof evt.message === 'string' && evt.message) || (names.length ? names.join(' · ') : evt.tool || 'Working…')
              setToolIfViewing(String(label))
              continue
            }
            if (evt.status === 'tool_done') {
              const name = evt.tool || 'tool'
              setToolIfViewing(evt.ok === false ? `Failed: ${name}` : `Done: ${name}`)
              continue
            }
            if (typeof evt.error === 'string' && evt.error && !evt.status) streamError = evt.error
            if (typeof evt.delta === 'string' && evt.delta) {
              setToolIfViewing(null)
              full += evt.delta
              applyMessagesForConv(convId, (p) => p.map((m) => (m.id === assistantId ? { ...m, content: full } : m)))
            } else if (typeof evt.content === 'string' && evt.content) {
              setToolIfViewing(null)
              if (evt.content.length >= full.length) full = evt.content
              else if (!full) full = evt.content
              applyMessagesForConv(convId, (p) => p.map((m) => (m.id === assistantId ? { ...m, content: full } : m)))
            }
          } catch (e: any) {
            if (e?.message && e.message !== 'Unexpected end of JSON input' && !String(e.message).includes('JSON')) throw e
          }
        }
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return full
      throw err
    }
    if (full.trim()) return full
    try {
      setToolIfViewing('Retrying…')
      let retry = await sendChat(cappedHistory, false)
      if (retry.status === 413 && cappedHistory.length > 0) {
        retry = await sendChat([], false)
      }
      const data = await retry.json().catch(() => ({}))
      if (retry.ok && data.content) {
        full = String(data.content)
        applyMessagesForConv(convId, (p) => p.map((m) => (m.id === assistantId ? { ...m, content: full } : m)))
        setToolIfViewing(null)
        return full
      }
      streamError = streamError || data.error || data.message || null
    } catch { /* ignore */ }
    throw new Error(streamError || 'No reply received. Try again in a moment.')
  }

  const handleStop = useCallback(() => {
    const id = currentConversationIdRef.current
    if (id && abortByConvRef.current.has(id)) {
      try { abortByConvRef.current.get(id)?.abort() } catch { /* ignore */ }
      abortByConvRef.current.delete(id)
    } else {
      try { abortRef.current?.abort() } catch { /* ignore */ }
    }
  }, [])

  const handleResendUser = (text: string) => {
    const t = (text || '').trim()
    if (!t || isLoading) return
    void handleSend(t)
  }

  const handleEditUser = (messageId: string, newText: string) => {
    const t = (newText || '').trim()
    if (!t || isLoading) return
    const idx = messages.findIndex((m) => m.id === messageId)
    if (idx < 0) return
    const history = messages.slice(0, idx)
    setMessages(history)
    messagesRef.current = history
    void handleSend(t)
  }

  const handleSend = async (overrideText?: string) => {
    const textPart = (overrideText ?? input).trim()
    const files = pendingFiles
    const content = buildUserContent(textPart, files)
    // Block only if THIS conversation is already generating (others can run in background)
    const viewingId = currentConversationIdRef.current
    if (!content || !user) return
    if (viewingId && generatingConvIdsRef.current[viewingId]) return
    if (!viewingId && isLoading) return
    const history = messages
    const userMsg: ChatMessage = { id: generateId(), role: 'user', content }
    const assistantId = generateId()
    setMessages((p) => [...p, userMsg, { id: assistantId, role: 'assistant', content: '' }])
    setInput('')
    setPendingFiles([])
    setLastUserPrompt(content)
    setErrorHint(null)
    setToolStatus(null)
    setComposerFocused(false)
    setIsLoading(true)
    setSuggestions([])
    thinkStartedAt.current = Date.now()
    setThoughtSeconds(null)
    let convId: string | null = null
    try {
      convId = await ensureConversation(content)
      // Mark this conversation as generating (background-safe)
      setGeneratingConvIds((prev) => ({ ...prev, [convId!]: true }))
      // Seed cache so background updates have a base list
      messagesCacheRef.current.set(convId, [...history, userMsg, { id: assistantId, role: 'assistant', content: '' }])
      await saveMessage(convId, 'user', content)
      const reply = await streamAI(content, history, assistantId, convId)
      if (reply && reply.trim()) {
        await saveMessage(convId, 'assistant', reply)
        if (history.length === 0) await refineConversationTitle(convId, content, reply)
        if (reply.trim().split(/\s+/).length >= 25) void fetchSuggestions(content, reply)
        else setSuggestions([])
      } else {
        convId
          ? applyMessagesForConv(convId, (p) => p.filter((m) => m.id !== assistantId))
          : setMessages((p) => p.filter((m) => m.id !== assistantId))
      }
      await loadConversations()
    } catch (err: any) {
      if (err?.name === 'AbortError') {
        const partial = messagesRef.current.find((m) => m.id === assistantId)?.content || ''
        if (partial.trim() && convId) {
          try { await saveMessage(convId, 'assistant', partial) } catch { /* best-effort */ }
        } else if (!partial.trim()) {
          convId
          ? applyMessagesForConv(convId, (p) => p.filter((m) => m.id !== assistantId))
          : setMessages((p) => p.filter((m) => m.id !== assistantId))
        }
        return
      }
      setErrorHint(err?.message || 'Something went wrong. Please try again.')
      setToolStatus(null)
      if (convId) {
        applyMessagesForConv(convId, (p) => {
          const m = p.find((x) => x.id === assistantId)
          if (!m || !m.content.trim()) return p.filter((x) => x.id !== assistantId)
          return p
        })
      } else {
        setMessages((p) => {
          const m = p.find((x) => x.id === assistantId)
          if (!m || !m.content.trim()) return p.filter((x) => x.id !== assistantId)
          return p
        })
      }
    } finally {
      if (thinkStartedAt.current) {
        setThoughtSeconds(Math.max(1, Math.round((Date.now() - thinkStartedAt.current) / 1000)))
        thinkStartedAt.current = null
      }
      if (convId) {
        setGeneratingConvIds((prev) => {
          const next = { ...prev }
          delete next[convId!]
          return next
        })
        // Only clear loading UI if we're still viewing this conversation
        if (currentConversationIdRef.current === convId) {
          setIsLoading(false)
          setToolStatus(null)
        }
      } else {
        setIsLoading(false)
        setToolStatus(null)
      }
      if (convId) {
        abortByConvRef.current.delete(convId)
        if (currentConversationIdRef.current === convId) abortRef.current = null
      } else {
        abortRef.current = null
      }
    }
  }

  const isEmpty = messages.length === 0 && !isLoading && !messagesLoading
  const glowMode = isLoading ? 'thinking' : glowDone ? 'done' : 'idle'

  if (authLoading) {
    return (
      <div className="flex flex-col items-center justify-center h-dvh gap-4 bg-background">
        <Logo size={56} dark={false} />
        <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (!session || !user) return <Auth onSuccess={() => {}} />

  const sidebarProps = {
    dark, user, conversations, projects, currentConversationId, currentProjectId, deletingId,
    onNewChat: startNewChat, onSelectChat: loadMessages, onDeleteChat: deleteConversation,
    onOpenSettings: () => { setShowSettings(true); setMobileSidebar(false) },
    onOpenConnectors: () => { setShowConnectors(true); setMobileSidebar(false) },
    onOpenProjects: () => { setPage('projects'); setMobileSidebar(false) },
    onOpenNotes: () => { setPage('notes'); setMobileSidebar(false) },
    onSelectProject: setCurrentProjectId,
    onOpenCommandPalette: () => { setShowCommandPalette(true); setMobileSidebar(false) },
  }

  return (
    <div className={'app-root-shell flex overflow-hidden overscroll-none ' + (dark ? 'bg-transparent' : 'bg-transparent')}>
      <AnimatePresence initial={false}>
        {!sidebarCollapsed && (
          <motion.div
            key="desktop-sidebar"
            initial={{ width: 0 }}
            animate={{ width: 300 }}
            exit={{ width: 0 }}
            transition={{ type: 'tween', duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
            className="hidden lg:flex shrink-0 overflow-hidden"
          >
            {/* Fixed inner width so the contents hold their layout while the
                outer width animates, instead of reflowing every frame. */}
            <div className="w-[300px] h-full"><Sidebar {...sidebarProps} /></div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {mobileSidebar && (
          <>
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 bg-black/25 z-40 lg:hidden" onClick={() => setMobileSidebar(false)} />
            <motion.div initial={{ x: -320 }} animate={{ x: 0 }} exit={{ x: -320 }} transition={{ type: 'spring', damping: 32, stiffness: 360 }} className="fixed inset-y-0 left-0 z-50 w-[min(320px,90vw)] lg:hidden shadow-2xl bg-sidebar">
              <Sidebar {...sidebarProps} showClose onClose={() => setMobileSidebar(false)} />
            </motion.div>
          </>
        )}
      </AnimatePresence>
      <div className={'chat-shell-locked flex-1 flex flex-col min-w-0 min-h-0 h-full relative overflow-hidden overflow-x-hidden overscroll-none bg-background ' + (isEmpty && page === 'chat' ? 'chat-shell-empty ' : '')}>
        <div className={'chat-glow chat-glow--' + glowMode} aria-hidden>
          <div className="chat-glow-orb chat-glow-orb-a" />
          <div className="chat-glow-orb chat-glow-orb-b" />
          <div className="chat-glow-orb chat-glow-orb-c" />
        </div>
        {page !== 'chat' ? (
          <div className="relative z-10 flex-1 flex flex-col min-h-0 overflow-hidden">
            {/* The page's own top bar. It carries the same sidebar controls as
                the chat header so the panel can be collapsed or opened from
                here too, plus the one-click way back to the conversation. */}
            <div className="shrink-0 pt-[env(safe-area-inset-top)] border-b border-border/60">
              <div className="h-14 flex items-center gap-1 px-3">
                <button onClick={() => setMobileSidebar(true)} className="glass-btn lg:hidden w-10 h-10 rounded-full flex items-center justify-center transition text-foreground shrink-0" aria-label="Menu">
                  <Menu className="w-5 h-5" />
                </button>
                <button
                  type="button"
                  onClick={() => setSidebarCollapsed((v) => !v)}
                  className="glass-btn hidden lg:flex w-10 h-10 rounded-full items-center justify-center transition text-foreground shrink-0"
                  aria-label={(sidebarCollapsed ? 'Show' : 'Hide') + ' sidebar'}
                  aria-expanded={!sidebarCollapsed}
                  title={(sidebarCollapsed ? 'Show' : 'Hide') + ' sidebar (' + MOD_LABEL + 'B)'}
                >
                  <PanelLeft className="w-5 h-5" />
                </button>
                <nav className="flex-1 min-w-0 flex items-center gap-1 px-1 text-[14px]" aria-label="Breadcrumb">
                  {page === 'project' ? (
                    <>
                      <button type="button" onClick={() => { setOpenProjectId(null); setPage('projects') }} className="font-medium text-muted-foreground hover:text-foreground transition shrink-0">
                        Projects
                      </button>
                      <ChevronRight className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                      <span className="font-medium truncate">{projects.find((p) => p.id === openProjectId)?.name || 'Project'}</span>
                    </>
                  ) : (
                    <span className="font-medium truncate">{page === 'notes' ? 'Notes' : 'Projects'}</span>
                  )}
                </nav>
                <button
                  type="button"
                  onClick={() => setPage('chat')}
                  className="glass-btn h-10 px-3 rounded-full flex items-center gap-1.5 text-[14px] font-medium transition text-foreground shrink-0"
                  title="Back to chat (Esc)"
                >
                  <ArrowLeft className="w-4 h-4" />
                  <span className="hidden sm:inline">Back to chat</span>
                  <span className="sm:hidden">Chat</span>
                </button>
              </div>
            </div>
            <div className="flex-1 min-h-0 overflow-hidden">
              {/* A page is as wide as the window; its content should not be.
                  Capped and centred, it reads the same on a laptop and on an
                  ultrawide instead of stretching a note across three feet. */}
              <div className="h-full w-full max-w-[960px] mx-auto">
                {page === 'projects' && (
                  <ProjectsWorkspace
                    dark={dark}
                    user={user}
                    projects={projects}
                    conversations={conversations}
                    currentProjectId={currentProjectId}
                    onClose={() => setPage('chat')}
                    onSelectProject={setCurrentProjectId}
                    onCreateProject={createProject}
                    onUpdateProject={updateProject}
                    onDeleteProject={deleteProject}
                    onNewChat={startNewChat}
                    onOpenNotesForProject={openNotesForProject}
                    onOpenDashboard={openProjectPage}
                  />
                )}
                {page === 'project' && (
                  projects.find((p) => p.id === openProjectId) ? (
                    <ProjectDashboard
                      dark={dark}
                      user={user}
                      project={projects.find((p) => p.id === openProjectId)!}
                      conversations={conversations}
                      onClose={() => { setOpenProjectId(null); setPage('projects') }}
                      onUpdateProject={updateProject}
                      onDeleteProject={deleteProject}
                      onSelectChat={selectChatFromDashboard}
                      onNewChatInProject={() => openProjectId && newChatInProject(openProjectId)}
                    />
                  ) : (
                    // The project was deleted while open, or the id is stale.
                    <div className="h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
                      <p className="text-[15px] text-muted-foreground">That project is no longer available.</p>
                      <button type="button" onClick={() => { setOpenProjectId(null); setPage('projects') }} className="h-10 px-4 rounded-xl text-[14px] font-medium bg-primary text-primary-foreground hover:bg-primary/90">
                        Back to projects
                      </button>
                    </div>
                  )
                )}
                {page === 'notes' && (
                  <NotesDashboard
                    dark={dark}
                    user={user}
                    projects={projects}
                    currentProjectId={currentProjectId}
                    onClose={() => setPage('chat')}
                  />
                )}
              </div>
            </div>
          </div>
        ) : (
        <>
        {/* Absolute, not a flex row: in flow it reserved a band the messages
            could never enter, which is what made a transparent header still
            read as a solid bar. Overlaid, the conversation runs underneath it. */}
        <header className="glass-header absolute inset-x-0 top-0 pt-[env(safe-area-inset-top)] z-30">
          <div className="h-14 grid grid-cols-[1fr_auto_1fr] items-center px-3 gap-2">
            <div className="flex items-center justify-start min-w-0">
              <button onClick={() => setMobileSidebar(true)} className={'glass-btn lg:hidden w-10 h-10 rounded-full flex items-center justify-center transition text-foreground'} aria-label="Menu">
                <Menu className="w-5 h-5" />
              </button>
              <button
                type="button"
                onClick={() => setSidebarCollapsed((v) => !v)}
                className={'glass-btn hidden lg:flex w-10 h-10 rounded-full items-center justify-center transition text-foreground'}
                aria-label={(sidebarCollapsed ? 'Show' : 'Hide') + ' sidebar'}
                aria-expanded={!sidebarCollapsed}
                title={(sidebarCollapsed ? 'Show' : 'Hide') + ' sidebar (' + MOD_LABEL + 'B)'}
              >
                <PanelLeft className="w-5 h-5" />
              </button>
            </div>
            <div className="flex items-center justify-center gap-1.5 sm:gap-2.5 min-w-0">
              <div className="flex items-center gap-1.5 px-3 h-10 rounded-full text-[14px] font-medium text-foreground">
                <span className="truncate max-w-[100px] sm:max-w-none">{MODEL.name}</span>
              </div>
              <ConnectorStatusBadges
                activeConnectors={activeConnectors}
                onOpenConnectors={() => setShowConnectors(true)}
              />
            </div>
            <div className="flex items-center justify-end gap-1.5 min-w-0">
              <button type="button" onClick={cycleTheme} className={'glass-btn w-10 h-10 rounded-full flex items-center justify-center transition text-foreground'} aria-label={'Theme: ' + themeMode}>
                {dark ? <Moon className="w-5 h-5" /> : <Sun className="w-5 h-5" />}
              </button>
              {!isEmpty && (
                <button onClick={startNewChat} className={'glass-btn w-10 h-10 rounded-full flex items-center justify-center transition text-foreground'} aria-label="New chat">
                  <PenLine className="w-5 h-5" />
                </button>
              )}
            </div>
          </div>
        </header>
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-20 bg-gradient-to-b from-background via-background/80 to-transparent h-[calc(5.5rem+env(safe-area-inset-top))]"
          aria-hidden
        />
        <div className="relative z-10 flex-1 flex flex-col min-h-0 overflow-hidden">
          {messagesLoading ? (
            <div className="flex-1 flex items-center justify-center pt-[calc(3.5rem+env(safe-area-inset-top))]">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : isEmpty ? (
            <div className="flex-1 flex items-center justify-center px-4 pt-[calc(3.5rem+env(safe-area-inset-top))]">
              <EmptyState
                greeting={greetingLine || creativeGreeting(firstName)}
                dark={dark}
                composing={composerFocused}
                activeConnectors={activeConnectors}
                onOpenConnectors={() => setShowConnectors(true)}
              />
            </div>
          ) : (
            <main
              className="flex-1 overflow-y-auto overflow-x-hidden min-h-0 min-w-0 pt-[calc(3.5rem+env(safe-area-inset-top))]"
              data-scrollable="true"
            >
              <MessageList
                messages={messages}
                isLoading={isLoading}
                lastUserPrompt={lastUserPrompt}
                dark={dark}
                messagesEndRef={messagesEndRef}
                conversationId={currentConversationId}
                thoughtSeconds={thoughtSeconds}
                toolStatus={toolStatus}
                onRegenerate={() => { if (lastUserPrompt) handleSend(lastUserPrompt) }}
                onSuggestion={(s) => { setInput(s); void handleSend(s) }}
                onEditUser={handleEditUser}
                onResendUser={handleResendUser}
                suggestions={suggestions}
                hasEarlier={hasEarlier}
                loadingEarlier={loadingEarlier}
                onLoadEarlier={loadEarlierMessages}
              />
            </main>
          )}
          <div className="shrink-0">
            {isEmpty && (
              <div className="px-3 sm:px-4 pb-2 overflow-x-auto scrollbar-none">
                <div className="flex gap-2 w-max max-w-none mx-auto sm:flex-wrap sm:w-full sm:justify-center">
                  {EMPTY_STARTERS.map((s) => (
                    <button
                      key={s}
                      type="button"
                      onClick={() => { setInput(s); void handleSend(s) }}
                      className="text-[13px] font-medium px-3.5 py-2 rounded-full transition border whitespace-nowrap bg-secondary border-border text-foreground hover:bg-accent shadow-sm active:scale-[0.98]"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <ApprovalTray cards={approvals} setCards={setApprovals} accessToken={session?.access_token} />
            <ChatInput
              value={input}
              onChange={setInput}
              onSend={() => handleSend()}
              onStop={handleStop}
              language={voiceLanguage}
              isLoading={isLoading}
              dark={dark}
              errorHint={errorHint}
              pendingFiles={pendingFiles}
              onFilesChange={setPendingFiles}
              onFocusChange={setComposerFocused}
            />
          </div>
        </div>
        </>
        )}
        <InstallPWA dark={dark} />
      </div>
      <CommandPalette open={showCommandPalette} onClose={() => setShowCommandPalette(false)} dark={dark} conversations={conversations} projects={projects} currentConversationId={currentConversationId} currentProjectId={currentProjectId} onNewChat={startNewChat} onSelectChat={loadMessages} onSelectProject={setCurrentProjectId} onOpenSettings={() => setShowSettings(true)} onOpenConnectors={() => setShowConnectors(true)} onToggleTheme={() => setDark((d) => !d)} sidebarCollapsed={sidebarCollapsed} onToggleSidebar={() => setSidebarCollapsed((v) => !v)} />
      <AnimatePresence>
        {showSettings && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 bg-black/50" onClick={() => setShowSettings(false)}>
            <motion.div initial={{ y: 40 }} animate={{ y: 0 }} exit={{ y: 24 }} className="glass-sheet w-full sm:max-w-[430px] h-[min(92dvh,720px)] rounded-t-[28px] sm:rounded-[28px] overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <Settings dark={dark} glass={glass} user={user} onClose={() => setShowSettings(false)} onSignOut={async () => { await supabase.auth.signOut(); setShowSettings(false) }} onToggleTheme={() => setDark((d) => !d)} onToggleGlass={() => setGlass((g) => !g)} onOpenConnectors={() => { setShowSettings(false); setShowConnectors(true) }} onProfileUpdated={(name) => { setGreetingLine(creativeGreeting(name)); supabase.auth.getSession().then(({ data }) => setSession(data.session)) }} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
      <AnimatePresence>
        {showConnectors && session?.access_token && (
          <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-end sm:items-center justify-center sm:p-4 bg-black/50" onClick={() => setShowConnectors(false)}>
            <motion.div initial={{ y: 40 }} animate={{ y: 0 }} exit={{ y: 24 }} className="glass-sheet w-full sm:max-w-[430px] h-[min(92dvh,720px)] rounded-t-[28px] sm:rounded-[28px] overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <Connectors dark={dark} accessToken={session.access_token} onClose={() => setShowConnectors(false)} />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
