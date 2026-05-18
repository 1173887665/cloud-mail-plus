import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createTestDb } from '../helpers/test-db';

let testDb;

vi.mock('../../src/entity/orm', () => ({
	default: () => testDb.db,
}));

const { default: translationService } = await import('../../src/service/translation-service');
const { emailTranslation } = await import('../../src/entity/email-translation');
const { email } = await import('../../src/entity/email');

function mkCtx(overrides = {}) {
	return { env: { ...overrides } };
}

beforeEach(() => {
	testDb = createTestDb();
});

describe('translationService.translate — cache hit', () => {
	it('returns cached translation without calling AI', async () => {
		testDb.db.insert(email).values({
			emailId: 1001, userId: 42, subject: 'Hello', content: '<p>Hello</p>',
			text: 'Hello', toEmail: 'a@b.c', toName: 'A', accountId: 1,
		}).run();
		testDb.db.insert(emailTranslation).values({
			emailId: 1001, targetLang: 'zh', userId: 42,
			translatedSubject: '你好', translatedContent: '<p>你好</p>',
			sourceLang: 'en', model: 'test-model',
		}).run();

		const ctxWithMockAI = mkCtx({
			AI: { run: () => { throw new Error('AI should not be called on cache hit'); } },
		});

		const result = await translationService.translate(ctxWithMockAI, {
			emailId: 1001, targetLang: 'zh', userId: 42,
		});
		expect(result.fromCache).toBe(true);
		expect(result.translatedSubject).toBe('你好');
		expect(result.translatedContent).toBe('<p>你好</p>');
		expect(result.sourceLang).toBe('en');
	});
});

describe('translationService.translate — cache miss', () => {
	it('calls AI, writes row, returns translation', async () => {
		testDb.db.insert(email).values({
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
		const ctxAI = mkCtx({ AI: mockAI });

		const result = await translationService.translate(ctxAI, {
			emailId: 2001, targetLang: 'zh', userId: 7,
		});
		expect(result.fromCache).toBe(false);
		expect(result.translatedSubject).toBe('季度更新');
		expect(result.translatedContent).toBe('<p>收入增长 12%。员工人数不变。</p>');
		expect(result.sourceLang).toBe('en');

		const row = testDb.db.select().from(emailTranslation).get();
		expect(row.emailId).toBe(2001);
		expect(row.translatedSubject).toBe('季度更新');
	});
});

describe('translationService.translate — same language', () => {
	it('returns alreadyInTargetLang without calling AI when source equals target', async () => {
		testDb.db.insert(email).values({
			emailId: 3001, userId: 9, subject: 'Hi',
			content: 'The quick brown fox jumps over the lazy dog. Long enough to detect English.',
			text: 'The quick brown fox jumps over the lazy dog. Long enough to detect English.',
			toEmail: 'a@b.c', toName: 'A', accountId: 1,
		}).run();

		const ctxAI = mkCtx({
			AI: { run: () => { throw new Error('AI should not be called'); } },
		});

		const result = await translationService.translate(ctxAI, {
			emailId: 3001, targetLang: 'en', userId: 9,
		});
		expect(result.alreadyInTargetLang).toBe(true);
		expect(result.sourceLang).toBe('en');

		const rows = testDb.db.select().from(emailTranslation).all();
		expect(rows.length).toBe(0);
	});
});

describe('translationService.translate — error paths', () => {
	it('throws langNotSupported for unknown targetLang', async () => {
		await expect(
			translationService.translate(mkCtx(), { emailId: 1, targetLang: 'xx', userId: 1 })
		).rejects.toMatchObject({ message: 'langNotSupported', code: 400 });
	});

	it('throws aiNotConfigured when env.AI is missing', async () => {
		testDb.db.insert(email).values({
			emailId: 4001, userId: 1, subject: 'S', content: 'Some German text would go here.',
			text: 'Some German text would go here.', toEmail: 'a@b.c', toName: 'A', accountId: 1,
		}).run();
		await expect(
			translationService.translate(mkCtx(), { emailId: 4001, targetLang: 'zh', userId: 1 })
		).rejects.toMatchObject({ message: 'aiNotConfigured', code: 503 });
	});

	it('throws emailNotFound for missing emailId', async () => {
		const ctxAI = mkCtx({ AI: { run: () => ({ response: '{}' }) } });
		await expect(
			translationService.translate(ctxAI, { emailId: 99999, targetLang: 'zh', userId: 1 })
		).rejects.toMatchObject({ message: 'emailNotFound', code: 404 });
	});

	it('throws emailNotFound when emailId belongs to a different user', async () => {
		testDb.db.insert(email).values({
			emailId: 5001, userId: 100, subject: 'X', content: 'foo', text: 'foo',
			toEmail: 'a@b.c', toName: 'A', accountId: 1,
		}).run();
		const ctxAI = mkCtx({ AI: { run: () => ({ response: '{}' }) } });
		await expect(
			translationService.translate(ctxAI, { emailId: 5001, targetLang: 'zh', userId: 200 })
		).rejects.toMatchObject({ message: 'emailNotFound', code: 404 });
	});

	it('throws aiBadOutput after retrying once with bad model output', async () => {
		testDb.db.insert(email).values({
			emailId: 6001, userId: 1, subject: 'Q',
			content: 'A German text Das ist ein Test mit genug Inhalt für die Erkennung.',
			text: 'A German text Das ist ein Test mit genug Inhalt für die Erkennung.',
			toEmail: 'a@b.c', toName: 'A', accountId: 1,
		}).run();

		let calls = 0;
		const ctxAI = mkCtx({
			AI: { run: () => { calls++; return { response: 'totally not json' }; } },
		});
		await expect(
			translationService.translate(ctxAI, { emailId: 6001, targetLang: 'zh', userId: 1 })
		).rejects.toMatchObject({ message: 'aiBadOutput', code: 502 });
		expect(calls).toBe(2);
	});
});

describe('translationService.translate — truncation', () => {
	it('truncates input and sets truncated=true when over MAX_INPUT_CHARS', async () => {
		const longText = 'Das ist ein deutscher Text. '.repeat(2000);
		testDb.db.insert(email).values({
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
		const ctxAI = mkCtx({ AI: mockAI });

		const result = await translationService.translate(ctxAI, {
			emailId: 7001, targetLang: 'zh', userId: 1,
		});
		expect(result.truncated).toBe(true);
		expect(receivedBody.length).toBeLessThan(longText.length);
		expect(receivedBody).toContain('[...truncated]');
	});
});
