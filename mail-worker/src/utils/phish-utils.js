/**
 * Inbound phishing heuristics.
 *
 * Built from real mail that reached info@yukonasianmarket.ca, in two waves:
 *
 *   1. Customs-fee scams (2026-07-05, 08-20, 08-21) impersonating Intelcom /
 *      Dragonfly Express — a real Canadian courier that really did rebrand,
 *      which is what made the lure plausible. Payment pages were on free
 *      dynamic DNS (duckdns.org, ydns.eu); senders were lookalike domains or
 *      compromised hosts (one envelope sender was www-data@u2songs.com, i.e.
 *      a hacked PHP site).
 *
 *   2. A credential harvest (2026-08-21) claiming "email sending suspended,
 *      re-activate your account". This one passed SPF, DKIM **and DMARC** —
 *      it was relayed through a compromised Google Workspace tenant
 *      (smtp-relay.gmail.com), so authentication proves nothing about intent.
 *      What gave it away instead:
 *        - display name "Postmaster yukonasianmarket.ca" while the From domain
 *          was plugandplay.co.id — impersonating the RECIPIENT'S own domain
 *        - the landing URL carried the victim's address in the fragment
 *          (…/v8345.html#info@yukonasianmarket.ca) so the fake login form
 *          could pre-fill it and only ask for the password
 *
 * Design rules learned from those two waves:
 *   - NEVER reject. A false positive that bounces a customer's mail is worse
 *     than a phish sitting in Junk. Suspect mail is diverted to Junk.
 *   - Authentication results are weak evidence in BOTH directions. dmarc=pass
 *     via a compromised tenant is common; dmarc=none is common among small
 *     legitimate senders. So auth signals alone can never trigger a verdict.
 *   - Require a STRONG signal plus corroboration, or two independent
 *     content signals. A scary-sounding subject on its own is not enough —
 *     real providers do send "unusual activity" mail.
 *   - Return the reasons so every decision is auditable in `wrangler tail`.
 */

// Free dynamic-DNS / free-subdomain hosts. A legitimate business does not put
// a payment or login page here.
const FREE_DYNDNS_HOSTS = [
	'duckdns.org', 'ydns.eu', 'no-ip.org', 'no-ip.biz', 'no-ip.info',
	'ddns.net', 'hopto.org', 'zapto.org', 'sytes.net', 'serveo.net',
	'ngrok.io', 'ngrok-free.app', 'trycloudflare.com', 'loca.lt',
	'freedns.afraid.org', 'dynu.net', 'myftp.org', 'onthewifi.com',
];

// Free app-hosting platforms. Unlike the list above these have heavy
// legitimate use, so this is only ever corroborating evidence — never enough
// on its own. Phishing kits like them because deployment is instant and free.
const FREE_APP_HOSTS = [
	'laravel.cloud', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev',
	'web.app', 'firebaseapp.com', 'glitch.me', 'repl.co', 'replit.app',
	'onrender.com', 'fly.dev', 'surge.sh', 'r2.dev', 'blob.core.windows.net',
];

// Brands impersonated in the display name. Kept deliberately short — every
// entry is a brand whose mail we would otherwise never see from an unrelated
// domain. Matched with word boundaries so "ups" does not hit "groups".
const IMPERSONATED_BRANDS = [
	'intelcom', 'dragonfly', 'canada post', 'postes canada', 'purolator',
	'ups', 'fedex', 'dhl', 'usps',
	'microsoft', 'office 365', 'office365', 'outlook', 'onedrive',
	'paypal', 'interac', 'netflix', 'amazon', 'apple',
	'postmaster', 'mail delivery subsystem', 'it support', 'helpdesk',
];

const COURIER_LURES = [
	'intelcom', 'dragonfly', 'canada post', 'postes canada', 'purolator',
	'ups', 'fedex', 'dhl', 'usps', 'cbsa', 'asfc',
];

const CUSTOMS_LURE_PHRASES = [
	'customs', 'douane', 'dédouanement', 'dedouanement',
	'duties and taxes', 'droits et taxes', 'import fee', 'frais de douane',
	'held pending payment', 'clearance process',
];

// Account-suspension / re-activation scripts used to harvest credentials.
const CREDENTIAL_LURE_PHRASES = [
	'suspicious activity', 'unusual activity', 'temporarily suspended',
	'sending has been suspended', 'reactivate your account', 're-activate your account',
	'verify your account', 'confirm your password', 'validate your mailbox',
	'account will be closed', 'account will be deleted', 'storage is full',
	'revalidate', 'session expired', 'password expires', 'quota exceeded',
];

function hostOf(url) {
	try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
}

function matchesHost(host, list) {
	return list.some(d => host === d || host.endsWith('.' + d));
}

