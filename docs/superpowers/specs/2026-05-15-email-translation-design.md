# Email Translation Feature — Design Spec

**Status**: Approved, ready for implementation plan
**Date**: 2026-05-15
**Repos affected**: `cloud-mail` (private), `cloud-mail-plus` (public OSS), `cloud-mail-hybrid` (production)
**Origin**: Open-source community feature request — add AI translation for inbound non-native-language emails

## 1. Goal

Add an on-demand email translation feature to cloud-mail-plus. A user reading an English email in a Chinese UI clicks one button; the email subject and body appear translated. Translations are cached per email+target-language so re-opening is instant. The feature is fully optional and degrades gracefully when AI is not configured.

## 2. Non-Goals

- Automatic background translation of every inbound email (saved as a v2 idea)
- Translating attachments (PDFs, images, OCR)
- Preserving rich HTML styling of source emails (intentionally degraded to paragraph-level structure)
- Per-user API key configuration (BYOK) — single deployment-wide AI binding only
- Multi-provider abstraction (OpenAI/DeepSeek/Claude/DeepL) — Workers AI only
- Per-user quota enforcement (anti-abuse) — relying on Cloudflare's account-level Neuron quota
- Streaming output (JSON mode incompatible with streaming on Workers AI, and translation is short enough)

## 3. Decisions Recap

| # | Decision | Choice |
|---|---|---|
| 1 | API key strategy | Reuse existing Workers AI `[ai]` binding (same as Email Agent) |
| 2 | Default model | `@cf/meta/llama-3.1-8b-instruct-fast` |
| 3 | Trigger | On-demand button click (no auto-translate) |
| 4 | Cache | D1 persistent cache, never expires |
| 5 | Target language | Follow UI locale (no separate setting) |
| 6 | Scope | Subject + body (sender names not translated) |
| 7 | UI presentation | Translation replaces original, toggle to switch back |
| 8 | Source-language detection | Yes, via franc-min (client + server, server authoritative) |
| 9 | Per-user quota | No (rely on Cloudflare account quota) |
| 10 | sourceLang storage | Yes, returned in AI JSON output and stored |
| 11 | TTL | Permanent (no cleanup) |
| 12 | Cache probe on email open | No — drop the `/translation/status` endpoint, only `POST /translate` |
| 13 | JSON output | Prompt-instructed, robust parser, retry once; do NOT rely on `response_format: json_object` parameter |
| 14 | Truncate threshold | 50,000 chars (~12k tokens) |
| 15 | Concurrent duplicate inserts | `INSERT OR IGNORE`, no distributed lock |
| 16 | Drafts/Sent translation | Allowed (no scope restriction) |

## 4. Architecture

```
mail-vue (frontend)
└─ views/content/index.vue          # Email detail view — add Translate icon button
└─ request/translation.js           # New API client (single POST)
└─ i18n/{zh,en}.js                  # 7 new strings

mail-worker (backend)
└─ api/translation-api.js           # New hono route: POST /translation/translate
└─ service/translation-service.js   # Cache lookup → lang detect → AI call → cache write
└─ entity/email-translation.js      # Drizzle schema
└─ utils/html-utils.js              # htmlToPlainText + paragraphsToHtml
└─ const/translation-const.js       # Model ID, supported langs, lang-name map
└─ security/security.js             # +1 line: 'email:translate' permission
└─ init/init.js                     # +3 SQL statements: CREATE TABLE + 2 indexes
└─ service/setting-service.js       # Expose aiEnabled flag (env.AI presence)
```

**Module boundaries**:

- `translation-service` depends on: `env.AI` (Workers AI binding), `env.orm` (Drizzle/D1), `franc-min` package, `iso-639-3` package, `email` entity (for permission check + content fetch)
- **No dependency on the EmailAgent DurableObject**. Translation works whether the AI Agent feature is enabled or not — only the `[ai]` binding is required.
- Frontend `settingStore.aiEnabled` gates button visibility — if AI binding is absent in the deployment, the Translate button is not rendered.

