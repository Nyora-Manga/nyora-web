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

// --- sound effects --------------------------------------------------------
//
// A katakana-only bubble is a sound effect (or a name), never a sentence — but
// gtx does not know that and reaches for a dictionary. Measured on real pages:
//
//   グググ   → "Google"                 バキバキ… → "Breaking fast..."
//   ペラペラ → "Fluent"                 カラン    → "Callan"
//   ドキドキ → "My heart is pounding"   キラキラ  → "Sparkling"
//
// Blanket-romanising them all would be worse, though, because sometimes gtx
// picks a genuinely better English onomatopoeia than a transliteration would:
// バタン → "Bang", ふふふ → "Hehehe". So the test is not "is it katakana" but
// "did gtx TRANSLITERATE or TRANSLATE it" — romanise the source ourselves and
// compare. Close to our romaji means it transliterated (keep its nicer
// spelling); far from it means it went to the dictionary (use the romaji).
const KANA_ROMAJI = {
  ア: 'a', イ: 'i', ウ: 'u', エ: 'e', オ: 'o',
  カ: 'ka', キ: 'ki', ク: 'ku', ケ: 'ke', コ: 'ko',
  サ: 'sa', シ: 'shi', ス: 'su', セ: 'se', ソ: 'so',
  タ: 'ta', チ: 'chi', ツ: 'tsu', テ: 'te', ト: 'to',
  ナ: 'na', ニ: 'ni', ヌ: 'nu', ネ: 'ne', ノ: 'no',
  ハ: 'ha', ヒ: 'hi', フ: 'fu', ヘ: 'he', ホ: 'ho',
  マ: 'ma', ミ: 'mi', ム: 'mu', メ: 'me', モ: 'mo',
  ヤ: 'ya', ユ: 'yu', ヨ: 'yo',
  ラ: 'ra', リ: 'ri', ル: 'ru', レ: 're', ロ: 'ro',
  ワ: 'wa', ヲ: 'o', ン: 'n',
  ガ: 'ga', ギ: 'gi', グ: 'gu', ゲ: 'ge', ゴ: 'go',
  ザ: 'za', ジ: 'ji', ズ: 'zu', ゼ: 'ze', ゾ: 'zo',
  ダ: 'da', ヂ: 'ji', ヅ: 'zu', デ: 'de', ド: 'do',
  バ: 'ba', ビ: 'bi', ブ: 'bu', ベ: 'be', ボ: 'bo',
  パ: 'pa', ピ: 'pi', プ: 'pu', ペ: 'pe', ポ: 'po',
  ヴ: 'vu',
};
const KANA_SMALL = { ャ: 'ya', ュ: 'yu', ョ: 'yo', ァ: 'a', ィ: 'i', ゥ: 'u', ェ: 'e', ォ: 'o' };

/** Hepburn-ish transliteration. Handles ー (long vowel), ッ (gemination) and
 *  small-kana digraphs (キャ → kya, シュ → shu). */
export function katakanaToRomaji(s) {
  let out = '';
  const chars = [...String(s)];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const next = chars[i + 1];
    if (c === 'ー') { out += out.slice(-1); continue; }          // long vowel: double the last
    if (c === 'ッ') { const n = KANA_ROMAJI[next]; if (n) out += n[0]; continue; } // gemination
    const base = KANA_ROMAJI[c];
    if (!base) continue;
    if (next && KANA_SMALL[next]) {
      // キャ = ki + ya → kya;  シャ = shi + ya → sha (drop the i, keep sh)
      out += base.replace(/i$/, '') + KANA_SMALL[next].replace(/^y(?=[aou])/, base.endsWith('i') && base.length > 2 ? '' : 'y');
      i++;
      continue;
    }
    out += base;
  }
  return out;
}

// Hangul is compositional, so romanisation is arithmetic rather than a table:
// a syllable's code point encodes (initial × 21 + medial) × 28 + final. Revised
// Romanization of the jamo, which is all the SFX test needs.
const JAMO_INITIAL = ['g', 'kk', 'n', 'd', 'tt', 'r', 'm', 'b', 'pp', 's', 'ss', '', 'j', 'jj', 'ch', 'k', 't', 'p', 'h'];
const JAMO_MEDIAL = ['a', 'ae', 'ya', 'yae', 'eo', 'e', 'yeo', 'ye', 'o', 'wa', 'wae', 'oe', 'yo',
  'u', 'wo', 'we', 'wi', 'yu', 'eu', 'ui', 'i'];
