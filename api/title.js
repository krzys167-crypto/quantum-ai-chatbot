import { getUserFromAuthHeader } from './lib/supabaseAdmin.js';
import { allowRequest } from './lib/rateLimit.js';
import { recordUsage } from './lib/tokenUsage.js';
import { allowedOrigin } from './lib/cors.js';
import { GENERIC, fail, failUpstream } from './lib/publicError.js';

// Naming a chat in six words is not work that repays a frontier model, and this
// fires once per conversation on the user's first exchange.
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
    const assistantText = String(body?.assistantText || '').slice(0, 800);
    if (!userText && !assistantText) return res.status(400).json({ error: 'userText or assistantText required' });
    const user = await getUserFromAuthHeader(req);
    if (!user) return res.status(401).json({ error: 'Sign in required' });
    if (!allowRequest(`title:${user.id}`, RATE_LIMIT, RATE_WINDOW_MS)) {
      return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
    }
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 20,
        system:
          'Generate a short chat title, 3 to 6 words, that captures the actual topic or intent of this exchange, not a generic label. No quotes, no trailing punctuation, no prefix like "Title:". Reply with only the title text.',
        messages: [{ role: 'user', content: `User: ${userText}\n\nAssistant: ${assistantText}` }],
      }),
    });
    if (!response.ok) return failUpstream(res, GENERIC.provider, 'Title provider error:', response);
    const data = await response.json();
    await recordUsage({ userId: user.id, endpoint: 'title', model: MODEL, usage: data.usage });
    const title = (data.content || [])
      .filter((b) => b.type === 'text')
      .map((b) => b.text)
      .join(' ')
      .trim();
    return res.status(200).json({ title: title || null });
  } catch (err) {
    return fail(res, GENERIC.server, 'Title handler error:', err);
  }
}
