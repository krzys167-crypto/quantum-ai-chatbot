import { getUserFromAuthHeader } from './lib/supabaseAdmin.js';
import { allowRequest } from './lib/rateLimit.js';
import { recordUsage } from './lib/tokenUsage.js';
import { allowedOrigin } from './lib/cors.js';
import { GENERIC, fail, failUpstream } from './lib/publicError.js';

// Fires after most replies, so it is the one auxiliary call whose model choice
// shows up on the bill. Three short follow-up prompts do not need Sonnet.
const MODEL = 'claude-haiku-4-5';
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin());
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const userText = String(body?.userText || '').slice(0, 800);
    const assistantText = String(body?.assistantText || '').slice(0, 1500);
    if (!assistantText) return res.status(400).json({ error: 'assistantText required' });
    const user = await getUserFromAuthHeader(req);
    if (!user) return res.status(401).json({ error: 'Sign in required' });
    if (!allowRequest(`suggestions:${user.id}`, RATE_LIMIT, RATE_WINDOW_MS)) {
      return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 200,
        system:
          'Given one exchange from a chat, propose 2 to 3 short, specific follow-up actions the user might genuinely want next, each 2 to 6 words, phrased as something the user would say (a request or question), directly tied to what was actually discussed, not generic. Reply with ONLY a JSON array of strings, nothing else, no markdown fences.',
        messages: [
          { role: 'user', content: `User asked: ${userText}\n\nAssistant replied: ${assistantText}` },
        ],
      }),
    });
    if (!response.ok) return failUpstream(res, GENERIC.provider, 'Suggestions provider error:', response);
    const data = await response.json();
    await recordUsage({ userId: user.id, endpoint: 'suggestions', model: MODEL, usage: data.usage });
    const raw = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();
    let suggestions = [];
    try {
      const match = raw.match(/\[[\s\S]*\]/);
      const parsed = JSON.parse(match ? match[0] : raw);
      if (Array.isArray(parsed)) {
        suggestions = parsed
          .filter((s) => typeof s === 'string' && s.trim())
          .map((s) => s.trim())
          .slice(0, 3);
      }
    } catch {
      suggestions = [];
    }
    return res.status(200).json({ suggestions });
  } catch (err) {
    return fail(res, GENERIC.server, 'Suggestions handler error:', err);
  }
}
