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

describe('translationService.translate — cache hit', () => {
	beforeEach(() => {
		testDb = createTestDb();
	});

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
