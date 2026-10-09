/**
 * ElevenLabs Text-to-Speech proxy
 * - Uses ELEVENLABS_VOICE_* env when set
 * - Flash model + low bitrate + streaming latency opt
 * - Optional body.stream pipes ElevenLabs stream for earlier first-byte
 * POST { text, language?, voice_id?, stream? }
 */
import { getUserFromAuthHeader } from './lib/supabaseAdmin.js';
import { allowRequest } from './lib/rateLimit.js';
import { allowedOrigin } from './lib/cors.js';
import { GENERIC, fail, failUpstream } from './lib/publicError.js';

// Read-aloud chunks a reply into ~380-char pieces and prefetches ahead, so
// this needs headroom above chat's limit for a burst of legitimate use.
const RATE_LIMIT = 40;
const RATE_WINDOW_MS = 60_000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', allowedOrigin());
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const user = await getUserFromAuthHeader(req);
  if (!user) return res.status(401).json({ error: 'Sign in required' });
  if (!allowRequest(`tts:${user.id}`, RATE_LIMIT, RATE_WINDOW_MS)) {
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
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    let text = (body?.text || '').trim();
    if (!text) return res.status(400).json({ error: 'text is required' });

    text = text
      .replace(/\u2014/g, ',')
      .replace(/\u2013/g, '-')
      .replace(/\u2015/g, ',')
      .replace(/--+/g, ',')
      .replace(/\s+/g, ' ')
      .trim();

    // Hard cap keeps latency bounded (client should chunk longer text)
    const maxLen = body?.chunk ? 450 : 900;
    if (text.length > maxLen) {
      const cut = text.slice(0, maxLen);
      const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '), cut.lastIndexOf(', '));
      text = lastStop > 40 ? cut.slice(0, lastStop + 1) : cut;
    }

    const voiceId =
      body?.voice_id ||
      process.env.ELEVENLABS_VOICE_ID ||
      process.env.ELEVENLABS_VOICE_MALE ||
      process.env.ELEVENLABS_VOICE_HAUSA_MALE ||
      process.env.ELEVENLABS_VOICE ||
      'rPlZjuLXpONhaMouRFww';

    const lang = (body?.language || 'en').toLowerCase();
    const isHausa = lang === 'ha' || lang === 'hau' || lang === 'hausa';

    // eleven_v3 is the most expressive model ElevenLabs offers. It is also not
    // the one they recommend for interactive use — turbo is — so if it rejects
    // the request or is unavailable to this account, the call is retried once
    // on turbo rather than failing. Failing here would drop the client onto the
    // browser's own synthesiser, which is the robotic voice this is meant to
    // get away from, so a slightly lesser ElevenLabs voice always wins.
    const modelId = process.env.ELEVENLABS_TTS_MODEL || 'eleven_v3';
    const fallbackModelId = process.env.ELEVENLABS_TTS_FALLBACK_MODEL || 'eleven_turbo_v2_5';
    const languageCode = isHausa ? 'ha' : 'en';

    const payload = {
      text,
      model_id: modelId,
      language_code: languageCode,
      voice_settings: {
        // Low stability makes delivery wander and is a large part of why the
        // output reads as synthetic; raising it steadies the voice without
        // flattening it. Higher similarity keeps it closer to the source voice.
        stability: 0.5,
        similarity_boost: 0.85,
        style: 0.15,
        use_speaker_boost: true,
      },
    };

    const wantStream = body?.stream === true;
    const path = wantStream
      ? `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}/stream`
      : `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`;
    // The old settings were the single biggest cause of a robotic result:
    // 22 kHz at 32 kbps is telephone-grade, and latency level 4 is the most
    // aggressive tier, which ElevenLabs trades quality away for. 44.1 kHz at
    // 128 kbps with a moderate latency setting sounds like a different voice
    // for a few tens of milliseconds more.
    const outputFormat = process.env.ELEVENLABS_OUTPUT_FORMAT || 'mp3_44100_128';
    const latency = process.env.ELEVENLABS_LATENCY || '2';
    const url = `${path}?output_format=${encodeURIComponent(outputFormat)}&optimize_streaming_latency=${encodeURIComponent(latency)}`;

    const speak = (model) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'xi-api-key': apiKey,
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({ ...payload, model_id: model }),
      });

    let usedModel = modelId;
    let elRes = await speak(modelId);

    // A 4xx here means this account cannot use that model, or it will not take
    // these settings — both are permanent for this request, so retrying the
    // same call is pointless but a different model is worth one attempt. A 5xx
    // is ElevenLabs being unwell and is left to surface.
    if (!elRes.ok && elRes.status >= 400 && elRes.status < 500 && fallbackModelId && fallbackModelId !== modelId) {
      const firstError = await elRes.text().catch(() => '');
      console.warn(`TTS model ${modelId} refused (${elRes.status}), retrying on ${fallbackModelId}`, firstError.slice(0, 200));
      usedModel = fallbackModelId;
      elRes = await speak(fallbackModelId);
    }

    if (!elRes.ok) return failUpstream(res, GENERIC.tts, 'ElevenLabs TTS error', elRes, { voiceId, modelId: usedModel });

    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Voice-Id', voiceId);
    // Which model actually spoke, so a silent downgrade is still visible.
    res.setHeader('X-Model-Id', usedModel);

    if (wantStream && elRes.body && typeof elRes.body.getReader === 'function') {
      // Pipe stream through for lower time-to-first-byte
      const reader = elRes.body.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) res.write(Buffer.from(value));
        }
        return res.end();
      } catch (pipeErr) {
        console.error('TTS stream pipe error', pipeErr);
        return res.end();
      }
    }

    const audioBuf = Buffer.from(await elRes.arrayBuffer());
    res.setHeader('Content-Length', audioBuf.length);
    return res.status(200).send(audioBuf);
  } catch (err) {
    return fail(res, GENERIC.server, 'TTS handler error:', err);
  }
}
