const fileUtils = {
	getExtFileName(filename) {
		try {
			const index = filename.lastIndexOf('.');
			return index !== -1 ? filename.slice(index) : '';
		} catch (e) {
			return ''
		}
	},

	async getBuffHash(buff) {
		const hashBuffer = await crypto.subtle.digest('SHA-256', buff);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		return hashArray.slice(0, 16).map(b => b.toString(16).padStart(2, '0')).join('');
	},

	base64ToDataStr(base64) {
		return base64.split(',')[1] || base64;
	},

	/**
	 * Build an RFC 6266 Content-Disposition.
	 *
	 * A raw non-ASCII filename in this header makes browsers throw a TypeError
	 * (the Workers runtime warns about it too), so the download silently fails
	 * for anyone whose filename is not plain ASCII. The name goes out twice: an
	 * ASCII-safe `filename=` fallback for old clients, plus the real name in
	 * `filename*=UTF-8''…`.
	 */
	contentDisposition(type, filename) {
		const name = String(filename || 'file');
		const ascii = name.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
		const encoded = encodeURIComponent(name)
			.replace(/['()*]/g, ch => '%' + ch.charCodeAt(0).toString(16).toUpperCase());
		return `${type}; filename="${ascii}"; filename*=UTF-8''${encoded}`;
	},

	/**
	 * Re-encode a Content-Disposition that was stored before the above existed.
	 * Objects already in R2/S3/KV carry the raw header, so serving must repair it
	 * rather than hand the broken value straight to the browser.
	 */
	sanitizeContentDisposition(value) {
		if (!value || !/[^\x00-\x7F]/.test(value)) {
			return value;
		}
		const m = value.match(/^\s*([^;]+?)\s*;\s*filename\*?=\s*"?([^";]+?)"?\s*$/i);
		if (!m) {
			return value.replace(/[^\x00-\x7F]/g, '_');
		}
		return this.contentDisposition(m[1], m[2]);
	},

	base64ToUint8Array(base64) {
		const binaryStr = atob(base64);
		const len = binaryStr.length;
		const bytes = new Uint8Array(len);
		for (let i = 0; i < len; i++) {
			bytes[i] = binaryStr.charCodeAt(i);
		}
		return bytes;
	},

	/**
	 * ArrayBuffer / TypedArray → base64. Chunked because
	 * String.fromCharCode(...bigArray) overflows the call stack on real files.
	 */
	buffToBase64(buff) {
		let bytes;
		if (buff instanceof Uint8Array) {
			bytes = buff;
		} else if (buff instanceof ArrayBuffer) {
			bytes = new Uint8Array(buff);
		} else if (ArrayBuffer.isView(buff)) {
			bytes = new Uint8Array(buff.buffer, buff.byteOffset, buff.byteLength);
		} else {
			throw new Error('buffToBase64: unsupported buffer type');
		}
		let binary = '';
		const CHUNK = 0x8000;
		for (let i = 0; i < bytes.length; i += CHUNK) {
			binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
		}
		return btoa(binary);
	},

	/**
	 * 将 Base64 数据转换为 File 对象（自动识别 MIME 类型和文件扩展名）
	 * @param {string} base64Data 带有 data: 前缀的 base64 数据
	 * @param {string} [customFilename] 可选，传入自定义文件名（不含扩展名）
	 * @returns {File} File 对象
	 */
	base64ToFile(base64Data, customFilename) {
		const match = base64Data.match(/^data:(image|jpeg|video)\/([a-zA-Z0-9.+-]+);base64,/);
		if (!match) {
			throw new Error('Invalid base64 data format');
		}

		const type = match[1]; // image 或 video
		const ext = match[2];  // jpg, png, mp4 等
		const mimeType = `${type}/${ext}`;
		const cleanBase64 = base64Data.replace(/^data:(image|jpeg|video)\/[a-zA-Z0-9.+-]+;base64,/, '');

		const byteCharacters = atob(cleanBase64);
		const byteArrays = [];

		for (let offset = 0; offset < byteCharacters.length; offset += 1024) {
			const slice = byteCharacters.slice(offset, offset + 1024);
			const byteNumbers = new Array(slice.length);
			for (let i = 0; i < slice.length; i++) {
				byteNumbers[i] = slice.charCodeAt(i);
			}
			byteArrays.push(new Uint8Array(byteNumbers));
		}

		const blob = new Blob(byteArrays, { type: mimeType });

		const filename = `${customFilename || `${type}_${Date.now()}`}.${ext}`;
		return new File([blob], filename, { type: mimeType });
	}
};


export default fileUtils;

