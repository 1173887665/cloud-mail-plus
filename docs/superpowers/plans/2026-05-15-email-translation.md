# Email Translation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add on-demand AI translation for inbound emails using Cloudflare Workers AI, with D1 persistent caching. Translation follows UI locale, replaces email subject + body in place, toggles back to original with one click. Feature degrades gracefully when `[ai]` binding is absent.

**Architecture:** New `email_translation` D1 table (composite key `emailId + targetLang`). Backend service uses Workers AI model `@cf/meta/llama-3.1-8b-instruct-fast` with prompt-instructed JSON output and robust parsing. Frontend adds a single button to the email detail view with a 4-state machine (idle / loading / translated / error). Source-language detection via `franc-min` (skips AI when source == target).

**Tech Stack:** Cloudflare Workers, Hono, Drizzle ORM (D1), Vue 3, Element Plus, vitest + @cloudflare/vitest-pool-workers, `franc-min` + `iso-639-3` for language detection.

**Source spec:** [`docs/superpowers/specs/2026-05-15-email-translation-design.md`](../specs/2026-05-15-email-translation-design.md)

---

## File Structure

### Files to create (mail-worker)

| Path | Purpose |
|---|---|
| `mail-worker/src/entity/email-translation.js` | Drizzle schema for the `email_translation` table |
| `mail-worker/src/const/translation-const.js` | Model ID, supported langs, lang-name map, MAX_INPUT_CHARS |
| `mail-worker/src/utils/html-utils.js` | `htmlToPlainText`, `paragraphsToHtml`, `escapeHtml` |
| `mail-worker/src/utils/lang-detect.js` | `detectLang(text)` → ISO 639-1 code or `'und'` |
| `mail-worker/src/service/translation-service.js` | Core translate logic (cache → detect → AI → write) |
| `mail-worker/src/api/translation-api.js` | Hono route `POST /translation/translate` |
| `mail-worker/test/utils/html-utils.test.js` | Unit tests for HTML helpers |
| `mail-worker/test/utils/lang-detect.test.js` | Unit tests for `detectLang` |
| `mail-worker/test/service/translation-service.test.js` | Integration tests for service |

### Files to create (mail-vue)

| Path | Purpose |
|---|---|
| `mail-vue/src/request/translation.js` | API client (single `translateEmail` call) |

### Files to modify (mail-worker)

| Path | Change |
|---|---|
| `mail-worker/package.json` | +`franc-min`, +`iso-639-3` deps |
| `mail-worker/src/init/init.js` | +3 SQL stmts to create table + indexes |
| `mail-worker/src/security/security.js` | +1 line: `'email:translate': ['/translation/translate']` |
| `mail-worker/src/hono/webs.js` | +1 line: `import '../api/translation-api'` |
| `mail-worker/src/service/setting-service.js` | Expose `aiEnabled: !!env.AI` in settings GET |
| `mail-worker/src/service/email-service.js` | Cascade-delete translation rows on `permanentDelete` and `batchPermanentDelete` |
| `mail-worker/src/i18n/zh.js` | +6 translation error message keys |
| `mail-worker/src/i18n/en.js` | +6 translation error message keys |

### Files to modify (mail-vue)

| Path | Change |
|---|---|
| `mail-vue/src/views/content/index.vue` | Add Translate button, state machine, displaySubject/displayContent computed, banner |
| `mail-vue/src/store/setting.js` | +`aiEnabled` state field |
| `mail-vue/src/i18n/zh.js` | +7 strings (translate, translateBack, etc.) |
| `mail-vue/src/i18n/en.js` | +7 strings (same) |

---

## Task 1: Install dependencies

**Files:**
- Modify: `mail-worker/package.json`

- [ ] **Step 1: Add the two new deps**

```bash
cd mail-worker
pnpm add franc-min iso-639-3
```

Expected: `package.json` `dependencies` now includes `"franc-min": "^x.y.z"` and `"iso-639-3": "^x.y.z"`; `pnpm-lock.yaml` updated.

- [ ] **Step 2: Verify they load in Worker runtime**

Add a temporary import-check at the top of `mail-worker/test/index.spec.js`:

```js
import { franc } from 'franc-min';
import { iso6393To1 } from 'iso-639-3';
```

Run: `pnpm exec vitest run test/index.spec.js`
Expected: PASS (existing hello-world test) — confirms both packages bundle and load in the Workers runtime.

- [ ] **Step 3: Remove the temporary import and commit**

```bash
git checkout mail-worker/test/index.spec.js   # revert the import-only addition
git add mail-worker/package.json mail-worker/pnpm-lock.yaml
git commit -m "chore(worker): add franc-min and iso-639-3 for translation feature"
```

---

## Task 2: Constants module

**Files:**
- Create: `mail-worker/src/const/translation-const.js`

- [ ] **Step 1: Create the constants file**

```js
// mail-worker/src/const/translation-const.js
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
export const MAX_RETRY_ATTEMPTS = 2;
```

- [ ] **Step 2: Commit**

```bash
git add mail-worker/src/const/translation-const.js
git commit -m "feat(translation): add translation constants module"
```

---

## Task 3: HTML utilities (TDD)

