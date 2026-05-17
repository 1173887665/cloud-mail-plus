export function htmlToPlainText(html) {
	if (!html) return '';
	return html
		.replace(/<style[^>]*>.*?<\/style>/gis, '')
		.replace(/<script[^>]*>.*?<\/script>/gis, '')
		.replace(/<br\s*\/?>/gi, '\n')
		.replace(/<\/(p|div|li|h[1-6]|tr)[^>]*>/gi, '\n')
		.replace(/<(p|div|li|h[1-6]|tr)[^>]*>/gi, '')
		.replace(/<[^>]+>/g, '')
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/\n{3,}/g, '\n\n')
		.trim();
}

export function escapeHtml(s) {
	return String(s).replace(/[&<>"']/g, ch =>
		({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

export function paragraphsToHtml(text) {
	return (text || '')
		.split(/\n{2,}/)
		.map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
		.join('');
}