## 5. Data Flow

```
[User clicks Translate icon]
  │
  ▼
POST /translation/translate { emailId, targetLang }
  │
  ▼
translation-service.translate()
  │
  ├─ AuthN/Z: c.get('userId'); fail 401 if missing
  ├─ Validate: targetLang in SUPPORTED_TARGET_LANGS
  ├─ SELECT FROM email_translation WHERE emailId=? AND targetLang=? AND userId=?
  │   ├─ HIT  → return { translatedSubject, translatedContent, sourceLang, fromCache: true }
  │   └─ MISS:
  │        ├─ SELECT FROM email WHERE emailId=? AND userId=? AND isDel=0
  │        │   └─ 404 EMAIL_NOT_FOUND if missing
  │        ├─ plainText = htmlToPlainText(email.content || email.text)
  │        ├─ if (plainText.length > 50000) truncate + flag
  │        ├─ detected = franc-min(plainText.slice(0, 500))
  │        │   └─ if detected === targetLang (and not 'und') → return { alreadyInTargetLang: true }
  │        ├─ aiResult = callTranslationModel(env.AI, { subject, content, targetLang })
  │        │   ├─ AI.run('@cf/meta/llama-3.1-8b-instruct-fast', { messages, max_tokens: 4096, temperature: 0.2 })
  │        │   ├─ robustJsonParse(resp.response) — strips markdown fences, extracts first {..}
  │        │   └─ Retry once if parse fails or shape invalid; throw AI_BAD_OUTPUT after 2 attempts
  │        ├─ translatedContentHtml = paragraphsToHtml(aiResult.body)
  │        ├─ INSERT OR IGNORE INTO email_translation (...) VALUES (...)
  │        └─ return { translatedSubject, translatedContent, sourceLang, fromCache: false, truncated }
  │
  ▼
[Vue updates reactive state, button text → "Show original"]
```

## 6. Data Model

### Drizzle schema (`mail-worker/src/entity/email-translation.js`)

```js
import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const emailTranslation = sqliteTable('email_translation', {
  emailId: integer('email_id').notNull(),
  targetLang: text('target_lang').notNull(),              // 'zh' | 'en' | 'ja' | ...
  userId: integer('user_id').notNull(),                   // denormalized for fast authz + per-user cleanup
  translatedSubject: text('translated_subject').notNull(),
  translatedContent: text('translated_content').notNull(),// HTML (paragraphs from AI plain-text output)
  sourceLang: text('source_lang'),                        // AI-reported ISO 639-1 or franc-detected
  model: text('model').notNull(),                         // model ID used (audit trail)
  createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.emailId, t.targetLang] }),
  userIdx: index('idx_translation_user').on(t.userId),
  emailIdx: index('idx_translation_email').on(t.emailId),
}));
```

### Migration (`mail-worker/src/init/init.js` appended block)

```js
await env.db.prepare(`
  CREATE TABLE IF NOT EXISTS email_translation (
    email_id INTEGER NOT NULL,
    target_lang TEXT NOT NULL,
    user_id INTEGER NOT NULL,
    translated_subject TEXT NOT NULL,
    translated_content TEXT NOT NULL,
    source_lang TEXT,
    model TEXT NOT NULL,
    create_time TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (email_id, target_lang)
  )
`).run();
await env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_translation_user ON email_translation(user_id)`).run();
await env.db.prepare(`CREATE INDEX IF NOT EXISTS idx_translation_email ON email_translation(email_id)`).run();
```

### Cascade cleanup hooks

| Trigger | Cleanup query |
|---|---|
| `email-service.permanentDelete(emailId)` | `DELETE FROM email_translation WHERE email_id = ?` |
| `email-service.batchPermanentDelete(ids)` | `DELETE FROM email_translation WHERE email_id IN (?)` |
| `user-service.permanentDelete(userId)` (if present) | `DELETE FROM email_translation WHERE user_id = ?` |

**Soft-deleted emails** (moved to trash, `isDel=1`): translations are **kept**. Users may restore the email; the cached translation remains usable.

### Storage estimate

1000 users × 30 translations/month × ~800 bytes per row ≈ 24 MB/month. D1 free tier is 5 GB. No concern.

## 7. Backend Components

### `mail-worker/src/api/translation-api.js` — Hono route

```js
import translationService from '../service/translation-service';
import result from '../model/result';