**Files:**
- Create: `mail-worker/src/utils/html-utils.js`
- Create: `mail-worker/test/utils/html-utils.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// mail-worker/test/utils/html-utils.test.js
import { describe, it, expect } from 'vitest';
import { htmlToPlainText, paragraphsToHtml, escapeHtml } from '../../src/utils/html-utils';

describe('htmlToPlainText', () => {
  it('strips <style> blocks', () => {
    expect(htmlToPlainText('<style>body { color: red }</style>Hello')).toBe('Hello');
  });
  it('strips <script> blocks', () => {
    expect(htmlToPlainText('<script>alert(1)</script>Hi')).toBe('Hi');
  });
  it('converts paragraph and br tags to newlines', () => {
    expect(htmlToPlainText('<p>A</p><p>B</p>')).toBe('A\nB');
  });
  it('preserves paragraph break across nested div', () => {
    expect(htmlToPlainText('<div>First</div><div>Second</div>')).toBe('First\nSecond');
  });
  it('decodes &amp; &lt; &gt; &quot; &nbsp;', () => {
    expect(htmlToPlainText('&amp; &lt; &gt; &quot; A&nbsp;B')).toBe('& < > " A B');
  });
  it('collapses 3+ blank lines to one', () => {
    expect(htmlToPlainText('A<br><br><br><br>B')).toBe('A\n\nB');
  });
  it('returns empty string for null/empty input', () => {
    expect(htmlToPlainText(null)).toBe('');
    expect(htmlToPlainText('')).toBe('');
  });
});

describe('escapeHtml', () => {
  it('escapes <, >, &, ", \'', () => {
    expect(escapeHtml(`<script>"a'&b"</script>`))
      .toBe('&lt;script&gt;&quot;a&#39;&amp;b&quot;&lt;/script&gt;');
  });
});

describe('paragraphsToHtml', () => {
  it('wraps each paragraph in <p>', () => {
    expect(paragraphsToHtml('A\n\nB')).toBe('<p>A</p><p>B</p>');
  });
  it('converts single \\n to <br> within a paragraph', () => {
    expect(paragraphsToHtml('Line1\nLine2\n\nPara2')).toBe('<p>Line1<br>Line2</p><p>Para2</p>');
  });
  it('escapes injection attempts from model output', () => {
    expect(paragraphsToHtml('<script>alert(1)</script>'))
      .toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });
  it('returns empty <p></p> for empty input', () => {
    expect(paragraphsToHtml('')).toBe('<p></p>');
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `pnpm exec vitest run test/utils/html-utils.test.js`
Expected: All tests FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```js
// mail-worker/src/utils/html-utils.js
export function htmlToPlainText(html) {
  if (!html) return '';
  return html
    .replace(/<style[^>]*>.*?<\/style>/gis, '')
    .replace(/<script[^>]*>.*?<\/script>/gis, '')
    .replace(/<\/?(p|div|br|li|h[1-6]|tr)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function paragraphsToHtml(text) {
  return (text || '')
    .split(/\n{2,}/)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}
```

**Note:** `paragraphsToHtml` calls `escapeHtml` on the paragraph FIRST, then turns `\n` → `<br>` (so `<br>` survives the escape pass).

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm exec vitest run test/utils/html-utils.test.js`
Expected: All 11 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add mail-worker/src/utils/html-utils.js mail-worker/test/utils/html-utils.test.js
git commit -m "feat(translation): add HTML utilities with XSS-safe paragraph wrapping"
```

---

## Task 4: Robust JSON parser (TDD)

**Files:**
- Modify: `mail-worker/src/utils/html-utils.js` is unrelated — create new file:
- Create: `mail-worker/src/utils/robust-json.js`
- Create: `mail-worker/test/utils/robust-json.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// mail-worker/test/utils/robust-json.test.js
import { describe, it, expect } from 'vitest';
import { robustJsonParse } from '../../src/utils/robust-json';

describe('robustJsonParse', () => {
  it('parses bare JSON', () => {
    expect(robustJsonParse('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips ```json``` fences', () => {
    expect(robustJsonParse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('strips plain ``` fences', () => {
    expect(robustJsonParse('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('extracts JSON when model adds leading commentary', () => {
    expect(robustJsonParse('Here is the result:\n{"a":1}\nDone.')).toEqual({ a: 1 });
  });
  it('handles nested } in string values', () => {
    expect(robustJsonParse('{"body":"end of sentence}"}')).toEqual({ body: 'end of sentence}' });
  });
  it('returns null for null/empty/undefined', () => {
    expect(robustJsonParse(null)).toBeNull();
    expect(robustJsonParse('')).toBeNull();
    expect(robustJsonParse(undefined)).toBeNull();
  });
  it('returns null for non-JSON garbage', () => {
    expect(robustJsonParse('I am not JSON at all')).toBeNull();
  });
  it('returns null for malformed JSON inside fence', () => {
    expect(robustJsonParse('```{"a":}```')).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `pnpm exec vitest run test/utils/robust-json.test.js`
Expected: All tests FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```js
// mail-worker/src/utils/robust-json.js
export function robustJsonParse(raw) {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm exec vitest run test/utils/robust-json.test.js`
Expected: All 8 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add mail-worker/src/utils/robust-json.js mail-worker/test/utils/robust-json.test.js
git commit -m "feat(translation): add robust JSON parser for AI model output"
```

---

## Task 5: Language detection helper (TDD)

**Files:**
- Create: `mail-worker/src/utils/lang-detect.js`
- Create: `mail-worker/test/utils/lang-detect.test.js`

- [ ] **Step 1: Write the failing tests**

```js
// mail-worker/test/utils/lang-detect.test.js
import { describe, it, expect } from 'vitest';
import { detectLang } from '../../src/utils/lang-detect';

describe('detectLang', () => {
  it('detects English', () => {
    expect(detectLang('The quick brown fox jumps over the lazy dog. ' +
      'A long enough sample for franc to lock in on English.')).toBe('en');
  });
  it('detects Simplified Chinese', () => {
    expect(detectLang('这是一段中文文本，用于测试语言检测功能。请确认检测器能够识别中文。')).toBe('zh');
  });
  it('detects Japanese', () => {
    expect(detectLang('これは日本語のテキストです。言語検出機能をテストするための文字列です。')).toBe('ja');
  });
  it('returns "und" for too-short text', () => {
    expect(detectLang('Hi')).toBe('und');
  });
  it('returns "und" for empty/null', () => {
    expect(detectLang('')).toBe('und');
    expect(detectLang(null)).toBe('und');
  });
});
```

- [ ] **Step 2: Run tests, expect FAIL**

Run: `pnpm exec vitest run test/utils/lang-detect.test.js`
Expected: All tests FAIL — module does not exist.

- [ ] **Step 3: Write the implementation**

```js
// mail-worker/src/utils/lang-detect.js
import { franc } from 'franc-min';
import { iso6393To1 } from 'iso-639-3';

// Returns ISO 639-1 code (e.g. 'en', 'zh') or 'und' when detection is uncertain.
export function detectLang(text) {
  if (!text || typeof text !== 'string') return 'und';
  const code3 = franc(text, { minLength: 10 });   // franc returns ISO 639-3, e.g. 'cmn', 'eng'
  if (code3 === 'und') return 'und';
  const code1 = iso6393To1[code3];
  return code1 || 'und';
}
```

- [ ] **Step 4: Run tests, expect PASS**

Run: `pnpm exec vitest run test/utils/lang-detect.test.js`
Expected: All 5 tests PASS.

**Note:** franc returns `'cmn'` for Mandarin Chinese; `iso6393To1['cmn']` is `'zh'`. If a test fails on the Chinese case, check that mapping.

- [ ] **Step 5: Commit**

```bash
git add mail-worker/src/utils/lang-detect.js mail-worker/test/utils/lang-detect.test.js
git commit -m "feat(translation): add franc-min language detection helper"
```

---

## Task 6: Drizzle entity + init migration

**Files:**
- Create: `mail-worker/src/entity/email-translation.js`
- Modify: `mail-worker/src/init/init.js`

- [ ] **Step 1: Create the Drizzle schema**

```js
// mail-worker/src/entity/email-translation.js
import { sqliteTable, text, integer, primaryKey, index } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const emailTranslation = sqliteTable('email_translation', {
  emailId: integer('email_id').notNull(),
  targetLang: text('target_lang').notNull(),
  userId: integer('user_id').notNull(),
  translatedSubject: text('translated_subject').notNull(),
  translatedContent: text('translated_content').notNull(),
  sourceLang: text('source_lang'),
  model: text('model').notNull(),
  createTime: text('create_time').default(sql`CURRENT_TIMESTAMP`).notNull(),
}, (t) => ({
  pk: primaryKey({ columns: [t.emailId, t.targetLang] }),
  userIdx: index('idx_translation_user').on(t.userId),
  emailIdx: index('idx_translation_email').on(t.emailId),
}));

export default emailTranslation;
```

- [ ] **Step 2: Add migration SQL to init.js**

Find the section in `mail-worker/src/init/init.js` where other `CREATE TABLE IF NOT EXISTS` statements live, and append:

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

**Verify** the placement: search for an existing `CREATE TABLE IF NOT EXISTS` in `init.js` (e.g., the `star` or `email` table) and put the new statements right after them, inside the same async init function.

- [ ] **Step 3: Run wrangler locally to verify migration applies**

```bash
cd mail-worker
pnpm exec wrangler d1 execute <your-d1-db-name> --local --command="SELECT name FROM sqlite_master WHERE type='table' AND name='email_translation';"
```

Then trigger init by running:
```bash
pnpm exec wrangler dev --config wrangler-dev.toml
```

In another shell, hit any endpoint that triggers init (e.g. open the SPA at the dev URL once).

Re-run the SELECT query — expect `email_translation` row to appear.

- [ ] **Step 4: Commit**

```bash
git add mail-worker/src/entity/email-translation.js mail-worker/src/init/init.js
git commit -m "feat(translation): add email_translation table and Drizzle entity"
```

---

## Task 7: Translation service — cache hit path (TDD)

**Files:**
- Create: `mail-worker/src/service/translation-service.js`
- Create: `mail-worker/test/service/translation-service.test.js`

- [ ] **Step 1: Write the failing test**

```js
// mail-worker/test/service/translation-service.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import translationService from '../../src/service/translation-service';
import orm from '../../src/entity/orm';
import { emailTranslation } from '../../src/entity/email-translation';
import { email } from '../../src/entity/email';

function mkCtx() {
  return { env };
}

describe('translationService.translate — cache hit', () => {
  beforeEach(async () => {
    await orm(mkCtx()).delete(emailTranslation).run();
    await orm(mkCtx()).delete(email).run();
  });

  it('returns cached translation without calling AI', async () => {
    const ctx = mkCtx();
    // Seed: insert an email + a pre-existing translation row
    await orm(ctx).insert(email).values({
      emailId: 1001, userId: 42, subject: 'Hello', content: '<p>Hello</p>',
      text: 'Hello', toEmail: 'a@b.c', toName: 'A', accountId: 1,
    }).run();
    await orm(ctx).insert(emailTranslation).values({
      emailId: 1001, targetLang: 'zh', userId: 42,
      translatedSubject: '你好', translatedContent: '<p>你好</p>',
      sourceLang: 'en', model: 'test-model',
    }).run();

    // Force AI to throw if called — proves cache hit path doesn't invoke it
    const ctxWithMockAI = {
      env: { ...env, AI: { run: () => { throw new Error('AI should not be called on cache hit'); } } },
    };

    const result = await translationService.translate(ctxWithMockAI, {
      emailId: 1001, targetLang: 'zh', userId: 42,
    });
    expect(result.fromCache).toBe(true);
    expect(result.translatedSubject).toBe('你好');
    expect(result.translatedContent).toBe('<p>你好</p>');
    expect(result.sourceLang).toBe('en');
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm exec vitest run test/service/translation-service.test.js`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Write the minimal service (cache hit only)**

```js
// mail-worker/src/service/translation-service.js
import { and, eq } from 'drizzle-orm';
import orm from '../entity/orm';
import { emailTranslation } from '../entity/email-translation';
import { SUPPORTED_TARGET_LANGS } from '../const/translation-const';
import BizError from '../error/biz-error';

const translationService = {
  async translate(c, { emailId, targetLang, userId }) {
    if (!SUPPORTED_TARGET_LANGS.includes(targetLang)) {
      throw new BizError('langNotSupported', 400);
    }

    // 1) Cache lookup
    const cached = await orm(c).select().from(emailTranslation)
      .where(and(
        eq(emailTranslation.emailId, emailId),
        eq(emailTranslation.targetLang, targetLang),
        eq(emailTranslation.userId, userId),
      )).get();

    if (cached) {
      return {
        translatedSubject: cached.translatedSubject,
        translatedContent: cached.translatedContent,
        sourceLang: cached.sourceLang,
        fromCache: true,
      };
    }

    // Cache miss path — implemented in next tasks
    throw new BizError('notImplemented', 500);
  },
};

export default translationService;
```

- [ ] **Step 4: Run test, expect PASS**

Run: `pnpm exec vitest run test/service/translation-service.test.js`
Expected: PASS (the single cache-hit test).

- [ ] **Step 5: Commit**

```bash
git add mail-worker/src/service/translation-service.js mail-worker/test/service/translation-service.test.js
git commit -m "feat(translation): add translation service with cache-hit path"
```

---

## Task 8: Translation service — cache miss + AI call (TDD)

**Files:**
- Modify: `mail-worker/src/service/translation-service.js`
- Modify: `mail-worker/test/service/translation-service.test.js`

- [ ] **Step 1: Add the failing test for cache miss**

Append to `test/service/translation-service.test.js`:

```js
describe('translationService.translate — cache miss', () => {
  beforeEach(async () => {
    await orm(mkCtx()).delete(emailTranslation).run();
    await orm(mkCtx()).delete(email).run();
  });

  it('calls AI, writes row, returns translation', async () => {
    const ctx = mkCtx();
    await orm(ctx).insert(email).values({
      emailId: 2001, userId: 7, subject: 'Quarterly update',
      content: '<p>Revenue up 12%. Headcount unchanged.</p>',
      text: 'Revenue up 12%. Headcount unchanged.', toEmail: 'x@y.z', toName: 'X', accountId: 1,
    }).run();

    const mockAI = {
      run: async (model, payload) => {
        expect(model).toBe('@cf/meta/llama-3.1-8b-instruct-fast');
        expect(payload.messages[1].content).toContain('Revenue up 12%');
        return {
          response: JSON.stringify({
            sourceLang: 'en',
            subject: '季度更新',
            body: '收入增长 12%。员工人数不变。',
          }),
        };
      },
    };
    const ctxAI = { env: { ...env, AI: mockAI } };

    const result = await translationService.translate(ctxAI, {
      emailId: 2001, targetLang: 'zh', userId: 7,
    });
    expect(result.fromCache).toBe(false);
    expect(result.translatedSubject).toBe('季度更新');
    expect(result.translatedContent).toBe('<p>收入增长 12%。员工人数不变。</p>');
    expect(result.sourceLang).toBe('en');

    // Verify the row was persisted
    const row = await orm(ctxAI).select().from(emailTranslation).get();
    expect(row.emailId).toBe(2001);
    expect(row.translatedSubject).toBe('季度更新');
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm exec vitest run test/service/translation-service.test.js`
Expected: New "cache miss" test FAILs with `notImplemented` error.

- [ ] **Step 3: Implement cache miss path**

Replace the body of `translate()` in `mail-worker/src/service/translation-service.js`:

```js
import { and, eq } from 'drizzle-orm';
import orm from '../entity/orm';
import { emailTranslation } from '../entity/email-translation';
import { email } from '../entity/email';
import BizError from '../error/biz-error';
import {
  MODEL_ID, SUPPORTED_TARGET_LANGS, LANG_NAMES, MAX_INPUT_CHARS, MAX_RETRY_ATTEMPTS,
} from '../const/translation-const';
import { htmlToPlainText, paragraphsToHtml } from '../utils/html-utils';
import { robustJsonParse } from '../utils/robust-json';
import { detectLang } from '../utils/lang-detect';

const translationService = {
  async translate(c, { emailId, targetLang, userId }) {
    if (!SUPPORTED_TARGET_LANGS.includes(targetLang)) {
      throw new BizError('langNotSupported', 400);
    }

    // 1) Cache lookup
    const cached = await orm(c).select().from(emailTranslation)
      .where(and(
        eq(emailTranslation.emailId, emailId),
        eq(emailTranslation.targetLang, targetLang),
        eq(emailTranslation.userId, userId),
      )).get();

    if (cached) {
      return {
        translatedSubject: cached.translatedSubject,
        translatedContent: cached.translatedContent,
        sourceLang: cached.sourceLang,
        fromCache: true,
      };
    }

    // 2) AI binding required for cache miss
    if (!c.env.AI) throw new BizError('aiNotConfigured', 503);

    // 3) Load email + authz
    const e = await orm(c).select().from(email)
      .where(and(eq(email.emailId, emailId), eq(email.userId, userId)))
      .get();
    if (!e) throw new BizError('emailNotFound', 404);

    // 4) Plain text + truncate
    let plainText = htmlToPlainText(e.content || e.text || '');
    let truncated = false;
    if (plainText.length > MAX_INPUT_CHARS) {
      plainText = plainText.slice(0, MAX_INPUT_CHARS) + '\n\n[...truncated]';
      truncated = true;
    }

    // 5) Call AI
    const aiResult = await callTranslationModel(c.env.AI, {
      subject: e.subject || '',
      content: plainText,
      targetLang,
    });

    // 6) Wrap output back to HTML
    const translatedContentHtml = paragraphsToHtml(aiResult.body);

    // 7) Persist (INSERT OR IGNORE so concurrent requests don't crash)
    await orm(c).insert(emailTranslation).values({
      emailId, targetLang, userId,
      translatedSubject: aiResult.subject,
      translatedContent: translatedContentHtml,
      sourceLang: aiResult.sourceLang || null,
      model: MODEL_ID,
    }).onConflictDoNothing().run();

    return {
      translatedSubject: aiResult.subject,
      translatedContent: translatedContentHtml,
      sourceLang: aiResult.sourceLang || null,
      fromCache: false,
      truncated,
    };
  },
};

async function callTranslationModel(AI, { subject, content, targetLang, attempt = 1 }) {
  const langName = LANG_NAMES[targetLang];
  const systemPrompt = `You are a professional email translator. ` +
    `Translate the user's email subject and body to ${langName}. ` +
    `Return ONLY a JSON object with this exact shape (no markdown fence, no commentary):\n` +
    `{"sourceLang": "<ISO 639-1 code>", "subject": "<translated subject>", "body": "<translated body>"}\n` +
    `Rules:\n` +
    `- Preserve paragraph breaks (use \\n\\n between paragraphs in body).\n` +
    `- Do NOT translate proper names, email addresses, URLs, code blocks.\n` +
    `- Keep numbers, dates, currency unchanged.\n` +
    `- Output JSON only.`;

  const userPrompt = `Subject: ${subject}\n\nBody:\n${content}`;

  let resp;
  try {
    resp = await AI.run(MODEL_ID, {
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      max_tokens: 4096,
      temperature: 0.2,
    });
  } catch (e) {
    if (e?.status === 429 || /rate limit/i.test(e?.message || '')) throw new BizError('aiRateLimited', 429);
    if (/timeout/i.test(e?.message || '')) throw new BizError('aiTimeout', 504);
    throw new BizError('aiBadOutput', 502);
  }

  const parsed = robustJsonParse(resp.response);
  if (!parsed || typeof parsed.subject !== 'string' || typeof parsed.body !== 'string') {
    if (attempt < MAX_RETRY_ATTEMPTS) {
      return callTranslationModel(AI, { subject, content, targetLang, attempt: attempt + 1 });
    }
    throw new BizError('aiBadOutput', 502);
  }
  return parsed;
}

export default translationService;
```

- [ ] **Step 4: Run all service tests, expect PASS**

Run: `pnpm exec vitest run test/service/translation-service.test.js`
Expected: Both tests (cache hit + cache miss) PASS.

- [ ] **Step 5: Commit**

```bash
git add mail-worker/src/service/translation-service.js mail-worker/test/service/translation-service.test.js
git commit -m "feat(translation): implement AI call path with cache write"
```

---

## Task 9: Translation service — same-language short-circuit (TDD)

**Files:**
- Modify: `mail-worker/src/service/translation-service.js`
- Modify: `mail-worker/test/service/translation-service.test.js`

- [ ] **Step 1: Add the failing test**

Append to `test/service/translation-service.test.js`:

```js
describe('translationService.translate — same language', () => {
  beforeEach(async () => {
    await orm(mkCtx()).delete(emailTranslation).run();
    await orm(mkCtx()).delete(email).run();
  });

  it('returns alreadyInTargetLang without calling AI when source equals target', async () => {
    const ctx = mkCtx();
    await orm(ctx).insert(email).values({
      emailId: 3001, userId: 9, subject: 'Hi',
      content: 'The quick brown fox jumps over the lazy dog. Long enough to detect English.',
      text: 'The quick brown fox jumps over the lazy dog. Long enough to detect English.',
      toEmail: 'a@b.c', toName: 'A', accountId: 1,
    }).run();

    const ctxAI = {
      env: { ...env, AI: { run: () => { throw new Error('AI should not be called'); } } },
    };

    const result = await translationService.translate(ctxAI, {
      emailId: 3001, targetLang: 'en', userId: 9,
    });
    expect(result.alreadyInTargetLang).toBe(true);
    expect(result.sourceLang).toBe('en');

    // No DB row written
    const rows = await orm(ctxAI).select().from(emailTranslation).all();
    expect(rows.length).toBe(0);
  });
});
```

- [ ] **Step 2: Run test, expect FAIL**

Run: `pnpm exec vitest run test/service/translation-service.test.js`
Expected: New test FAILs (currently it would call AI, which throws).

- [ ] **Step 3: Insert detection step in service**

In `mail-worker/src/service/translation-service.js`, between step 3 (load email + authz) and step 4 (truncate), add:

```js
    // 3.5) Same-language short-circuit
    const detected = detectLang((e.content || e.text || '').slice(0, 500));
    if (detected !== 'und' && detected === targetLang) {
      return { alreadyInTargetLang: true, sourceLang: detected };
    }
```

- [ ] **Step 4: Run all service tests, expect PASS**

Run: `pnpm exec vitest run test/service/translation-service.test.js`
Expected: All 3 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add mail-worker/src/service/translation-service.js mail-worker/test/service/translation-service.test.js
git commit -m "feat(translation): short-circuit when source language equals target"
```

---

## Task 10: Translation service — error paths (TDD)

**Files:**
- Modify: `mail-worker/test/service/translation-service.test.js`

The service already throws all the relevant errors from Task 8; this task adds tests to lock the behavior.

- [ ] **Step 1: Add failing tests**

Append to `test/service/translation-service.test.js`:

```js
describe('translationService.translate — error paths', () => {
  beforeEach(async () => {
    await orm(mkCtx()).delete(emailTranslation).run();
    await orm(mkCtx()).delete(email).run();
  });

  it('throws langNotSupported for unknown targetLang', async () => {
    await expect(
      translationService.translate(mkCtx(), { emailId: 1, targetLang: 'xx', userId: 1 })
    ).rejects.toMatchObject({ message: 'langNotSupported', code: 400 });
  });

  it('throws aiNotConfigured when env.AI is missing', async () => {
    const ctxNoAI = { env: { ...env, AI: undefined } };
    await orm(ctxNoAI).insert(email).values({
      emailId: 4001, userId: 1, subject: 'S', content: 'Some German text would go here.',
      text: 'Some German text would go here.', toEmail: 'a@b.c', toName: 'A', accountId: 1,
    }).run();
    await expect(
      translationService.translate(ctxNoAI, { emailId: 4001, targetLang: 'zh', userId: 1 })
    ).rejects.toMatchObject({ message: 'aiNotConfigured', code: 503 });
  });

  it('throws emailNotFound for missing emailId', async () => {
    const ctxAI = { env: { ...env, AI: { run: () => ({ response: '{}' }) } } };
    await expect(
      translationService.translate(ctxAI, { emailId: 99999, targetLang: 'zh', userId: 1 })
    ).rejects.toMatchObject({ message: 'emailNotFound', code: 404 });
  });

  it('throws emailNotFound when emailId belongs to a different user', async () => {
    const ctx = mkCtx();
    await orm(ctx).insert(email).values({
      emailId: 5001, userId: 100, subject: 'X', content: 'foo', text: 'foo',
      toEmail: 'a@b.c', toName: 'A', accountId: 1,
    }).run();
    const ctxAI = { env: { ...env, AI: { run: () => ({ response: '{}' }) } } };
    await expect(
      translationService.translate(ctxAI, { emailId: 5001, targetLang: 'zh', userId: 200 })
    ).rejects.toMatchObject({ message: 'emailNotFound', code: 404 });
  });

  it('throws aiBadOutput after retrying once with bad model output', async () => {
    const ctx = mkCtx();
    await orm(ctx).insert(email).values({
      emailId: 6001, userId: 1, subject: 'Q',
      content: 'A German text Das ist ein Test mit genug Inhalt für die Erkennung.',
      text: 'A German text Das ist ein Test mit genug Inhalt für die Erkennung.',
      toEmail: 'a@b.c', toName: 'A', accountId: 1,
    }).run();

    let calls = 0;
    const ctxAI = {
      env: { ...env, AI: { run: () => { calls++; return { response: 'totally not json' }; } } },
    };
    await expect(
      translationService.translate(ctxAI, { emailId: 6001, targetLang: 'zh', userId: 1 })
    ).rejects.toMatchObject({ message: 'aiBadOutput', code: 502 });
    expect(calls).toBe(2);   // initial + 1 retry
  });
});
```

- [ ] **Step 2: Run tests, expect PASS**

Run: `pnpm exec vitest run test/service/translation-service.test.js`
Expected: All 8 tests PASS (3 happy paths from earlier + 5 error paths).

If `aiNotConfigured` test fails because the service checks `env.AI` only AFTER the cache lookup — that's fine, since this email has no cache row. If it fails for a different reason, verify the order: cache lookup → AI presence check.

- [ ] **Step 3: Commit**

```bash
git add mail-worker/test/service/translation-service.test.js
git commit -m "test(translation): lock error paths for service layer"
```

---

## Task 11: Translation service — truncation flag (TDD)

**Files:**
- Modify: `mail-worker/test/service/translation-service.test.js`

- [ ] **Step 1: Add the failing test**

Append to `test/service/translation-service.test.js`:

```js
describe('translationService.translate — truncation', () => {
  beforeEach(async () => {
    await orm(mkCtx()).delete(emailTranslation).run();
    await orm(mkCtx()).delete(email).run();
  });

  it('truncates input and sets truncated=true when over MAX_INPUT_CHARS', async () => {
    const ctx = mkCtx();
    const longText = 'Das ist ein deutscher Text. '.repeat(2000);   // ~56000 chars
    await orm(ctx).insert(email).values({
      emailId: 7001, userId: 1, subject: 'Long', content: longText, text: longText,
      toEmail: 'a@b.c', toName: 'A', accountId: 1,
    }).run();

    let receivedBody;
    const mockAI = {
      run: async (_model, payload) => {
        receivedBody = payload.messages[1].content;
        return { response: JSON.stringify({ sourceLang: 'de', subject: 'Long', body: 'OK' }) };
      },
    };
    const ctxAI = { env: { ...env, AI: mockAI } };

    const result = await translationService.translate(ctxAI, {
      emailId: 7001, targetLang: 'zh', userId: 1,
    });
    expect(result.truncated).toBe(true);
    expect(receivedBody.length).toBeLessThan(longText.length);
    expect(receivedBody).toContain('[...truncated]');
  });
});
```

- [ ] **Step 2: Run test, expect PASS**

Run: `pnpm exec vitest run test/service/translation-service.test.js`
Expected: All 9 tests PASS. (Service already implements truncation from Task 8.)

- [ ] **Step 3: Commit**

```bash
git add mail-worker/test/service/translation-service.test.js
git commit -m "test(translation): verify input truncation for over-length emails"
```

---

## Task 12: API route + permission + wire-up

**Files:**
- Create: `mail-worker/src/api/translation-api.js`
- Modify: `mail-worker/src/security/security.js`
- Modify: `mail-worker/src/hono/webs.js`
- Modify: `mail-worker/src/i18n/zh.js`
- Modify: `mail-worker/src/i18n/en.js`

- [ ] **Step 1: Add error message i18n keys**

Append to `mail-worker/src/i18n/zh.js` (inside the default-export object):

```js
langNotSupported: '不支持的目标语言',
aiNotConfigured: 'AI 服务未配置',
emailNotFound: '邮件不存在',
aiBadOutput: '翻译服务返回异常',
aiTimeout: '翻译请求超时',
aiRateLimited: '翻译请求过多，请稍后重试',
```

Append to `mail-worker/src/i18n/en.js`:

```js
langNotSupported: 'Target language not supported',
aiNotConfigured: 'AI service not configured',
emailNotFound: 'Email not found',
aiBadOutput: 'Translation service returned invalid output',
aiTimeout: 'Translation request timed out',
aiRateLimited: 'Too many translation requests, please retry later',
```

(Update the service's `BizError('langNotSupported', ...)` strings to match these keys if they differ — they should already match.)

- [ ] **Step 2: Create the API route file**

```js
// mail-worker/src/api/translation-api.js
import app from '../hono/hono';
import translationService from '../service/translation-service';
import userContext from '../security/user-context';
import result from '../model/result';

app.post('/translation/translate', async (c) => {
  const { emailId, targetLang } = await c.req.json();
  const userId = userContext.getUserId(c);
  const data = await translationService.translate(c, {
    emailId: Number(emailId),
    targetLang,
    userId,
  });
  return c.json(result.ok(data));
});
```

- [ ] **Step 3: Register the route in webs.js**

Modify `mail-worker/src/hono/webs.js`. Add at the bottom of the import list (after `import '../api/agent-api';`):

```js
import '../api/translation-api';
```

- [ ] **Step 4: Add permission entry**

In `mail-worker/src/security/security.js`, find the permission map (lines around 65-83) and add inside it:

```js
'email:translate': ['/translation/translate'],
```

- [ ] **Step 5: Add an integration test for the wired route**

Append to `mail-worker/test/service/translation-service.test.js` (or create `mail-worker/test/api/translation-api.test.js` if you prefer separation):

```js
import { SELF } from 'cloudflare:test';

describe('translation API — HTTP', () => {
  // Skip if you don't have a way to set userId on the request in test setup.
  // Otherwise this requires existing auth helpers from the codebase.
  it.skip('POST /api/translation/translate (requires test auth setup)', async () => {
    // Placeholder — implement once test auth helper is identified.
  });
});
```

**Why skipped:** the existing test suite has only the hello-world stub; full auth-aware integration tests require a helper that doesn't exist yet. Service-level tests in Tasks 7-11 already exercise the logic; HTTP integration is verified manually in Task 19. Adding test-auth scaffolding is out of scope.

- [ ] **Step 6: Run all tests one more time**

Run: `pnpm exec vitest run`
Expected: All tests PASS, including the new skipped HTTP test (skipped count: 1).

- [ ] **Step 7: Commit**

```bash
git add mail-worker/src/api/translation-api.js \
        mail-worker/src/security/security.js \
        mail-worker/src/hono/webs.js \
        mail-worker/src/i18n/zh.js \
        mail-worker/src/i18n/en.js \
        mail-worker/test/service/translation-service.test.js
git commit -m "feat(translation): expose POST /translation/translate with permission gate"
```

---

## Task 13: Cascade delete hook

**Files:**
- Modify: `mail-worker/src/service/email-service.js`

- [ ] **Step 1: Locate the deletion methods**

Search for `permanentDelete` in `mail-worker/src/service/email-service.js`:

```bash
grep -n "permanentDelete\|batchPermanentDelete" mail-worker/src/service/email-service.js
```

Note the line numbers and exact method signatures.

- [ ] **Step 2: Add cascade delete inside permanentDelete**

Wherever the method runs `orm(c).delete(email).where(...)`, add (immediately before or after, inside the same method):

```js
import { emailTranslation } from '../entity/email-translation';
// ... inside permanentDelete, after deleting the email row:
await orm(c).delete(emailTranslation)
  .where(eq(emailTranslation.emailId, emailId))
  .run();
```

If the import is missing at the top of the file, add it. If `eq` isn't imported, add it from `'drizzle-orm'`.

- [ ] **Step 3: Add cascade delete inside batchPermanentDelete**

For the batch method, use `inArray`:

```js
import { inArray } from 'drizzle-orm';
// ... inside batchPermanentDelete, after deleting email rows:
await orm(c).delete(emailTranslation)
  .where(inArray(emailTranslation.emailId, emailIds))   // adapt to actual param name
  .run();
```

- [ ] **Step 4: Add a test**

Append to `mail-worker/test/service/translation-service.test.js`:

```js
import emailService from '../../src/service/email-service';

describe('email cascade — translations', () => {
  beforeEach(async () => {
    await orm(mkCtx()).delete(emailTranslation).run();
    await orm(mkCtx()).delete(email).run();
  });

  it('removes translation rows when email is permanently deleted', async () => {
    const ctx = mkCtx();
    await orm(ctx).insert(email).values({
      emailId: 8001, userId: 1, subject: 'X', content: 'x', text: 'x',
      toEmail: 'a@b.c', toName: 'A', accountId: 1,
    }).run();
    await orm(ctx).insert(emailTranslation).values({
      emailId: 8001, targetLang: 'zh', userId: 1,
      translatedSubject: 'X', translatedContent: '<p>X</p>',
      sourceLang: 'en', model: 'test',
    }).run();

    // Call the actual deletion path. Signature may vary — check what permanentDelete expects.
    await emailService.permanentDelete(ctx, { emailId: 8001 }, 1);

    const rows = await orm(ctx).select().from(emailTranslation).all();
    expect(rows.length).toBe(0);
  });
});
```

**Note:** The `permanentDelete` signature is project-specific — if it takes `(c, params, userId)` like other services, adjust the call. Run `grep -n "permanentDelete" mail-worker/src/api/email-api.js` to see the exact call pattern.

- [ ] **Step 5: Run tests, expect PASS**

Run: `pnpm exec vitest run test/service/translation-service.test.js`
Expected: New cascade test PASSes alongside the rest.

- [ ] **Step 6: Commit**

```bash
git add mail-worker/src/service/email-service.js mail-worker/test/service/translation-service.test.js
git commit -m "feat(translation): cascade-delete translations on email permanent delete"
```

---

## Task 14: Setting service — expose aiEnabled flag

**Files:**
- Modify: `mail-worker/src/service/setting-service.js`

- [ ] **Step 1: Locate the settings GET method**

Search for the method that returns settings to the frontend:

```bash
grep -n "async get\|async info\|getInfo\|getSetting" mail-worker/src/service/setting-service.js
```

Identify the method that the frontend's `useSettingStore` populates from.

- [ ] **Step 2: Add aiEnabled to the returned object**

In that method, where the returned object is built (e.g., `return { ... }` or a `settings` object that's merged with KV-stored values), add:

```js
aiEnabled: !!c.env.AI,
```

If the method reads from KV, merge it like this:
```js
const settings = await readFromKV(c);
return { ...settings, aiEnabled: !!c.env.AI };
```

- [ ] **Step 3: Manually verify**

```bash
cd mail-worker
pnpm exec wrangler dev --config wrangler-dev.toml
```

In another shell, with the frontend running or via curl against the dev API, hit the settings endpoint (e.g., `GET /api/setting/info` or whatever the actual path is — find with `grep "setting" mail-worker/src/api/setting-api.js`):

```bash
curl http://localhost:8787/api/setting/info \
  -H "Cookie: <your-dev-auth-cookie>"
```

Expected: response JSON includes `"aiEnabled": false` (since `[ai]` is commented out in `wrangler-dev.toml`).

Optionally uncomment the `[ai]` binding in `wrangler-dev.toml`, restart, hit again — expect `"aiEnabled": true`.

- [ ] **Step 4: Commit**

```bash
git add mail-worker/src/service/setting-service.js
git commit -m "feat(translation): expose aiEnabled flag in settings response"
```

---

## Task 15: Frontend API client

**Files:**
- Create: `mail-vue/src/request/translation.js`

- [ ] **Step 1: Create the file**

Check the existing pattern first:
```bash
cat mail-vue/src/request/star.js
```

Mirror that pattern. Typical content:

```js
// mail-vue/src/request/translation.js
import http from '@/axios/index.js';

export function translateEmail(emailId, targetLang) {
  return http.post('/translation/translate', { emailId, targetLang });
}
```

Adjust the import path to match what `mail-vue/src/request/star.js` uses (might be `@/axios/index.js` or another helper).

- [ ] **Step 2: Commit**

```bash
git add mail-vue/src/request/translation.js
git commit -m "feat(translation-ui): add API client for translation endpoint"
```

---

## Task 16: Frontend i18n strings

**Files:**
- Modify: `mail-vue/src/i18n/zh.js`
- Modify: `mail-vue/src/i18n/en.js`

- [ ] **Step 1: Add 7 strings to zh.js**

Append inside the default-export object:

```js
translate: '翻译',
translateBack: '显示原文',
translationCached: '已缓存译文，点击查看',
translatedFrom: '已从 {lang} 翻译',
showOriginal: '查看原文',
alreadyInTargetLang: '邮件已是当前语言',
translationFailed: '翻译失败，请稍后重试',
```

- [ ] **Step 2: Add 7 strings to en.js**

```js
translate: 'Translate',
translateBack: 'Show original',
translationCached: 'Translation cached — click to view',
translatedFrom: 'Translated from {lang}',
showOriginal: 'Show original',
alreadyInTargetLang: 'Email is already in target language',
translationFailed: 'Translation failed, please retry',
```

- [ ] **Step 3: Commit**

```bash
git add mail-vue/src/i18n/zh.js mail-vue/src/i18n/en.js
git commit -m "feat(translation-ui): add translation UI strings (zh, en)"
```

---

## Task 17: Frontend setting store — aiEnabled flag

**Files:**
- Modify: `mail-vue/src/store/setting.js`

- [ ] **Step 1: Add aiEnabled to state**

Open `mail-vue/src/store/setting.js`. In the Pinia store's `state` (or wherever defaults are declared), add:

```js
aiEnabled: false,
```

- [ ] **Step 2: Populate it from the GET response**

Wherever the store handles the settings GET response (typically a method like `loadSetting` or `initSetting`), ensure `aiEnabled` is copied from the response:

```js
this.aiEnabled = !!data.aiEnabled;
```

- [ ] **Step 3: Manual verify**

```bash
cd mail-vue
pnpm dev
```

Open the browser, log in, then in DevTools console:
```js
useSettingStore().aiEnabled    // expect false (no AI binding), or true if enabled
```

- [ ] **Step 4: Commit**

```bash
git add mail-vue/src/store/setting.js
git commit -m "feat(translation-ui): track aiEnabled in setting store"
```

---

## Task 18: Frontend content view — Translate button + state machine

**Files:**
- Modify: `mail-vue/src/views/content/index.vue`

- [ ] **Step 1: Add reactive state, computed, and method**

In the `<script setup>` block of `mail-vue/src/views/content/index.vue`, add (near the top, after existing imports):

```js
import { translateEmail } from '@/request/translation.js';

const state = ref('idle');                      // 'idle' | 'loading' | 'translated' | 'error'
const translatedSubject = ref('');
const translatedContent = ref('');
const sourceLang = ref('');

const targetLang = computed(() => {
  return locale.value.split(/[-_]/)[0].toLowerCase();   // 'zh-CN' → 'zh'
});

const displaySubject = computed(() =>
  state.value === 'translated' ? translatedSubject.value : email.subject
);
const displayContent = computed(() =>
  state.value === 'translated' ? translatedContent.value : email.content
);

// Reset translation state when switching emails
watch(() => email.emailId, () => {
  state.value = 'idle';
  translatedSubject.value = '';
  translatedContent.value = '';
  sourceLang.value = '';
});

async function toggleTranslation() {
  if (state.value === 'loading') return;
  if (state.value === 'translated') {
    state.value = 'idle';
    return;
  }
  if (translatedContent.value) {
    state.value = 'translated';
    return;
  }
  state.value = 'loading';
  try {
    const data = await translateEmail(email.emailId, targetLang.value);
    if (data.alreadyInTargetLang) {
      ElMessage.info(t('alreadyInTargetLang'));
      state.value = 'idle';
      return;
    }
    translatedSubject.value = data.translatedSubject;
    translatedContent.value = data.translatedContent;
    sourceLang.value = data.sourceLang || '';
    state.value = 'translated';
  } catch (err) {
    ElMessage.error(t('translationFailed'));
    state.value = 'idle';
  }
}
```

Ensure these imports are present in the existing `<script setup>` (they may already be there):
- `ref, computed, watch` from `'vue'`
- `useI18n` — check that `locale` and `t` are destructured from `useI18n()`
- `useSettingStore` (for `aiEnabled` check below)
- `ElMessage` from `'element-plus'`

- [ ] **Step 2: Add Translate icon to header-actions in template**

In the `<template>` block, find the `<div class="header-actions">` and add this **after** the reply/forward icons (so it doesn't disturb existing layout):

```vue
<el-tooltip
  v-if="settingStore.aiEnabled"
  :content="state === 'translated' ? $t('showOriginal') : $t('translate')"
  placement="top">
  <Icon
    class="icon"
    :class="{ 'translating': state === 'loading' }"
    v-perm="'email:translate'"
    :icon="state === 'translated' ? 'mdi:translate-off' : 'mdi:translate'"
    width="20" height="20"
    @click="toggleTranslation"/>
</el-tooltip>
```

- [ ] **Step 3: Replace subject + content bindings with display computed**

Find `{{ email.subject }}` in the template and replace with `{{ displaySubject }}`.
Find `:html="formatImage(email.content)"` and replace with `:html="formatImage(displayContent)"`.

(Search for `email.content` and `email.subject` references — there may be more than one match. Only replace inside the rendering area, NOT in the watch dependencies or anywhere setting state.)

- [ ] **Step 4: Add "Translated from" banner above the email content**

After the `email-info` div and before the `el-scrollbar` containing the content, insert:

```vue
<el-alert
  v-if="state === 'translated'"
  type="info"
  :closable="false"
  class="translation-banner"
  show-icon>
  <span>{{ $t('translatedFrom', { lang: sourceLang || $t('langUnknown', 'auto') }) }}</span>
  <el-link type="primary" @click="toggleTranslation">&nbsp;{{ $t('showOriginal') }}</el-link>
</el-alert>
```

Add to i18n if missing — add `langUnknown: 'auto'` to both `zh.js` and `en.js` for the fallback.

- [ ] **Step 5: Add a small CSS rule for the translating icon spin**

In the `<style>` (or `<style scoped>`) block, add:

```css
.icon.translating {
  animation: spin 1s linear infinite;
  opacity: 0.6;
}
@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
.translation-banner {
  margin: 8px 0;
}
```

- [ ] **Step 6: Manual verify in browser**

```bash
cd mail-vue && pnpm dev
```

In another shell:
```bash
cd mail-worker && pnpm exec wrangler dev --config wrangler-dev.toml
```

Open the SPA, log in, open an English email (or any non-current-locale email), click the Translate icon.
- Expect: button shows loading spin → translation replaces text → click again reverts.
- Open same email again, click Translate: instant (cache hit).
- For a same-language email: toast "邮件已是当前语言", state stays idle.

- [ ] **Step 7: Commit**

```bash
git add mail-vue/src/views/content/index.vue mail-vue/src/i18n/zh.js mail-vue/src/i18n/en.js
git commit -m "feat(translation-ui): wire Translate button + state machine in email content view"
```

---

## Task 19: End-to-end manual acceptance

This task is verification-only — no code changes.

- [ ] **Step 1: Enable `[ai]` binding in `wrangler-dev.toml`**

```toml
[ai]
binding = "AI"
```

- [ ] **Step 2: Restart wrangler dev**

```bash
cd mail-worker
pnpm exec wrangler dev --config wrangler-dev.toml
```

- [ ] **Step 3: Run through the acceptance checklist**

For each scenario, open the dev SPA, log in, perform the action, record actual vs expected:

| Scenario | Expected | Actual |
|---|---|---|
| English newsletter (long, HTML-heavy) → translate to zh | Subject + body translate, no broken rendering | |
| German short message → translate to zh | Translation appears, sourceLang reads 'de' | |
| Chinese email in zh UI → click Translate | Toast "邮件已是当前语言", no translation | |
| Translate, then click button again | Reverts to original instantly | |
| Translate, navigate away, return, click Translate | Cache hit, instant render | |
| Very short ("Hi!") email → translate | Translation succeeds (franc returns 'und', AI handles) | |
| 200KB HTML email → translate | Truncation indicator appears; translation visible | |

- [ ] **Step 4: If a scenario fails, file an issue + fix**

Each failure should be reproducible with the recorded steps. Stop and fix before proceeding to deploy.

- [ ] **Step 5: Disable `[ai]` binding and verify graceful degradation**

Re-comment `[ai]` in `wrangler-dev.toml`, restart, log in. Open any email → expect: Translate button is NOT visible in the header-actions row.

- [ ] **Step 6: Commit the acceptance log (optional)**

If recording results in a markdown file:
```bash
git add docs/superpowers/plans/2026-05-15-email-translation-acceptance.md
git commit -m "docs(translation): manual acceptance test results"
```

---

## Task 20: Sync to cloud-mail (private) and cloud-mail-hybrid (production)

This task is repo-copy operations, no new code.

- [ ] **Step 1: Verify cloud-mail-plus is committed and clean**

```bash
cd ~/Documents/Developing/cloud-mail-plus
git status
```

Expected: clean working tree.

- [ ] **Step 2: Identify files added or modified by this feature**

```bash
cd ~/Documents/Developing/cloud-mail-plus
git diff --name-only HEAD~$(git log --oneline | grep -c 'translation') HEAD
```

Or by hand, the list:
```
mail-worker/package.json
mail-worker/pnpm-lock.yaml
mail-worker/src/const/translation-const.js
mail-worker/src/utils/html-utils.js
mail-worker/src/utils/robust-json.js
mail-worker/src/utils/lang-detect.js
mail-worker/src/entity/email-translation.js
mail-worker/src/service/translation-service.js
mail-worker/src/api/translation-api.js
mail-worker/src/security/security.js
mail-worker/src/hono/webs.js
mail-worker/src/init/init.js
mail-worker/src/service/setting-service.js
mail-worker/src/service/email-service.js
mail-worker/src/i18n/zh.js
mail-worker/src/i18n/en.js
mail-worker/test/utils/html-utils.test.js
mail-worker/test/utils/robust-json.test.js
mail-worker/test/utils/lang-detect.test.js
mail-worker/test/service/translation-service.test.js
mail-vue/src/request/translation.js
mail-vue/src/views/content/index.vue
mail-vue/src/store/setting.js
mail-vue/src/i18n/zh.js
mail-vue/src/i18n/en.js
```

- [ ] **Step 3: Copy each file to cloud-mail**

For each file in the list (the source-only ones, NOT package-lock):

```bash
SRC=~/Documents/Developing/cloud-mail-plus
DST=~/Documents/Developing/cloud-mail
for f in <files-from-step-2>; do
  mkdir -p "$DST/$(dirname "$f")"
  cp "$SRC/$f" "$DST/$f"
done
```

For modified files (`package.json`, `security.js`, `webs.js`, `init.js`, `setting-service.js`, `email-service.js`, all `i18n/*.js`, `setting.js`, `content/index.vue`), open each in cloud-mail and **manually merge** — cloud-mail may have private differences (e.g., extra domains in i18n).

- [ ] **Step 4: Verify Drizzle schema is byte-identical**

```bash
diff ~/Documents/Developing/cloud-mail-plus/mail-worker/src/entity/email-translation.js \
     ~/Documents/Developing/cloud-mail/mail-worker/src/entity/email-translation.js
```

Expected: no output (files identical).

- [ ] **Step 5: Repeat copy + diff for cloud-mail-hybrid**

```bash
SRC=~/Documents/Developing/cloud-mail-plus
DST=~/Documents/Developing/cloud-mail-hybrid
# (repeat the copy loop)
diff $SRC/mail-worker/src/entity/email-translation.js $DST/mail-worker/src/entity/email-translation.js
```

- [ ] **Step 6: Commit in each repo**

```bash
cd ~/Documents/Developing/cloud-mail
pnpm --filter mail-worker install   # if package.json changed
git add -A
git commit -m "feat(translation): add email translation feature (synced from cloud-mail-plus)"

cd ~/Documents/Developing/cloud-mail-hybrid
pnpm --filter mail-worker install
git add -A
git commit -m "feat(translation): add email translation feature (synced from cloud-mail-plus)"
```

- [ ] **Step 7: Push all three repos**

```bash
cd ~/Documents/Developing/cloud-mail-plus && git push
cd ~/Documents/Developing/cloud-mail && git push
cd ~/Documents/Developing/cloud-mail-hybrid && git push
```

---

## Task 21: Deploy cloud-mail-hybrid + production smoke test

- [ ] **Step 1: Verify hybrid wrangler config has `[ai]` binding**

```bash
cd ~/Documents/Developing/cloud-mail-hybrid
grep -A 1 "\[ai\]" wrangler.toml
```

Expected: `binding = "AI"` (not commented out).

If commented, uncomment and deploy a second time once the rest is verified. Or skip — translation will degrade gracefully (button hidden).

- [ ] **Step 2: Deploy**

```bash
cd ~/Documents/Developing/cloud-mail-hybrid
pnpm exec wrangler deploy
```

Expected: deploy succeeds; check the printed worker version.

- [ ] **Step 3: Verify migration applied**

```bash
pnpm exec wrangler d1 execute <hybrid-d1-db-name> --remote \
  --command="SELECT name FROM sqlite_master WHERE type='table' AND name='email_translation';"
```

Expected: 1 row (`email_translation`).

- [ ] **Step 4: Smoke test in production**

Open the production webmail. Open any English email. Click Translate.

Expected:
- Translation appears within ~2s
- Re-opening same email + clicking Translate is instant (cache hit)
- Same-language email shows "邮件已是当前语言" toast

- [ ] **Step 5: Verify Workers AI usage**

In Cloudflare dashboard → Workers & Pages → AI → Analytics, confirm:
- `@cf/meta/llama-3.1-8b-instruct-fast` shows the test calls
- Neuron consumption matches estimate (~45 per email)

- [ ] **Step 6: Announce in the upstream issue**

Reply to the original feature-request issue with a brief summary + screenshot:
```
Implemented in <commit-hash>. Translation now available via the
Translate icon on each email. Uses Cloudflare Workers AI
(@cf/meta/llama-3.1-8b-instruct-fast), with D1 cache so re-opening
translated emails is instant. Target language follows UI locale.
Free tier handles ~220 emails/day per Cloudflare account.
```

---

## Done criteria

- [ ] All 21 tasks above completed (each box ticked)
- [ ] `pnpm exec vitest run` reports all PASS in cloud-mail-plus
- [ ] Manual acceptance checklist in Task 19 has all rows green
- [ ] All three repos (`cloud-mail`, `cloud-mail-plus`, `cloud-mail-hybrid`) pushed
- [ ] Hybrid production smoke test confirms feature works on at least one real email
- [ ] Upstream issue closed/updated
