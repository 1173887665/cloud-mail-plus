/**
 * Cloudflare Email Service wrapper — raw-MIME path.
 *
 * Uses `new EmailMessage(from, envelopeTo, rawMime)` so we build the MIME body
 * ourselves and control encoding end-to-end.
 *
 * Why not the structured builder form (`env.EMAIL.send({...attachments:[...]})`):
 *   When `attachment.content` is a string, CF embeds it as TEXT body
 *   (quoted-printable) rather than treating it as base64 to decode and re-encode
 *   as a base64 binary segment. Recipients receive the base64 string AS the
 *   "file content" and downloads cannot be opened. Verified empirically
 *   2026-06-16 — the bug that prompted this rewrite.
 *
 * Docs:
 *   - https://developers.cloudflare.com/email-routing/email-workers/send-email/
 *   - https://developers.cloudflare.com/email-service/api/send-emails/workers-api/
 *
 * Caller contract (unchanged): cfEmailService.send(env, form) where form is
 *   { from, to, subject, html?, text?, attachments?, cc?, bcc?, replyTo?, headers? }
 *   `to`/`cc`/`bcc` accept string or string[].
 *   `attachments[i].content` MUST be a base64-encoded string (binary safe);
 *   Uint8Array/ArrayBuffer also accepted as a fallback.
 */

import { EmailMessage } from 'cloudflare:email';

const cfEmailService = {

	async send(env, form) {

		if (!env.EMAIL) {
			const err = new Error('EMAIL binding not configured in wrangler.toml');
			err.code = 'E_NO_BINDING';
			throw err;
		}

		const toList = _arrayify(form.to);
		const ccList = _arrayify(form.cc);
		const bccList = _arrayify(form.bcc);

		const envelopeRecipients = [...toList, ...ccList, ...bccList]
			.map(_extractEmail)
			.filter(Boolean);

		if (envelopeRecipients.length === 0) {
			const err = new Error('No recipients specified');
			err.code = 'E_NO_RECIPIENTS';
			throw err;
		}
		if (envelopeRecipients.length > 50) {
			const err = new Error(
				`CF Email: ${envelopeRecipients.length} recipients exceeds the 50-recipient limit`
			);
			err.code = 'E_TOO_MANY_RECIPIENTS';
			throw err;
		}

		const fromEmail = _extractEmail(form.from);
		if (!fromEmail) {
			const err = new Error('Invalid from address');
			err.code = 'E_INVALID_FROM';
			throw err;
		}

		const rawMime = _buildRawMime(form, fromEmail);

		const results = [];
		let lastErr = null;
		for (const rcpt of envelopeRecipients) {
			try {
				const msg = new EmailMessage(fromEmail, rcpt, rawMime);
				const r = await env.EMAIL.send(msg);
				results.push({ rcpt, ok: true, messageId: r?.messageId || null });
			} catch (e) {
				console.error(`[CF Email] send to ${rcpt} failed:`, e.code || '', e.message || e);
				results.push({ rcpt, ok: false, error: e.message || String(e) });
				lastErr = e;
			}
		}

		const okCount = results.filter(r => r.ok).length;
		if (okCount === 0) {
			throw lastErr || new Error('All recipients failed');
		}

		console.log(`[CF Email] sent to ${okCount}/${results.length} recipients`);

		// Sync to Stalwart "Sent Items" so Web UI / API / Agent sends are also
		// visible alongside Outlook's IMAP-APPEND'd copies. Non-fatal: the email
		// is already delivered to the recipient — Sent sync is a convenience.
		// Skipped when the caller (e.g. Mail Bridge SMTP relay) tells us the
		// originating client already APPEND'd a copy.
		if (env.MAIL_BRIDGE_URL && env.MAIL_BRIDGE_KEY && !form.skipSentSync) {
			try {
				await _syncToStalwartSent(env, fromEmail, rawMime);
			} catch (e) {
				console.warn(`[CF Email] Stalwart Sent sync failed (non-fatal): ${e.message}`);
			}
		}

		return { success: true, results };
	}
};

async function _syncToStalwartSent(env, fromEmail, rawMime) {
	const url = `${env.MAIL_BRIDGE_URL.replace(/\/$/, '')}/api/sent-append`;
	const resp = await fetch(url, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			'X-API-Key': env.MAIL_BRIDGE_KEY,
		},
		body: JSON.stringify({ from: fromEmail, rawMime }),
	});
	if (!resp.ok) {
		const txt = await resp.text().catch(() => '');
		throw new Error(`bridge ${resp.status}: ${txt.slice(0, 200)}`);
	}
}

