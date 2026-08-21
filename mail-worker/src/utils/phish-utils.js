/**
 * Inbound phishing heuristics.
 *
 * Motivated by a real campaign against info@yukonasianmarket.ca (2026-07-05,
 * 08-20, 08-21): three "your parcel is held at customs, pay a small fee"
 * messages impersonating Intelcom / Dragonfly Express (a real Canadian courier
 * that really did rebrand, which is what made the lure plausible).
 *
 * What every one of them had in common, and what this module keys on:
 *
 *   - The payment page was hosted on FREE DYNAMIC DNS (duckdns.org, ydns.eu).
 *     No real courier ever puts a payment portal there. This is the single
 *     strongest signal and it generalises far beyond the three known domains.
 *   - No DMARC policy on the From domain (dmarc=none), because the senders were
 *     throwaway lookalikes (dragonflyshipping.org.ca vs the real
 *     dragonflyshipping.ca) or compromised third-party servers — one envelope
 *     sender was literally www-data@u2songs.com, i.e. a hacked PHP site.
 *
 * Design rules:
 *   - NEVER reject. A false positive that bounces a customer's mail is worse
 *     than a phish sitting in Junk. Suspect mail is delivered to Junk instead.
 *   - Require TWO independent signals, not one, so ordinary mail that merely
 *     lacks DMARC is untouched.
 *   - Return the reasons so the decision is auditable in `wrangler tail`.
 */

// Free dynamic-DNS / free-subdomain hosts. A legitimate business payment or
// tracking page is not served from these.
const FREE_DYNDNS_HOSTS = [
	'duckdns.org', 'ydns.eu', 'no-ip.org', 'no-ip.biz', 'no-ip.info',
	'ddns.net', 'hopto.org', 'zapto.org', 'sytes.net', 'serveo.net',
	'ngrok.io', 'ngrok-free.app', 'trycloudflare.com', 'loca.lt',
	'freedns.afraid.org', 'dynu.net', 'myftp.org', 'onthewifi.com',
];

// Courier / customs brands used as lures in this campaign and its cousins.
const COURIER_LURES = [
	'intelcom', 'dragonfly', 'canada post', 'postes canada', 'purolator',
	'ups', 'fedex', 'dhl', 'usps', 'cbsa', 'asfc',
];

// Phrases from the customs-fee script, EN + FR (these arrived bilingual).
const CUSTOMS_LURE_PHRASES = [
	'customs', 'douane', 'dédouanement', 'dedouanement',
	'duties and taxes', 'droits et taxes', 'import fee', 'frais de douane',
	'held pending payment', 'retenu', 'clearance process',
];

function hostOf(url) {
	try {
		return new URL(url).hostname.toLowerCase();
	} catch {
		return '';
	}
}

function extractUrls(text) {
	if (!text) return [];
	return text.match(/https?:\/\/[^\s"'<>)]+/gi) || [];
}

/**
 * @param {object} input
 * @param {string} input.fromAddress   envelope/header From address
 * @param {string} input.subject
 * @param {string} input.html
 * @param {string} input.text
 * @param {string} input.authResults   raw Authentication-Results header
 * @returns {{suspect: boolean, score: number, reasons: string[]}}
 */
export function assessPhishing({ fromAddress = '', subject = '', html = '', text = '', authResults = '' }) {
	const reasons = [];
	let score = 0;

	const body = `${html || ''}\n${text || ''}`;
	const subj = (subject || '').toLowerCase();
	const auth = (authResults || '').toLowerCase();

	// --- Signal 1: link on free dynamic DNS (weight 2 — near-conclusive) ---
	const hosts = extractUrls(body).map(hostOf).filter(Boolean);
	const badHost = hosts.find(h => FREE_DYNDNS_HOSTS.some(d => h === d || h.endsWith('.' + d)));
	if (badHost) {
		score += 2;
		reasons.push(`link on free dynamic DNS: ${badHost}`);
	}

	// --- Signal 2: no DMARC policy on the From domain ---
	// Only meaningful alongside another signal; plenty of small senders lack DMARC.
	if (auth.includes('dmarc=none') || auth.includes('dmarc=fail')) {
		score += 1;
		reasons.push(auth.includes('dmarc=fail') ? 'dmarc=fail' : 'dmarc=none');
	}

	// --- Signal 3: SPF absent or failing ---
	if (auth.includes('spf=none') || auth.includes('spf=fail') || auth.includes('spf=softfail')) {
		score += 1;
		reasons.push('spf none/fail');
	}

	// --- Signal 4: courier brand in the display name or subject, but the From
	// domain has nothing to do with that brand (lookalike / compromised host) ---
	const fromDomain = (fromAddress.split('@')[1] || '').toLowerCase();
	const lure = COURIER_LURES.find(b => subj.includes(b));
	if (lure && fromDomain && !fromDomain.includes(lure.replace(/\s+/g, ''))) {
		score += 1;
		reasons.push(`courier lure "${lure}" from unrelated domain ${fromDomain}`);
	}

	// --- Signal 5: customs-fee script ---
	if (CUSTOMS_LURE_PHRASES.some(p => subj.includes(p) || body.toLowerCase().includes(p))) {
		score += 1;
		reasons.push('customs/duty payment lure');
	}

	// Two independent signals required, and a bare "no DMARC + no SPF" pair is
	// not enough on its own — that describes a lot of legitimate small senders.
	const authOnly = reasons.every(r => r.includes('dmarc') || r.includes('spf'));
	const suspect = score >= 2 && !authOnly;

	return { suspect, score, reasons };
}

export default { assessPhishing };