const JAMO_FINAL = ['', 'k', 'k', 'k', 'n', 'n', 'n', 't', 'l', 'l', 'l', 'l', 'l', 'l', 'l', 'l',
  'm', 'p', 'p', 't', 't', 'ng', 't', 't', 'k', 't', 'p', 't'];

export function hangulToRomaja(s) {
  let out = '';
  for (const ch of String(s)) {
    const code = ch.codePointAt(0) - 0xac00;
    if (code < 0 || code > 11171) continue;
    out += JAMO_INITIAL[Math.floor(code / 588)]
      + JAMO_MEDIAL[Math.floor((code % 588) / 28)]
      + JAMO_FINAL[code % 28];
  }
  return out;
}

/** 0 = identical, 1 = nothing in common. Case- and length-normalised. */
function phoneticDistance(a, b) {
  const x = String(a).toLowerCase().replace(/[^a-z]/g, '');
  const y = String(b).toLowerCase().replace(/[^a-z]/g, '');
  if (!x || !y) return 1;
  return editDistance(x, y) / Math.max(x.length, y.length);
}

function editDistance(s, t) {
  let prev = Array.from({ length: t.length + 1 }, (_, j) => j);
  for (let i = 1; i <= s.length; i++) {
    const cur = [i];
    for (let j = 1; j <= t.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (s[i - 1] === t[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[t.length];
}

// Katakana, long marks and small kana only — plus trailing punctuation. A
// sentence has particles in hiragana or kanji, so this cannot match dialogue.
const KATAKANA_ONLY = /^[゠-ヿー]+[\s!?！？.。…、,ッっ]*$/u;
// NOT applied to Korean, and the asymmetry is the reason. Katakana is a
// SEPARATE script, reserved for foreign words and sound effects, so
// "katakana-only" is real evidence that a bubble is an effect. Hangul is
// Korean's ONLY script, so "Hangul-only" is evidence of nothing — short,
// space-free Korean sentences are completely ordinary. Trying it anyway turned
// 조심해！("Be careful!") into "Josimhae!", 쿵 ("Thump") into "Kung" and
// 반짝반짝 ("Twinkle") into "Banjjakbanjjak". Korean SFX would need a different
// signal — this one does not transfer.

/** gtx sent a katakana bubble to the dictionary — take the romaji instead. */
function fixSfx(en, src) {
  const core = String(src).replace(/[\s!?！？.。…、,~]+$/u, '');
  if (!KATAKANA_ONLY.test(core) || core.length > 8) return en;
  const romaji = katakanaToRomaji(core);
  if (romaji.length < 2) return en;
  // Measured distances — note they do NOT separate cleanly:
  //
  //   keep    Gacha/Doki/Zawazawa 0.00 · Zabun 0.17 · Bang 0.60
  //   replace Callan 0.50 · "Breaking fast" 0.58 · Google 0.83 ·
  //           Sparkling 0.78 · "My heart is pounding" 0.82
  //
  // バタン → "Bang" (0.60) sits ABOVE バキバキ → "Breaking fast" (0.58), so no
  // threshold keeps the good English onomatopoeia without also keeping the
  // mistranslations. 0.5 deliberately sacrifices "Bang" → "Batan": a plain
  // transliteration is never WRONG, only less colourful, whereas a confident
  // mistranslation puts a false sentence on the page.
  if (phoneticDistance(en, romaji) <= 0.5) return en;
  const cap = romaji[0].toUpperCase() + romaji.slice(1);
  return cap + (String(src).match(/[\s!?！？.。…、,]+$/u) ? asciiPunct(String(src).match(/[!?！？.。…、,]+$/u)?.[0] || '') : '');
}

// A stutter (ま、まさか… / だ、誰だお前は) is a first-mora repeat. Sent as-is,
// gtx translates the stray mora as its own word — "Well, no way..." and
// "Who are you?" (stutter dropped). So we strip it before translating and
// re-apply it to the English, which is what a scanlator would letter:
// "N-no way..." / "W-who are you?"
// A scream is a word with its last sound HELD: いやあああ, そんなーーー,
// ええええっ！？. gtx translates the word and then mishandles the hold three
// different ways — いやあああ → "Noaaa" (Japanese vowel glued onto English),
// そんなーーー → "That's so..." (hold dropped), ええええっ！？ → "Yeah yeah!?"
// (hold became a repeated WORD). Same remedy as the stutter above: take the
// hold off before translating, put it back on the English as a letterer would.
const HOLD = /([ぁ-おァ-オー아-이])\1+(?=[っッ]?[^ぁ-んァ-ヶ一-鿿가-힣]*$)/;

function stripHold(t) {
  const m = HOLD.exec(t);
  if (!m) return { text: t, hold: 0 };
  // Keep one instance so the base is still a word (いやあああ → いや + hold 3;
  // ええええ → え + hold 3, not an empty base).
  const base = t.slice(0, m.index) + (m.index === 0 ? m[1] : '') + t.slice(m.index + m[0].length);
  return { text: base, hold: m[0].length - (m.index === 0 ? 1 : 0) };
}

function applyHold(en, hold) {
  if (hold < 2) return en;
  // Repeat the final LETTER of the last word — "No"→"Nooo", "Eh"→"Ehhh",
  // "That's so"→"That's sooo" — leaving trailing punctuation where it is.
  return en.replace(/(\p{L})(\P{L}*)$/u, (_, ch, tail) => ch.repeat(1 + Math.min(hold, 5)) + tail);
}

const STUTTER = /^(.)[、,]\s*(?=\1)/;
function stripStutter(t) {
  return STUTTER.test(t) ? { text: t.replace(STUTTER, ''), stutter: true } : { text: t, stutter: false };
}

// Letterers break a word across a dramatic pause — 帰らな…くて…は… is one word,
// 帰らなくては, drawn with the ellipses spread through it. Sent as drawn, gtx
// parses the fragments separately and can invert the meaning outright:
//
//   帰らな…くて…は…   → "I don't want to go home..."
//   帰らなくては…      → "I have to go home..."      (what it actually says)
//
// So the interior ellipses come out before translating. Only when the run
// BEFORE the pause is two or more Japanese characters, though: a single kana
// ahead of a pause is a gasp or a stutter that carries real meaning, and
// joining it loses that — え…ええっ！？ is "Eh...ehh!?", and stripping its
// ellipsis translated it as a flat "Yeah!?". Verified against the eval corpus:
// this rewrites four of fourteen phrases, fixes the inversion above, and
// changes no other English.
const SPLIT_WORD = /([぀-ヿ一-鿿]{2,})…+(?=[぀-ヿ一-鿿])/gu;
function joinSplitWords(t) {
  return t.replace(SPLIT_WORD, '$1');
}
function restoreStutter(en) {
  const m = en.match(/^([A-Za-z])(\w*)/);
  if (!m) return en;
  return `${m[1]}-${m[1].toLowerCase()}${en.slice(1)}`;
}

// Honorifics: keep them as suffixes, the way a scanlator letters them.
//
// gtx is inconsistent about this — 「…アカネさん？」 comes back "...Akane-san?"
// but 「丸山さん…」 comes back "Mr. Maruyama...", so the same page can address
// two characters in two different conventions. Where the SOURCE carried an
// honorific and the English turned it into a title, put the suffix back.
//
// Only rewrites "Title + Name": a bare noun must be left alone, or
// 「僕はこの子達の先生だから」 ("I am the teacher of these children") would
// become "...the -sensei of these children".
const HONORIFICS = [
  // Longest/most specific first — 兄さん must not be matched by the さん rule.
  { jp: /姉(さん|ちゃん)|お姉[さち]ゃん/, en: 'nee', titles: /\b(?:Sister|Big Sister)\s+/gi },
  { jp: /兄(さん|ちゃん)|お兄[さち]ゃん/, en: 'nii', titles: /\b(?:Brother|Big Brother)\s+/gi },
  { jp: /先輩/, en: 'senpai', titles: /\b(?:Senior|Senpai)\s+/gi },
  { jp: /先生/, en: 'sensei', titles: /\b(?:Teacher|Doctor|Dr)\.?\s+/gi },
  { jp: /[様さ]ま|様/, en: 'sama', titles: /\b(?:Lord|Lady|Master|Sir)\s+/gi },
  { jp: /殿(?![ぁ-ん])|どの(?=[、。！？…\s]|$)/, en: 'dono', titles: /\b(?:Lord|Sir)\s+/gi },
  { jp: /ちゃん/, en: 'chan', titles: /\b(?:Little|Miss)\s+/gi },
  { jp: /(?:君|くん)(?![ぁ-ん])/, en: 'kun', titles: /\b(?:Master|Mr)\.?\s+/gi },
  { jp: /さん(?![ぁ-ん])/, en: 'san', titles: /\b(?:Mr|Mrs|Ms|Miss)\.?\s+/gi },
];

// The commoner honorific failure is not a title — it is a SILENT DROP. gtx
// transliterates the name correctly and throws the suffix away:
//
//   ローズさん、こんにちは  → "Hello Rose,"      (-san gone)
//   ナハトさん、こんにちは  → "Hello Nacht,"     (-san gone)
//   ベル君、こんにちは      → "Hello Bell,"      (-kun gone)
//
// Measured over 16 katakana names: 7 dropped the honorific, 3 kept it, 2 turned
// it into a title, 2 read the name as a common noun. So this is the single
// biggest honorific bug, and it needs the name's ENGLISH spelling to fix.
//
// Rather than transliterate ourselves — mechanical Hepburn would turn ルフィ
// into "Rufi" where gtx gives "Luffy" — the bare names ride along as extra
// segments in the batch request that is already going out. Same one request,
// and gtx's own romanisation is reused.
const NAME_HONORIFIC = /([゠-ヿ一-鿿][゠-ヿ一-鿿ー]{1,7})(さん|ちゃん|くん|君|様|さま|殿|先輩)(?![ぁ-ん])/g;
// Korean: 씨/님 attach directly, the relationship terms follow a space. gtx
// drops 씨 outright (민수씨 → "Minsu.") and is inconsistent with the rest —
// 준호 오빠 → "Junho oppa" but 지은 언니 → "Ji-eun sister".
const KO_NAME_HONORIFIC = /([가-힣]{2,4})\s*(씨|님|선배|오빠|언니|형|누나)(?![가-힣])/g;
const KO_SUFFIX = { 씨: 'ssi', 님: 'nim', 선배: 'sunbae', 오빠: 'oppa', 언니: 'eonni', 형: 'hyung', 누나: 'noona' };
// Role words, not names — 사장님/선생님 read better as "boss"/"teacher".
// 선배님/후배님 are roles too — 선배 only acts as a SUFFIX after a real name
// (민수 선배). Without this, 선배님 parsed as name=선배 + 님 → "senior-nim".
const KO_ROLE = /^(사장|선생|부장|과장|회장|팀장|손님|고객|선배|후배|아저씨|아주머니)$/;

// `lang` is REQUIRED, because these characters are not language-specific.
// 殿, 君 and 先輩 are ordinary Chinese words — 殿 is "hall" — so running the
// Japanese patterns over Chinese produced "Jinluan-dono Palace is very big"
// for 金鑾殿很大 and "Where is the Mahavira-dono Palace?" for 大雄寶殿在哪裡.
// Honorific suffixing is a Japanese/Korean scanlation convention; Chinese
// translations use plain English titles and must be left alone.
function findNamedHonorifics(texts, lang) {
  const found = new Map();   // bare name → honorific suffix
  const ja = /^ja/.test(lang || '');
  const ko = /^ko/.test(lang || '');
  if (!ja && !ko) return found;
  for (const t of texts) {
    if (!ko) break;
    for (const m of String(t || '').matchAll(KO_NAME_HONORIFIC)) {
      if (KO_ROLE.test(m[1])) continue;
      const suffix = KO_SUFFIX[m[2]];
      if (suffix) found.set(m[1], suffix);
    }
  }
  for (const t of ja ? texts : []) {
    for (const m of String(t || '').matchAll(NAME_HONORIFIC)) {
      const suffix = { さん: 'san', ちゃん: 'chan', くん: 'kun', 君: 'kun',
        様: 'sama', さま: 'sama', 殿: 'dono', 先輩: 'senpai' }[m[2]];
      // 兄さん / お姉ちゃん are relationship words, not names — the -nee/-nii
      // rules in HONORIFICS already cover those.
      if (/^[兄姉母父]/.test(m[1]) || m[1].length < 2) continue;
      if (suffix) found.set(m[1], suffix);
    }
  }
  return found;
}

// Append `-suffix` to the name where gtx dropped it. Skips a name that already
// carries any honorific, so a correct "Luffy-sama" is never touched.
function reattachHonorific(en, englishName, suffix) {
  const name = String(englishName || '').trim().replace(/^[^\p{L}]+|[^\p{L}]+$/gu, '');
  // Case-INSENSITIVE on purpose. gtx lowercases any name it reads as an
  // ordinary word — ローズ comes back "rose", ベル "bell", even ルフィ "luffy" —
  // while the sentence itself capitalises it ("Hello Rose,"). Matching on the
  // bare translation's capitalisation missed exactly the names that need this
  // most. Two characters minimum, so a stray "a"/"I" cannot match.
  if (name.length < 2 || !/^[\p{L}][\p{L}'-]*$/u.test(name)) return en;
  // Match the SPACE form as well as the hyphen: gtx already writes "Junho oppa"
  // for 준호 오빠, and only checking for "Junho-oppa" produced "Junho-oppa oppa".
  const SUFFIXES = 'san|chan|kun|sama|dono|senpai|sensei|nee|nii|ssi|nim|sunbae|oppa|eonni|hyung|noona';
  const already = new RegExp(`\\b${name}[\\s-](?:${SUFFIXES})\\b`, 'i');
  if (already.test(en)) return en;
  // Keep whatever casing the sentence used; only add the suffix.
  return en.replace(new RegExp(`\\b${name}\\b`, 'gi'), (m) => `${m}-${suffix}`);
}

function restoreHonorifics(en, src, lang) {
  if (!/^ja/.test(lang || '')) return en;   // see findNamedHonorifics
  let out = en;
  for (const h of HONORIFICS) {
    if (!h.jp.test(src)) continue;
    // The name has to look like a name: a capitalised word right after the
    // title. `Mr. Maruyama` → `Maruyama-san`; `the teacher of` is untouched.
    out = out.replace(new RegExp(h.titles.source + '([A-Z][\\w\'-]*)', 'g'), `$1-${h.en}`);
    if (out !== en) break;   // one honorific per line is the normal case
  }
  return out;
}

// gtx leaves subject-less fragments lowercase (俺たちは仲間だろ → "we are friends").
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

function polish(en, src, stutter, lang) {
  let out = fixPunct(String(en || ''));
  out = fixSfx(out, src);
  out = restoreHonorifics(out, src, lang);
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
  const lang = source;                       // before the gtx code mapping
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
    const { text: unstuttered, stutter } = stripStutter(t);
    const { text, hold } = stripHold(unstuttered);
    // After stripStutter, so a leading "え、え…" keeps its stutter handling and
    // only the pauses inside the remaining word are closed up.
    // Per-line, NOT batch-wide: if this line writes the name bare, the author
    // dropped the honorific on purpose and it must stay dropped. Collecting
    // them batch-wide leaked 「ナハトさん」's -san onto 「天才だナハト…！」.
    return { send: joinSplitWords(text), src: t, stutter, hold, names: findNamedHonorifics([t], lang) };
  });

  const pending = prepared.filter((p) => p.send !== undefined);

  // Names carrying an honorific ride along as extra segments so gtx's own
  // romanisation comes back in the SAME request — see findNamedHonorifics.
  // English targets only: the -san convention is an English scanlation habit.
  const names = target === 'en' ? findNamedHonorifics(texts, lang) : new Map();
  const nameList = [...names.keys()];

  const got = await translateRun(pending.map((p) => p.send).concat(nameList), target, source);
  pending.forEach((p, i) => { p.out = got[i]; });
  const englishName = new Map();
  nameList.forEach((jp, i) => { englishName.set(jp, got[pending.length + i]); });

  return prepared.map((p) => {
    if (p.direct !== undefined) return p.direct;
    let out = applyHold(polish(p.out, p.src, p.stutter, lang), p.hold);
    for (const [jp, suffix] of (p.names || [])) {
      out = reattachHonorific(out, englishName.get(jp), suffix);
    }
    return out;
  });
}
