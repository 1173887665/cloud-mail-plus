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

		if (!c.env.AI) throw new BizError('aiNotConfigured', 503);

		const e = await orm(c).select().from(email)
			.where(and(eq(email.emailId, emailId), eq(email.userId, userId)))
			.get();
		if (!e) throw new BizError('emailNotFound', 404);

		const detected = detectLang((e.content || e.text || '').slice(0, 500));
		if (detected !== 'und' && detected === targetLang) {
			return { alreadyInTargetLang: true, sourceLang: detected };
		}

		let plainText = htmlToPlainText(e.content || e.text || '');
		let truncated = false;
		if (plainText.length > MAX_INPUT_CHARS) {
			plainText = plainText.slice(0, MAX_INPUT_CHARS) + '\n\n[...truncated]';
			truncated = true;
		}

		const aiResult = await callTranslationModel(c.env.AI, {
			subject: e.subject || '',
			content: plainText,
			targetLang,
		});

		const translatedContentHtml = paragraphsToHtml(aiResult.body);

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
