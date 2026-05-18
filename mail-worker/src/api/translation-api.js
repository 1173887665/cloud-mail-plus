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