function extractUrls(text) {
	if (!text) return [];
	return text.match(/https?:\/\/[^\s"'<>)]+/gi) || [];
}

/**
 * Auth verdicts come as e.g. "dmarc=pass header.from=x policy.dmarc=none".
 * Matching a bare "dmarc=none" substring also hits "policy.dmarc=none", which
 * is the DOMAIN'S published policy, not the evaluation result — a message can
 * be dmarc=pass with policy.dmarc=none. Anchor on the standalone token.
 */
function authFailed(auth, method) {
	const re = new RegExp(`(^|[^.\\w])${method}=(none|fail|softfail)\\b`);
	return re.test(auth);
}

/**
 * @param {object} input
 * @param {string} input.fromAddress    From address
 * @param {string} input.fromName       From display name
 * @param {string} input.recipient      the mailbox this was delivered to
 * @param {string} input.subject
 * @param {string} input.html
 * @param {string} input.text
 * @param {string} input.authResults    raw Authentication-Results header
 * @returns {{suspect: boolean, score: number, reasons: string[]}}
 */
export function assessPhishing({
	fromAddress = '', fromName = '', recipient = '',
	subject = '', html = '', text = '', authResults = '',
}) {
	const reasons = [];
	let strong = 0;   // near-conclusive on their own, but still need corroboration
	let weak = 0;     // content signals
	let authWeak = 0; // SPF/DMARC — never sufficient, in either direction

	const body = `${html || ''}\n${text || ''}`;
	const bodyLower = body.toLowerCase();
	const subj = (subject || '').toLowerCase();
	const auth = (authResults || '').toLowerCase();
	const fromDomain = (fromAddress.split('@')[1] || '').toLowerCase();
	const recipientDomain = (recipient.split('@')[1] || '').toLowerCase();

	const urls = extractUrls(body);
	const hosts = urls.map(hostOf).filter(Boolean);

	// --- STRONG: payment/login page on free dynamic DNS ---
	const dynHost = hosts.find(h => matchesHost(h, FREE_DYNDNS_HOSTS));
	if (dynHost) {
		strong++;
		reasons.push(`link on free dynamic DNS: ${dynHost}`);
	}

	// --- STRONG: display name impersonates the RECIPIENT'S own domain while
	// the sending domain is unrelated ("Postmaster yukonasianmarket.ca"
	// <alarts@plugandplay.co.id>). Legitimate mail never looks like this. ---
	if (recipientDomain && fromDomain && fromDomain !== recipientDomain
		&& (fromName || '').toLowerCase().includes(recipientDomain)) {
		strong++;
		reasons.push(`display name impersonates recipient domain "${recipientDomain}" but sent from ${fromDomain}`);
	}

	// --- STRONG: landing URL carries the recipient's address, so the fake
	// login form can pre-fill it and only ask for a password.
	// Only counts when that URL is ALSO on throwaway hosting: Google, Microsoft
	// and other real providers legitimately put the account address in their
	// links, and treating that alone as strong flagged six genuine Google
	// security alerts in testing. ---
	if (recipient) {
		const rl = recipient.toLowerCase();
		const bad = urls.find(u => {
			if (!u.toLowerCase().includes(rl)) return false;
			const h = hostOf(u);
			return matchesHost(h, FREE_DYNDNS_HOSTS) || matchesHost(h, FREE_APP_HOSTS);
		});
		if (bad) {
			strong++;
			reasons.push('link on throwaway hosting embeds the recipient address (credential-form pre-fill)');
		}
	}

	// --- STRONG: display name claims a brand the From domain has nothing to
	// do with ("dhl fasttrack" <info@funakoshi.co.jp> — a compromised Japanese
	// company account). Word-anchored: "ups" must not match "groups". Real
	// brand mail has the brand in the domain too, so this stays quiet. ---
	const nameLower = (fromName || '').toLowerCase();
	const brandInName = IMPERSONATED_BRANDS.find(
		b => new RegExp(`(^|[^a-z0-9])${b.replace(/\s+/g, '\\s+')}([^a-z0-9]|$)`).test(nameLower)
	);
	if (brandInName && fromDomain && !fromDomain.includes(brandInName.replace(/\s+/g, ''))) {
		strong++;
		reasons.push(`display name claims "${brandInName}" but sent from ${fromDomain}`);
	}

	// --- WEAK: page on a free app-hosting platform ---
	const appHost = hosts.find(h => matchesHost(h, FREE_APP_HOSTS));
	if (appHost) {
		weak++;
		reasons.push(`link on free app hosting: ${appHost}`);
	}

	// --- WEAK: account-suspension / credential-harvest script ---
	if (CREDENTIAL_LURE_PHRASES.some(p => subj.includes(p) || bodyLower.includes(p))) {
		weak++;
		reasons.push('account suspension / credential lure');
	}

	// --- WEAK: courier brand in the subject, From domain unrelated to it ---
	const lure = COURIER_LURES.find(b => subj.includes(b));
	if (lure && fromDomain && !fromDomain.includes(lure.replace(/\s+/g, ''))) {
		weak++;
		reasons.push(`courier lure "${lure}" from unrelated domain ${fromDomain}`);
	}

	// --- WEAK: customs-fee script ---
	if (CUSTOMS_LURE_PHRASES.some(p => subj.includes(p) || bodyLower.includes(p))) {
		weak++;
		reasons.push('customs/duty payment lure');
	}

	// --- AUTH: corroboration only ---
	if (authFailed(auth, 'dmarc')) { authWeak++; reasons.push('dmarc none/fail'); }
	if (authFailed(auth, 'spf')) { authWeak++; reasons.push('spf none/fail'); }

	// A strong signal needs one corroborating signal of any kind; failing that,
	// two independent CONTENT signals will do. Auth alone can never convict —
	// the 2026-08-21 credential harvest passed DMARC via a compromised tenant,
	// and plenty of legitimate small senders publish no DMARC at all.
	const score = strong * 2 + weak + authWeak;
	const suspect = (strong >= 1 && (strong + weak + authWeak) >= 2) || weak >= 2;

	return { suspect, score, reasons };
}

export default { assessPhishing };
