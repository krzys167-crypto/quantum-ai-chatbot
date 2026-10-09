/**
 * ElevenLabs Speech-to-Text (Scribe) proxy
 * POST multipart/form-data with field "file" (audio)
 * or JSON { audioBase64, mimeType, language }
 * Returns { text, language_code? }
 */
import { getUserFromAuthHeader } from './lib/supabaseAdmin.js';
import { allowRequest } from './lib/rateLimit.js';
import { wordsToNumbers } from './lib/numberWords.js';
import { allowedOrigin } from './lib/cors.js';
import { GENERIC, fail, failUpstream } from './lib/publicError.js';

const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 60_000;

export const config = {
  api: {
    bodyParser: false, // we parse multipart / raw ourselves when needed
  },
};

/**
 * Map a caller's language hint to what Scribe expects (ISO-639-3), or to null
 * for auto-detect. Unknown codes are passed through rather than forced to
 * English: guessing wrong silently produces a confident, wrong transcript.
 */
const LANGUAGE_ALIASES = {
  en: 'eng', eng: 'eng', english: 'eng',
  ha: 'hau', hau: 'hau', hausa: 'hau',
  ar: 'ara', ara: 'ara', arabic: 'ara',
  fr: 'fra', fra: 'fra', fre: 'fra', french: 'fra',
  es: 'spa', spa: 'spa', spanish: 'spa',
  hi: 'hin', hin: 'hin', hindi: 'hin',
  ur: 'urd', urd: 'urd', urdu: 'urd',
  zh: 'zho', zho: 'zho', chi: 'zho', chinese: 'zho',
  tr: 'tur', tur: 'tur', turkish: 'tur',
  ru: 'rus', rus: 'rus', russian: 'rus',
  pt: 'por', por: 'por', portuguese: 'por',
  de: 'deu', deu: 'deu', ger: 'deu', german: 'deu',
};

export function resolveLanguage(language) {
  const key = String(language || '').trim().toLowerCase();
  if (!key || key === 'auto' || key === 'detect') return null;
  if (LANGUAGE_ALIASES[key]) return LANGUAGE_ALIASES[key];
  // Already a three-letter code we don't have an alias for — let Scribe judge it.
  if (/^[a-z]{3}$/.test(key)) return key;
  return null;
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin());
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUserFromAuthHeader(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  if (!allowRequest(`stt:${user.id}`, RATE_LIMIT, RATE_WINDOW_MS)) {
    return res.status(429).json({ error: 'Too many requests. Wait a moment and try again.' });
  }

  const apiKey = process.env.ELEVENLABS_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Missing ELEVENLABS_API_KEY',
      hint: 'Add ELEVENLABS_API_KEY in Vercel env vars and redeploy',
    });
  }

  try {
    const contentType = req.headers['content-type'] || '';
    let fileBlob;
    let language = 'en';
    // Speaker labels are worth having on an uploaded call and pointless on a
    // few seconds of dictation, so the caller decides.
    let diarize = false;

    if (contentType.includes('application/json')) {
      const raw = await readRawBody(req);
      const body = JSON.parse(raw.toString('utf8') || '{}');
      const b64 = body?.audioBase64 || body?.audio;
      if (!b64) return res.status(400).json({ error: 'audioBase64 is required' });
      const mime = body?.mimeType || 'audio/webm';
      const buf = Buffer.from(String(b64).replace(/^data:[^;]+;base64,/, ''), 'base64');
      if (buf.length < 100) return res.status(400).json({ error: 'Audio too short' });
      if (buf.length > 25 * 1024 * 1024) return res.status(400).json({ error: 'Audio too large (max 25MB)' });
      fileBlob = new Blob([buf], { type: mime });
      language = (body?.language || 'en').toLowerCase();
      diarize = !!body?.diarize;
    } else if (contentType.includes('multipart/form-data')) {
      // Vercel/Node may still parse; fall back to raw + manual boundary is heavy.
      // Prefer JSON base64 from the client for reliability on serverless.
      return res.status(400).json({
        error: 'Send JSON with audioBase64 instead of multipart on this endpoint',
      });
    } else {
      // Treat body as raw audio if Content-Type is audio/*
      const raw = await readRawBody(req);
      if (!raw?.length) return res.status(400).json({ error: 'Empty body' });
      const mime = contentType.startsWith('audio/') ? contentType : 'audio/webm';
      fileBlob = new Blob([raw], { type: mime });
      language = (req.headers['x-language'] || 'en').toLowerCase();
    }

    const languageCode = resolveLanguage(language);

    const form = new FormData();
    form.append('file', fileBlob, 'recording.webm');
    form.append('model_id', 'scribe_v2');
    // Omitted entirely when the caller asked for auto: Scribe then detects the
    // language itself, which matters for uploaded recordings where we have no
    // idea what was spoken. The mic button still pins a language as before.
    if (languageCode) form.append('language_code', languageCode);
    if (diarize) form.append('diarize', 'true');

    const elRes = await fetch('https://api.elevenlabs.io/v1/speech-to-text', {
      method: 'POST',
      headers: {
        'xi-api-key': apiKey,
      },
      body: form,
    });

    if (!elRes.ok) return failUpstream(res, GENERIC.stt, 'ElevenLabs STT error', elRes);

    const data = await elRes.json();

    // Speaker grouping happens here rather than on the client so the number
    // conversion below runs once, over finished lines. Doing it per word would
    // break every run apart and convert nothing.
    const words = Array.isArray(data?.words) ? data.words : [];
    const speakers = new Set(words.map((w) => w?.speaker_id).filter(Boolean));
    let assembled = String(data?.text || '').trim();
    let diarized = false;
    if (diarize && words.length > 0 && speakers.size > 1) {
      const lines = [];
      let current = null;
      let buf = '';
      for (const w of words) {
        const speaker = w?.speaker_id || current;
        if (speaker !== current) {
          if (buf.trim()) lines.push(`${current}: ${buf.trim()}`);
          current = speaker || null;
          buf = '';
        }
        buf += w?.text || '';
      }
      if (buf.trim()) lines.push(`${current}: ${buf.trim()}`);
      if (lines.length > 0) { assembled = lines.join('\n'); diarized = true; }
    }

    // Spoken figures come back as words. In a trade conversation the figures
    // are the whole point, so they are put back into digits before anyone
    // reads, searches or pastes the transcript.
    const text = wordsToNumbers(assembled);

    return res.status(200).json({
      text,
      diarized,
      language_code: data?.language_code || languageCode,
      words: data?.words || undefined,
    });
  } catch (err) {
    return fail(res, GENERIC.server, 'STT handler error:', err);
  }
}