export default function translationApi(app) {
  app.post('/translation/translate', async (c) => {
    const { emailId, targetLang } = await c.req.json();
    const userId = c.get('userId');
    const data = await translationService.translate(c, { emailId, targetLang, userId });
    return c.json(result.ok(data));
  });
}
```

### `mail-worker/src/security/security.js` — permission map

Append:
```js
'email:translate': ['/translation/translate'],
```
Default roles (user, admin) get this permission automatically — follow existing role-init pattern in `init/init.js`.

### `mail-worker/src/const/translation-const.js`

```js
export const MODEL_ID = '@cf/meta/llama-3.1-8b-instruct-fast';

export const SUPPORTED_TARGET_LANGS = ['zh', 'en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt', 'it'];

export const LANG_NAMES = {
  zh: 'Simplified Chinese',
  en: 'English',
  ja: 'Japanese',
  ko: 'Korean',
  fr: 'French',
  de: 'German',
  es: 'Spanish',
  ru: 'Russian',
  pt: 'Portuguese',
  it: 'Italian',
};

export const MAX_INPUT_CHARS = 50000;
```

### `mail-worker/src/service/translation-service.js`

Public API:
- `async translate(c, { emailId, targetLang, userId }) → { translatedSubject, translatedContent, sourceLang, fromCache, truncated?, alreadyInTargetLang? }`

Internal helpers:
- `callTranslationModel(AI, { subject, content, targetLang, attempt = 1 })` — runs Workers AI, parses output, retries once on bad output
- `robustJsonParse(raw)` — strips markdown fences, extracts first `{...}` block
- `detectLang(text) → 'zh' | 'en' | ... | 'und'` — calls `franc(text)` (returns ISO 639-3 like `'cmn'`, `'eng'`), then maps to ISO 639-1 via `iso6393To1[code]`. Returns `'und'` if franc returns `'und'` or the mapping is missing.

Error codes thrown (via existing `BizError` class in `mail-worker/src/error/`):

| code | HTTP | When |
|---|---|---|
| `AI_NOT_CONFIGURED` | 503 | `env.AI` is undefined |
| `LANG_NOT_SUPPORTED` | 400 | `targetLang` not in `SUPPORTED_TARGET_LANGS` |
| `EMAIL_NOT_FOUND` | 404 | Email row not found or belongs to another user |
| `AI_BAD_OUTPUT` | 502 | After 2 attempts, model still returns unparseable JSON |
| `AI_TIMEOUT` | 504 | Workers AI call times out |
| `AI_RATE_LIMITED` | 429 | Workers AI returns 429 or "rate limit" error |
| `INTERNAL` | 500 | Catchall |

### Prompt design

```
SYSTEM: You are a professional email translator. Translate the user's email
subject and body to <targetLangName>. Return ONLY a JSON object with this exact
shape (no markdown fence, no commentary):
{"sourceLang": "<ISO 639-1 code>", "subject": "<translated subject>", "body": "<translated body>"}
Rules:
- Preserve paragraph breaks (use \n\n between paragraphs in body).
- Do NOT translate proper names, email addresses, URLs, code blocks.
- Keep numbers, dates, currency unchanged.
- If the source is already in <targetLangName>, set sourceLang accordingly and copy text verbatim.
- Output JSON only.

USER: Subject: <subject>

