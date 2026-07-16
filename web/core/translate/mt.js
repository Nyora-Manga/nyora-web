// core/translate/mt.js — machine translation via the free Google web endpoint,
// a direct port of nyora-android's translator/Translator.kt (client=gtx). All
// bubbles of a page are joined with the same ||| delimiter Android uses and
// translated in ONE request; if the split comes back misaligned, fall back to
// one request per block.

const DELIM = '\n\n\n|||\n\n\n';

// Target languages offered in the reader settings (Google translate codes).
export const TL_LANGS = [
  ['en', 'English'], ['es', 'Spanish'], ['pt', 'Portuguese'], ['fr', 'French'],
  ['de', 'German'], ['it', 'Italian'], ['ru', 'Russian'], ['id', 'Indonesian'],
  ['ar', 'Arabic'], ['tr', 'Turkish'], ['pl', 'Polish'], ['vi', 'Vietnamese'],
  ['th', 'Thai'], ['hi', 'Hindi'], ['ko', 'Korean'], ['zh-CN', 'Chinese'],
];

// Source (page) languages the OCR engines support. 'auto' resolves from the
// manga source's language in the reader.
export const TL_SOURCES = [
  ['auto', 'Auto (source language)'], ['ja', 'Japanese'], ['zh', 'Chinese'],
  ['ko', 'Korean'], ['en', 'English'],
];

// OCR language → Google translate source code.
const GTX_SOURCE = { ja: 'ja', zh: 'zh-CN', ko: 'ko', en: 'en' };

async function gtx(text, target, source = 'auto') {
  const url = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t'
    + `&sl=${encodeURIComponent(source)}&tl=${encodeURIComponent(target)}`
    + `&q=${encodeURIComponent(text)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`translate failed (${res.status})`);
  const data = await res.json();
  return ((data && data[0]) || []).map((seg) => (seg && seg[0]) || '').join('');
}

// LLM refinement (port of Android's translatePageDialoguesAtOnce): one
// OpenAI-compatible chat call per page, all dialogues joined with ' ||| ' in
// reading order so the model keeps them coherent. Returns null when the reply
// can't be split back cleanly — callers keep the fast MT text then.
export const AI_DEFAULTS = {
  openai: { endpoint: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  anthropic: { endpoint: 'https://api.anthropic.com', model: 'claude-haiku-4-5-20251001' },
};

export async function refineBatch(originals, drafts, target, cfg) {
  const langName = (TL_LANGS.find(([c]) => c === target) || [null, 'English'])[1];
  const system = 'You are an expert manga translator. Translate each dialogue segment into '
    + langName + ', preserving tone and keeping lines short enough for speech bubbles. '
    + 'The segments come from ONE manga page in reading order — keep them coherent with each other. '
    + (cfg.context ? '\nUse this series context for accurate character names and terms:\n' + cfg.context + '\n' : '')
    + 'Reply with ONLY the translated segments, in the same order, separated by " ||| ". '
    + 'No numbering, no commentary, and exactly ' + originals.length + ' segments.';
  const user = 'Original segments:\n' + originals.join('\n|||\n')
    + (drafts && drafts.length === originals.length
      ? '\n\nDraft machine translations (improve on these):\n' + drafts.join('\n|||\n')
      : '');

  const defaults = AI_DEFAULTS[cfg.provider] || AI_DEFAULTS.openai;
  const endpoint = String(cfg.endpoint || defaults.endpoint).replace(/\/+$/, '');
  const model = cfg.model || defaults.model;

  let out = '';
  if (cfg.provider === 'anthropic') {
    const res = await fetch(`${endpoint}/v1/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': cfg.apiKey,
        'anthropic-version': '2023-06-01',
        // Anthropic requires this opt-in for direct browser (CORS) calls.
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model,
        max_tokens: 4096,
        system,
        messages: [{ role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`AI refinement failed (${res.status})`);
    const data = await res.json();
    out = String((data.content && data.content[0] && data.content[0].text) || '').trim();
  } else {
    const res = await fetch(`${endpoint}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0.3,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      }),
    });
    if (!res.ok) throw new Error(`AI refinement failed (${res.status})`);
    const data = await res.json();
    out = String((data.choices && data.choices[0] && data.choices[0].message
      && data.choices[0].message.content) || '').trim();
  }
  const parts = out.split(/\s*\|\|\|\s*/).map((s) => s.trim()).filter(Boolean);
  return parts.length === originals.length ? parts : null;
}

export async function translateBatch(texts, target, source = 'auto') {
  if (!texts.length) return [];
  source = GTX_SOURCE[source] || source || 'auto';
  try {
    const full = await gtx(texts.join(DELIM), target, source);
    const parts = full.split(/\s*\|\s*\|\s*\|\s*/).map((s) => s.trim());
    if (parts.length === texts.length) return parts;
  } catch { /* fall through to per-block */ }
  return Promise.all(texts.map((t) => gtx(t, target, source).then((s) => s.trim())));
}
