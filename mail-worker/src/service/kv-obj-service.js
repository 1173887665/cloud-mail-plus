import fileUtils from '../utils/file-utils';

const kvObjService = {

	async putObj(c, key, content, metadata) {
		await c.env.kv.put(key, content, { metadata: metadata });
	},

	async deleteObj(c, keys) {

		if (typeof keys === 'string') {
			keys = [keys];
		}

		if (keys.length === 0) {
			return;
		}

		await Promise.all(keys.map( key => c.env.kv.delete(key)));
	},

	async toObjResp(c, key) {

		const obj = await c.env.kv.getWithMetadata(key, { type: "arrayBuffer"});

		// A miss used to fall through as `new Response(null)` — HTTP 200 with an
		// empty body, which every client reads as a zero-byte (truncated) file.
		// Fail loudly instead.
		if (!obj || obj.value === null || obj.value === undefined) {
			console.warn(`[storage] KV miss: ${key}`);
			return new Response('Not Found', { status: 404 });
		}

		// Built conditionally: a null header value would be sent as the literal
		// string "null".
		const headers = new Headers({
			'Content-Type': obj.metadata?.contentType || 'application/octet-stream',
		});
		if (obj.metadata?.contentDisposition) headers.set('Content-Disposition', fileUtils.sanitizeContentDisposition(obj.metadata.contentDisposition));
		if (obj.metadata?.cacheControl) headers.set('Cache-Control', obj.metadata.cacheControl);

		return new Response(obj.value, { headers });

	}

};

export default kvObjService;