Body:
<plainText>
```

Workers AI call parameters:
- `max_tokens: 4096`
- `temperature: 0.2`
- **No `response_format` parameter** (model-level support unverified)

### HTML utilities (`mail-worker/src/utils/html-utils.js`)

```js
export function htmlToPlainText(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<\/?(p|div|br|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function paragraphsToHtml(text) {
  return text
    .split(/\n{2,}/)
    .map(p => `<p>${escapeHtml(p.replace(/\n/g, '<br>'))}</p>`)
    .join('');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
```

**Security**: `escapeHtml` runs on every paragraph before wrapping in `<p>`. The model's output is treated as untrusted plain text — no possibility of `<script>` injection in the rendered translation.

## 8. Frontend Components

### `mail-vue/src/views/content/index.vue` — additions

**Template (header-actions row)**:
```vue
<el-tooltip :content="translationTooltip" placement="top">
  <Icon
    class="icon"
    :class="{ 'translating': state === 'loading' }"
    v-perm="'email:translate'"
    v-if="settingStore.aiEnabled"
    :icon="state === 'translated' ? 'mdi:translate-off' : 'mdi:translate'"
    width="20" height="20"
    @click="toggleTranslation"
  />
</el-tooltip>
```

**Translated banner (below subject)**:
```vue
<el-alert
  v-if="state === 'translated'"
  type="info"
  :closable="false"
  class="translation-banner"
  show-icon>
  <span>{{ $t('translatedFrom', { lang: sourceLangName }) }}</span>
  <el-link type="primary" @click="toggleTranslation">{{ $t('showOriginal') }}</el-link>
</el-alert>
```

**State machine**:
```
idle ──click──> loading ──ok──> translated ──click──> idle
                  │                                      │
                  fail                                   click (re-open cache hit)
                  │                                      │
                  ▼                                      ▼
                idle (toast error)                    translated
```

In-memory cache: once translated within a session, toggling back/forward uses `translatedSubject` / `translatedContent` refs — no re-fetch.

Computed `displaySubject` / `displayContent` swap between `email.subject` / `email.content` and `translatedSubject` / `translatedContent` based on `state`.

### `mail-vue/src/request/translation.js`

```js
import http from '@/axios/index.js';

export function translateEmail(emailId, targetLang) {
  return http.post('/translation/translate', { emailId, targetLang });
}
```

### `mail-vue/src/store/setting.js` — new field

Add `aiEnabled: false` to state; populate from `/setting/get` response.

### `mail-vue/src/i18n/{zh,en}.js`

**zh.js**:
```js
translate: '翻译',
translateBack: '显示原文',
translationCached: '已缓存译文，点击查看',
translatedFrom: '已从{lang}翻译',
showOriginal: '查看原文',
alreadyInTargetLang: '邮件已是当前语言',
translationFailed: '翻译失败，请稍后重试',
```

**en.js**:
```js
translate: 'Translate',
translateBack: 'Show original',
translationCached: 'Translation cached — click to view',
translatedFrom: 'Translated from {lang}',
showOriginal: 'Show original',
alreadyInTargetLang: 'Email is already in target language',
translationFailed: 'Translation failed, please retry',
```

### Locale normalization helper

```js
function normalizeLocale(locale) {
  return locale.split(/[-_]/)[0].toLowerCase();   // 'zh-CN' → 'zh'
}
```

## 9. Error Handling Summary

| Layer | Failure mode | Handling |
|---|---|---|
| Worker | `env.AI` missing | Throw `AI_NOT_CONFIGURED`; frontend hides button via `aiEnabled` gate |
| Worker | Bad targetLang | Throw `LANG_NOT_SUPPORTED` |
| Worker | Email not owned by user | Throw `EMAIL_NOT_FOUND` |
| Worker | Workers AI 429 | Throw `AI_RATE_LIMITED` |
| Worker | Workers AI timeout | Throw `AI_TIMEOUT` |
| Worker | AI returns unparseable JSON × 2 | Throw `AI_BAD_OUTPUT` |
| Worker | Concurrent INSERT collision | `INSERT OR IGNORE` (no error) |
| Worker | Input > 50000 chars | Truncate, set `truncated: true` in response |
| Worker | franc returns `'und'` (short text) | Skip same-lang shortcut, let AI handle |
| Frontend | Any error | Toast `translationFailed`, state → idle |
| Frontend | `alreadyInTargetLang: true` | Toast info, state stays idle |
| Frontend | Double click | Guard `if (state === 'loading') return` |

## 10. Three-Repo Sync Discipline

Per the repository's `CLAUDE.md` discipline: changes must flow `cloud-mail` → tested → copied to `cloud-mail-plus` (sanitized for public OSS) + `cloud-mail-hybrid` (production) → all three pushed.

| File | cloud-mail | cloud-mail-plus | cloud-mail-hybrid |
|---|---|---|---|
| `mail-worker/src/entity/email-translation.js` | new | new | new |
| `mail-worker/src/service/translation-service.js` | new | new | new |
| `mail-worker/src/api/translation-api.js` | new | new | new |
| `mail-worker/src/utils/html-utils.js` | new | new | new |
| `mail-worker/src/const/translation-const.js` | new | new | new |
| `mail-worker/src/security/security.js` | +1 line | +1 line | +1 line |
| `mail-worker/src/init/init.js` | +3 SQL stmts | +3 SQL stmts | +3 SQL stmts |
| `mail-worker/package.json` | +`franc-min`, `iso-639-3` | same | same |
| `mail-vue/src/views/content/index.vue` | modified | modified | modified |
| `mail-vue/src/request/translation.js` | new | new | new |
| `mail-vue/src/store/setting.js` | +`aiEnabled` | same | same |
| `mail-vue/src/i18n/{zh,en}.js` | +7 strings | +7 strings | +7 strings |
| `wrangler.toml` | unchanged | comment hint added | per-deployment |
| `README.md` / `README-en.md` | +feature note | +feature note | n/a |

**Sync verification**: after copying, run `diff` between equivalent files in all three repos. The Drizzle schema file `email-translation.js` must be byte-identical across repos to avoid D1 ORM mismatches.

## 11. Deployment

### Prerequisites for a deployment to use translation

- `wrangler.toml` must enable the `[ai]` binding:
  ```toml
  [ai]
  binding = "AI"
  ```
- Deployer's Cloudflare account must have Workers AI access (free tier OK; usage charged to that account's Neuron quota)
- No DurableObject required (translation is independent of the EmailAgent feature)

### Deploy steps

1. `pnpm install` in `mail-worker/` to pull `franc-min` + `iso-639-3`
2. `wrangler deploy` — `init.js` will idempotently create `email_translation` table and indexes on first run
3. Verify by opening any English email in a Chinese-locale UI and clicking the Translate icon

### Workers AI cost model

- Free tier: 10,000 Neurons / day per Cloudflare account
- Estimated per-email cost with `@cf/meta/llama-3.1-8b-instruct-fast`: ~45 Neurons/email (500 in, 500 out)
- Free tier translates ≈ 220 emails/day before metered billing kicks in at $0.011 / 1000 Neurons (~$0.50 per 1000 emails)
- The model is shared with no other cloud-mail feature; the EmailAgent uses Kimi-K2.5 from the same `[ai]` binding but its own daily quota allowance

## 12. Testing Strategy

Target: 80%+ coverage per repo testing rules.

### Unit tests (`mail-worker/test/`, vitest)

| File | Coverage |
|---|---|
| `html-utils.test.js` | `htmlToPlainText`: strips `<style>`/`<script>`/base64 imgs/nested divs/`&nbsp;`/entities/CRLF; `paragraphsToHtml`: round-trip preserves paragraphs, escapes `<script>` injection attempts |
| `translation-service.test.js` | Cache hit returns `fromCache: true`; cache miss invokes AI; same-language short-circuit (franc returns target); 404 on cross-user emailId; concurrent `INSERT OR IGNORE` does not throw; truncation flag when input > 50k chars |
| `robust-json-parse.test.js` | Bare JSON, markdown-fenced JSON, JSON with leading explanation, nested `}` in strings, corrupted JSON returns null |

All `env.AI.run` calls are mocked.

### Integration tests (vitest + miniflare or `wrangler dev --test`)

| Scenario | Expected |
|---|---|
| POST `/translate` with cache hit | `fromCache: true`, no AI call, < 50ms |
| POST `/translate` cache miss, mock AI returns valid JSON | Row inserted, response includes translation |
| POST `/translate` mock AI returns markdown fence | `robustJsonParse` strips fence, succeeds |
| POST `/translate` mock AI returns garbage × 2 | 502 `AI_BAD_OUTPUT` |
| POST `/translate` foreign emailId | 404 `EMAIL_NOT_FOUND` |
| POST `/translate` with `env.AI` undefined | 503 `AI_NOT_CONFIGURED` |
| POST `/translate` targetLang = sourceLang (mock franc) | `alreadyInTargetLang: true`, no AI call, no DB insert |
| POST `/translate` without `email:translate` perm | 403 |

### E2E tests (Playwright, if existing suite present)

| Scenario | Expected |
|---|---|
| Open English email in zh UI → click Translate → see Chinese | Translation appears, button toggles to "translate-off" icon |
| Re-open same email → click Translate | Cache hit, < 100ms render |
| Click "Show original" link in banner | Reverts to English |
| Deployment without `[ai]` binding | Translate button absent from DOM |
| Permanently delete email → check D1 | Translation row removed via cascade |

### Manual acceptance

- Real Gmail-forwarded HTML email with reply quote + signature image → translation readable, paragraphs preserved
- Chinese email in zh UI → toast "邮件已是当前语言"
- Very short email ("Hi!") → translation does not crash (franc returns `'und'`, AI handles)
- 1 MB email → truncated, translation returns with `truncated: true` flag, UI shows hint

## 13. Open Risks

1. **Workers AI quality on niche language pairs**: Llama-3.1-8b is strong on EN ↔ ZH/JA/KO/FR/DE/ES but weaker on RU/PT/IT. Manual acceptance must spot-check each pair.
2. **`response_format` parameter unverified for the fast variant**: design intentionally does not use it, but if a future Workers AI update adds reliable JSON mode for this model, the implementation can be simplified.
3. **AI hallucination of links**: model could rewrite URLs in translation. Mitigation is in the prompt ("Do NOT translate URLs") plus `escapeHtml` (so even if model produces `<a>` tags they're rendered as text, not clickable). Manual acceptance should specifically test phishing-looking emails to confirm URLs are preserved verbatim.
4. **D1 row size limit**: 2 MB per row. With `translated_content` HTML potentially ~2× the plain text size, a 50k-char source could produce ~120k-char HTML, still well under the limit. No mitigation needed.
5. **`franc-min` bundle size on Worker**: ~50 KB minified. Worker code size limit is 10 MB unzipped, current cloud-mail-plus worker bundle is well below; comfortable headroom.

## 14. Future Work (out of scope)

- Per-user auto-translate toggle with sender whitelist / source-lang blocklist
- Streaming output via SSE when Workers AI adds streaming + JSON mode together
- Per-user daily quota with admin-configurable limit
- BYOK provider abstraction (OpenAI / DeepSeek / Claude API)
- Translation of attachments (PDF text extraction → translate → re-render)
- "Translate selection" mode (highlight a passage, translate only that)

## 15. Implementation Phases (preview for plan)

1. **Backend foundation**: entity + init migration + const + utils + service (with mock AI tests)
2. **Backend API + security**: route + permission + integration tests
3. **Frontend gate**: setting-service `aiEnabled` + store flag + button visibility
4. **Frontend wiring**: state machine + API client + i18n + banner
5. **E2E + manual acceptance**: real Workers AI call, sample emails across pairs
6. **Three-repo sync + deploy**: copy to cloud-mail-plus + cloud-mail-hybrid, deploy hybrid, smoke test
