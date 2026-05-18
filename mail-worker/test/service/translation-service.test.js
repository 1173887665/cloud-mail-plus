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
