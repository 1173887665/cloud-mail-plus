import s3Service from './s3-service';
import settingService from './setting-service';
import kvObjService from './kv-obj-service';
import fileUtils from '../utils/file-utils';

const r2Service = {

	async storageType(c) {

		const setting = await settingService.query(c);
		const { bucket, endpoint, s3AccessKey, s3SecretKey } = setting;

		if (!!(bucket && endpoint && s3AccessKey && s3SecretKey)) {
			return 'S3';
		}

		if (c.env.r2) {
			return 'R2';
		}

		return 'KV';
	},

	async putObj(c, key, content, metadata) {

		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			await kvObjService.putObj(c, key, content, metadata);
		}

		if (storageType === 'R2') {
			await c.env.r2.put(key, content, {
				httpMetadata: { ...metadata }
			});
		}

		if (storageType === 'S3') {
			await s3Service.putObj(c, key, content, metadata);
		}

	},

	async getObj(c, key) {
		return await c.env.r2.get(key);
	},

	/**
	 * Serve a stored object over HTTP.
	 *
	 * MUST dispatch the same way putObj does. This used to be hardcoded to KV in
	 * index.js, so every deployment with an R2 binding wrote objects to R2 and
	 * read them back from KV — always a miss, which kvObjService turned into a
	 * 200 with an empty body. Downloads arrived 0 bytes (indistinguishable from
	 * a truncated file) and inline images rendered as broken links, with nothing
	 * in the logs to explain it.
	 */
	async toObjResp(c, key) {

		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			return await kvObjService.toObjResp(c, key);
		}

		if (storageType === 'R2') {
			const obj = await c.env.r2.get(key);
			if (!obj) {
				console.warn(`[storage] R2 miss: ${key}`);
				return new Response('Not Found', { status: 404 });
			}
			const headers = new Headers();
			obj.writeHttpMetadata(headers);
			const cd = headers.get('content-disposition');
			if (cd) headers.set('Content-Disposition', fileUtils.sanitizeContentDisposition(cd));
			headers.set('etag', obj.httpEtag);
			return new Response(obj.body, { headers });
		}

		if (storageType === 'S3') {
			try {
				const obj = await s3Service.getObj(c, key);
				if (!obj?.Body) {
					console.warn(`[storage] S3 miss: ${key}`);
					return new Response('Not Found', { status: 404 });
				}
				const headers = new Headers();
				if (obj.ContentType) headers.set('Content-Type', obj.ContentType);
				if (obj.ContentDisposition) headers.set('Content-Disposition', obj.ContentDisposition);
				if (obj.CacheControl) headers.set('Cache-Control', obj.CacheControl);
				if (obj.ETag) headers.set('ETag', obj.ETag);
				return new Response(obj.Body, { headers });
			} catch (e) {
				console.warn(`[storage] S3 read failed for ${key}: ${e.message}`);
				return new Response('Not Found', { status: 404 });
			}
		}

		return new Response('Not Found', { status: 404 });
	},

	async delete(c, key) {

		const storageType = await this.storageType(c);

		if (storageType === 'KV') {
			await kvObjService.deleteObj(c, key);
		}

		if (storageType === 'R2') {
			await c.env.r2.delete(key);
		}

		if (storageType === 'S3'){
			await s3Service.deleteObj(c, key);
		}

	}

};
export default r2Service;