// ============================================================================
// Raw MIME builder
// ============================================================================

function _buildRawMime(form, fromEmail) {

	const fromHeader = _formatAddress(form.from);
	const toList = _arrayify(form.to).map(_formatAddress);
	const ccList = _arrayify(form.cc).map(_formatAddress);

	const html = form.html || '';
	const text = form.text || '';
	const attachments = Array.isArray(form.attachments)
		? form.attachments.filter(a => a && a.content && a.filename)
		: [];

	const hasHtml = !!html;
	const hasText = !!text;
	const hasAttachments = attachments.length > 0;

	const lines = [];

	// ---- Top-level headers ----
	lines.push(`From: ${fromHeader}`);
	if (toList.length) lines.push(`To: ${toList.join(', ')}`);
	if (ccList.length) lines.push(`Cc: ${ccList.join(', ')}`);
	// Bcc must NOT appear in the rendered MIME headers.
	lines.push(`Subject: ${_encodeHeaderWord(form.subject || '')}`);
	lines.push(`Date: ${new Date().toUTCString()}`);
	lines.push(`Message-ID: ${_generateMessageId(fromEmail)}`);
	lines.push('MIME-Version: 1.0');

	if (form.replyTo) {
		lines.push(`Reply-To: ${_formatAddress(form.replyTo)}`);
	}

	// Custom headers (In-Reply-To, References, X-*) — reject anything we own
	if (form.headers && typeof form.headers === 'object') {
		const reserved = new Set([
			'from', 'to', 'cc', 'bcc', 'subject', 'date',
			'message-id', 'mime-version', 'reply-to',
			'content-type', 'content-transfer-encoding', 'content-disposition',
		]);
		for (const [k, v] of Object.entries(form.headers)) {
			if (v == null) continue;
			if (reserved.has(k.toLowerCase())) continue;
			lines.push(`${k}: ${v}`);
		}
	}

	// ---- Body ----
	if (!hasAttachments) {
		_appendBody(lines, hasHtml, hasText, html, text, /*nestedUnderMixed*/ false, null);
	} else {
		const mix = _randomBoundary('mix');
		lines.push(`Content-Type: multipart/mixed; boundary="${mix}"`);
		lines.push('');
		_appendBody(lines, hasHtml, hasText, html, text, /*nestedUnderMixed*/ true, mix);
		for (const att of attachments) {
			_appendAttachment(lines, att, mix);
		}
		lines.push(`--${mix}--`);
	}

	return lines.join('\r\n');
}

function _appendBody(lines, hasHtml, hasText, html, text, nested, mixBoundary) {

	if (!hasHtml && !hasText) {
		// CF requires a body. Emit a minimal text/plain placeholder.
		if (nested) {
			lines.push(`--${mixBoundary}`);
			lines.push('Content-Type: text/plain; charset=utf-8');
			lines.push('Content-Transfer-Encoding: 7bit');
			lines.push('');
			lines.push('');
		} else {
			lines.push('Content-Type: text/plain; charset=utf-8');
			lines.push('Content-Transfer-Encoding: 7bit');
			lines.push('');
			lines.push('');
		}
		return;
	}

	if (hasHtml && hasText) {
		const alt = _randomBoundary('alt');
		if (nested) {
			lines.push(`--${mixBoundary}`);
			lines.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
			lines.push('');
		} else {
			lines.push(`Content-Type: multipart/alternative; boundary="${alt}"`);
			lines.push('');
		}
		lines.push(`--${alt}`);
		lines.push('Content-Type: text/plain; charset=utf-8');
		lines.push('Content-Transfer-Encoding: base64');
		lines.push('');
		lines.push(_splitBase64(_utf8ToBase64(text)));
		lines.push(`--${alt}`);
		lines.push('Content-Type: text/html; charset=utf-8');
		lines.push('Content-Transfer-Encoding: base64');
		lines.push('');
		lines.push(_splitBase64(_utf8ToBase64(html)));
		lines.push(`--${alt}--`);
		return;
	}

	const ct = hasHtml ? 'text/html' : 'text/plain';
	const body = hasHtml ? html : text;
	if (nested) {
		lines.push(`--${mixBoundary}`);
		lines.push(`Content-Type: ${ct}; charset=utf-8`);
		lines.push('Content-Transfer-Encoding: base64');
		lines.push('');
		lines.push(_splitBase64(_utf8ToBase64(body)));
	} else {
		lines.push(`Content-Type: ${ct}; charset=utf-8`);
		lines.push('Content-Transfer-Encoding: base64');
		lines.push('');
		lines.push(_splitBase64(_utf8ToBase64(body)));
	}
}

