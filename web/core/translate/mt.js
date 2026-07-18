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

// --- manga-specific repair of the plain-MT output -------------------------
// Google is a general-purpose translator, so it mangles a handful of things
// that are ubiquitous in manga. Every rule below was written against observed
// live gtx output (see the JSDoc examples), not guessed at.

// Set phrases gtx reliably gets WRONG. It reads these as literal statements
// instead of the interjections they are: しまった！→"It's gone!",
// ヤバい→"It's dangerous". Short, high-frequency, and unambiguous in a speech
// bubble — so we answer them directly and never send them to Google.
const LEXICON = new Map([
  ['しまった', 'Damn it'], ['ヤバい', 'This is bad'], ['やばい', 'This is bad'],
  ['まずい', 'This is bad'], ['くそ', 'Damn'], ['くそっ', 'Damn it'],
  ['ちくしょう', 'Dammit'], ['やめろ', 'Stop it'], ['まさか', 'No way'],
  ['さすが', 'As expected'], ['よし', 'All right'], ['なるほど', 'I see'],
  ['うるさい', 'Shut up'], ['てめえ', 'You bastard'], ['ざけんな', 'Screw you'],
  ['どういうことだ', 'What do you mean'], ['ありえない', 'Impossible'],
]);

// gtx renders repeated full-width marks as spaced ASCII — 逃げろ！！ comes back
// "Run away! !" and なんだと！？ as "What! ?". It also leaves … untouched in
// some segments while converting it to ... in others.
const FULLWIDTH = { '！': '!', '？': '?', '。': '.', '、': ',', '．': '.', '，': ',' };
function asciiPunct(s) {
  return String(s).replace(/[！？。、．，]/g, (c) => FULLWIDTH[c]);
}

function fixPunct(s) {
  return s
    .replace(/([!?])(\s+[!?])+/g, (m) => m.replace(/\s+/g, '')) // "! ! !" → "!!!"
    .replace(/…/g, '...')
    .replace(/\.{4,}/g, '...')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// gtx inflates repeated characters far past the source: うわああああ (4 あ)
// comes back "Uwaaaaaaaaaaaaaaaaaaaa" (20 a). Clamp any run in the output to
// the longest run in the source so screams keep their original length.
function clampRuns(en, src) {
  const m = src.match(/(.)\1+/g);
  // No run in the source means there is nothing to clamp AGAINST — bailing out
  // matters, because otherwise a max of 1 would flatten legitimate English
  // elongation that the translation introduced on its own (ぐっ → "Nnngh" must
  // not become "Ngh").
  if (!m) return en;
  let max = 2;
  for (const r of m) max = Math.max(max, r.length);
  return en.replace(/(\p{L})\1{2,}/gu, (run, ch) => ch.repeat(Math.min(run.length, max)));
}

// A stutter (ま、まさか… / だ、誰だお前は) is a first-mora repeat. Sent as-is,
// gtx translates the stray mora as its own word — "Well, no way..." and
// "Who are you?" (stutter dropped). So we strip it before translating and
// re-apply it to the English, which is what a scanlator would letter:
// "N-no way..." / "W-who are you?"
const STUTTER = /^(.)[、,]\s*(?=\1)/;
function stripStutter(t) {
  return STUTTER.test(t) ? { text: t.replace(STUTTER, ''), stutter: true } : { text: t, stutter: false };
}
function restoreStutter(en) {
  const m = en.match(/^([A-Za-z])(\w*)/);
  if (!m) return en;
  return `${m[1]}-${m[1].toLowerCase()}${en.slice(1)}`;
}

// gtx leaves subject-less fragments lowercase (俺たちは仲間だろ → "we are friends").
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function polish(en, src, stutter) {
  let out = fixPunct(String(en || ''));
  out = clampRuns(out, src);
  if (stutter) out = restoreStutter(out);
  return capitalize(out);
}

// Split a joined reply back into segments; null when it can't align.
function splitParts(full, n) {
  const parts = full.split(/\s*\|\s*\|\s*\|\s*/).map((s) => s.trim());
  return parts.length === n ? parts : null;
}

// Translate a run of segments, halving on misalignment. The old fallback went
// straight to one request per block, so a single bad split on a 30-bubble page
// cost 30 round trips; bisecting costs ~log2(n) and usually isolates the one
// segment that confused the splitter.
async function translateRun(texts, target, source) {
  if (!texts.length) return [];
  if (texts.length === 1) {
    return [await gtx(texts[0], target, source).then((s) => s.trim()).catch(() => '')];
  }
  try {
    const parts = splitParts(await gtx(texts.join(DELIM), target, source), texts.length);
    if (parts) return parts;
  } catch { /* bisect below */ }
  const mid = Math.ceil(texts.length / 2);
  const [a, b] = await Promise.all([
    translateRun(texts.slice(0, mid), target, source),
    translateRun(texts.slice(mid), target, source),
  ]);
  return a.concat(b);
}

export async function translateBatch(texts, target, source = 'auto') {
  if (!texts.length) return [];
  source = GTX_SOURCE[source] || source || 'auto';

  // Answer known interjections locally and keep them out of the request; the
  // lexicon is English-only, so it applies to the en target alone.
  const prepared = texts.map((raw) => {
    const t = String(raw || '').trim();
    const bare = t.replace(/[！？!?。．.…、,\s]+$/g, '');
    const hit = target === 'en' ? LEXICON.get(bare) : null;
    // Carry the source's own punctuation across, but as ASCII — the lexicon
    // bypasses gtx, which is what would normally fold ！？ down for us.
    if (hit) return { direct: fixPunct(hit + asciiPunct(t.slice(bare.length))), src: t };
    const { text, stutter } = stripStutter(t);
    return { send: text, src: t, stutter };
  });

  const pending = prepared.filter((p) => p.send !== undefined);
  const got = await translateRun(pending.map((p) => p.send), target, source);
  pending.forEach((p, i) => { p.out = got[i]; });

  return prepared.map((p) => (p.direct !== undefined ? p.direct : polish(p.out, p.src, p.stutter)));
}
