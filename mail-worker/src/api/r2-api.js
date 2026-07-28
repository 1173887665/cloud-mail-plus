import r2Service from '../service/r2-service';
import fileUtils from '../utils/file-utils';
import app from '../hono/hono';

app.get('/oss/*', async (c) => {
	const key = c.req.path.split('/oss/')[1];
	const obj = await r2Service.getObj(c, key);
	if (!obj) {
		return new Response('Not Found', { status: 404 });
	}
	// Built conditionally: a null header value would be sent as the literal
	// string "null". The stored disposition may predate RFC 6266 encoding.
	const headers = new Headers({
		'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
	});
	if (obj.httpMetadata?.contentDisposition) {
		headers.set('Content-Disposition', fileUtils.sanitizeContentDisposition(obj.httpMetadata.contentDisposition));
	}
	return new Response(obj.body, { headers });
});