function _appendAttachment(lines, att, mixBoundary) {

	const type = att.contentType || att.mimeType || att.mime_type || att.type || 'application/octet-stream';
	const filename = att.filename || 'attachment';
	const encodedName = _encodeFilenameParam(filename);
	const isInline = att.contentId || att.disposition === 'inline';

	lines.push(`--${mixBoundary}`);
	lines.push(`Content-Type: ${type}; name="${encodedName}"`);
	if (isInline) {
		lines.push(`Content-Disposition: inline; filename="${encodedName}"`);
	} else {
		lines.push(`Content-Disposition: attachment; filename="${encodedName}"`);
	}
	lines.push('Content-Transfer-Encoding: base64');
	if (att.contentId) {
		const cid = String(att.contentId).replace(/^<|>$/g, '');
		lines.push(`Content-ID: <${cid}>`);
	}
	lines.push('');
	lines.push(_splitBase64(_attachmentContentToBase64(att.content)));
}

// ============================================================================
// Encoding helpers
// ============================================================================

function _arrayify(v) {
	if (v == null) return [];
	return Array.isArray(v) ? v : [v];
}

function _extractEmail(addr) {
	if (!addr) return null;
	if (typeof addr === 'object' && addr.email) return String(addr.email).trim();
	const s = String(addr).trim();
	const m = s.match(/<([^>]+)>/);
	return m ? m[1].trim() : s;
}

function _formatAddress(addr) {
	if (!addr) return '';
	if (typeof addr === 'object' && addr.email) {
		const email = String(addr.email).trim();
		return addr.name ? `${_encodeHeaderWord(String(addr.name))} <${email}>` : email;
	}
	const s = String(addr).trim();
	const m = s.match(/^(.+?)\s*<(.+?)>\s*$/);
	if (m) return `${_encodeHeaderWord(m[1].trim())} <${m[2].trim()}>`;
	return s;
}

function _encodeHeaderWord(text) {
	if (!text) return '';
	if (/^[\x20-\x7E]*$/.test(text)) return text;
	return `=?UTF-8?B?${_utf8ToBase64(text)}?=`;
}

function _encodeFilenameParam(filename) {
	if (!filename) return 'attachment';
	if (/^[\x20-\x7E]*$/.test(filename)) return filename;
	return `=?UTF-8?B?${_utf8ToBase64(filename)}?=`;
}

function _utf8ToBase64(text) {
	if (!text) return '';
	return btoa(unescape(encodeURIComponent(text)));
}

function _splitBase64(b64) {
	if (!b64) return '';
	const out = [];
	for (let i = 0; i < b64.length; i += 76) out.push(b64.slice(i, i + 76));
	return out.join('\r\n');
}

function _attachmentContentToBase64(content) {
	// String → assumed to be base64 already (per caller contract).
	if (typeof content === 'string') {
		return content.replace(/\s+/g, '');
	}
	// Binary → encode to base64.
	let bytes;
	if (content instanceof Uint8Array) {
		bytes = content;
	} else if (content instanceof ArrayBuffer) {
		bytes = new Uint8Array(content);
	} else if (ArrayBuffer.isView(content)) {
		bytes = new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
	} else {
		throw new Error('Unsupported attachment content type');
	}
	// btoa requires a latin1 string; chunked conversion avoids the call-stack blowup
	// from String.fromCharCode(...largeArray).
	let binary = '';
	const CHUNK = 0x8000;
	for (let i = 0; i < bytes.length; i += CHUNK) {
		binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
	}
	return btoa(binary);
}

function _randomBoundary(prefix) {
	const rand = crypto.randomUUID().replace(/-/g, '');
	return `_CM_${prefix}_${rand}`;
}

function _generateMessageId(fromEmail) {
	const domain = (fromEmail.split('@')[1] || 'localhost').trim();
	const rand = crypto.randomUUID();
	return `<${rand}@${domain}>`;
}

export default cfEmailService;
