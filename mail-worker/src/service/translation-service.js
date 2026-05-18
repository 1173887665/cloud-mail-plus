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

		throw new BizError('notImplemented', 500);
	},
};

export default translationService;
