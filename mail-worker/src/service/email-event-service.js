import { emailConst } from '../const/entity-const';
import email from '../entity/email';
import orm from '../entity/orm';
import { and, eq, sql } from 'drizzle-orm';

/**
 * Cloudflare Email Service — outbound delivery event consumer.
 *
 * CF publishes six lifecycle events per outbound message onto a Queue via an
 * event subscription (source `email.sending`, one subscription per sending
 * domain). This service joins each event back to its `email` row so that
 * `GET /external/status/:emailId` reports the REAL delivery outcome instead of
 * the send-time optimistic "delivered".
 *
 * Why we join on Message-ID and not on anything we generate ourselves:
 *   CF REWRITES the Message-ID header. The value built by
 *   cf-email-service.js `_generateMessageId()` never reaches the recipient —
 *   verified 2026-07-28 by a round-trip probe (we sent `<uuid@example.com>`,
 *   the recipient received and the event reported
 *   `<aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789@example.com>`).
 *   The only durable join key is `EmailSendResult.messageId` returned by
 *   `env.EMAIL.send()`, which IS the delivered Message-ID.
 *
 * Bracket discipline: the event payload carries `<id@domain>` while
 * `/external/email/list-message-ids` returns it bare. Never compare raw —
 * always go through `normalizeMessageId`, which strips the brackets and
 * PRESERVES case (RFC 5322 msg-id is case-sensitive, and this value is the
 * real header on the wire — lowercasing it would corrupt the stored column).
 * Case-insensitive matching is handled at query time by `findSendRow`.
 */

const EVENT_PREFIX = 'cf.email.sending.';

const STATUS_BY_EVENT = {
	'message.delivered': emailConst.status.DELIVERED,
	'message.deferred': emailConst.status.DELAYED,
	'message.bounced': emailConst.status.BOUNCED,
	'message.complained': emailConst.status.COMPLAINED,
	'message.failed': emailConst.status.FAILED,
	'message.rejected': emailConst.status.FAILED,
};

/**
 * Queues give no ordering guarantee, so a late `delivered` must never clear an
 * already-recorded `bounced`. We only ever move a row UP this ladder.
 * `complained` outranks `delivered` because it legitimately arrives after it
 * (the recipient got the mail, then pressed "spam").
 */
const RANK = {
	[emailConst.status.SENT]: 1,
	[emailConst.status.DELAYED]: 2,
	[emailConst.status.DELIVERED]: 3,
	[emailConst.status.FAILED]: 4,
	[emailConst.status.BOUNCED]: 5,
	[emailConst.status.COMPLAINED]: 6,
};

export function normalizeMessageId(raw) {
	return String(raw || '').trim().replace(/^<|>$/g, '');
}

/**
 * Locate the outbound row an event belongs to.
 *
 * Exact match first so the query can use the index on `message_id`. The
 * case-insensitive pass exists only as a safety net: rows written before case
 * was preserved are lowercased, and `lower()` defeats the index — so it must
 * never be the primary path. A warn on the fallback makes any real casing
 * mismatch from Cloudflare visible rather than silently absorbed.
 */
async function findSendRow(c, messageId) {
	const exact = await orm(c).select().from(email).where(and(
		eq(email.messageId, messageId),
		eq(email.type, emailConst.type.SEND),
	)).get();
	if (exact) return exact;

	const loose = await orm(c).select().from(email).where(and(
		sql`lower(${email.messageId}) = ${messageId.toLowerCase()}`,
		eq(email.type, emailConst.type.SEND),
	)).get();
	if (loose) {
		console.warn(`[email-event] matched case-insensitively only: ${messageId}`);
	}
	return loose;
}

function shortEventName(type) {
	const t = String(type || '');
	return t.startsWith(EVENT_PREFIX) ? t.slice(EVENT_PREFIX.length) : t;
}

/**
 * Compact, queryable summary persisted into `email.message`. Mirrors the shape
 * resend-service already stores there so downstream readers stay uniform.
 */
function buildMessage(evtName, payload) {
	const delivery = payload.delivery || {};
	const bounce = payload.bounce || {};
	return JSON.stringify({
		event: evtName,
		terminal: payload.terminal === true,
		recipient: payload.recipient || null,
		provider: delivery.provider || null,
		smtpStatusCode: delivery.smtpStatusCode || null,
		smtpEnhancedStatusCode: delivery.smtpEnhancedStatusCode || null,
		bounceType: bounce.type || null,
		classification: bounce.classification || null,
		reason: bounce.reason || delivery.smtpResponse || null,
	});
}

const emailEventService = {

	/**
	 * Apply one CF event. Returns a short outcome string for logging.
	 * Never throws on "we don't care about this event" — only on real
	 * infrastructure failure, so the caller can retry the queue message.
	 */
	async applyEvent(env, body) {
		if (!body || typeof body !== 'object') {
			return 'skip:not-an-object';
		}

		const evtName = shortEventName(body.type);
		const status = STATUS_BY_EVENT[evtName];
		if (status === undefined) {
			return `skip:unknown-event(${evtName})`;
		}

		const payload = body.payload || {};
		const messageId = normalizeMessageId(payload.messageId);
		if (!messageId) {
			return `skip:no-message-id(${evtName})`;
		}

		const c = { env };

		// Scope to SEND rows: a round-trip (our domain → our domain) stores the
		// SAME Message-ID on both the outbound row and the inbound row, and the
		// inbound row's status must not be touched by a sending event.
		const row = await findSendRow(c, messageId);

		if (!row) {
			// Expected for: mail sent before messageId persistence shipped, sends
			// from Outlook via the SMTP relay, and recipients 2..N of a multi-
			// recipient send. Not an error — but worth seeing in the logs.
			return `unmatched:${evtName}:${messageId}`;
		}

		const currentRank = RANK[row.status] || 0;
		const nextRank = RANK[status] || 0;
		if (nextRank < currentRank) {
			return `ignored:${evtName}:would-downgrade-from-${row.status}`;
		}

		await orm(c).update(email).set({
			status,
			message: buildMessage(evtName, payload),
		}).where(eq(email.emailId, row.emailId)).run();

		return `applied:${evtName}:emailId=${row.emailId}`;
	},

	/**
	 * Queue consumer entrypoint. Acks anything we processed or deliberately
	 * skipped; retries only genuine failures so a transient D1 error does not
	 * silently drop a bounce.
	 */
	async consumeBatch(batch, env) {
		for (const msg of batch.messages) {
			try {
				const body = typeof msg.body === 'string' ? JSON.parse(msg.body) : msg.body;
				const outcome = await this.applyEvent(env, body);
				console.log(`[email-event] ${outcome}`);
				msg.ack();
			} catch (e) {
				console.error(`[email-event] FAILED, will retry: ${e.message || e}`);
				msg.retry();
			}
		}
	},
};

export default emailEventService;
