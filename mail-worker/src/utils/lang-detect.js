import { franc } from 'franc-min';
import { iso6393To1 } from 'iso-639-3';

// Franc-specific mappings (franc uses slightly different codes than standard ISO 639-3)
const francMappings = {
  cmn: 'zh', // Mandarin Chinese (franc returns 'cmn', not 'zho')
};

// Returns ISO 639-1 code (e.g. 'en', 'zh') or 'und' when detection is uncertain.
export function detectLang(text) {
  if (!text || typeof text !== 'string') return 'und';
  const code3 = franc(text, { minLength: 10 });   // franc returns ISO 639-3, e.g. 'cmn', 'eng'
  if (code3 === 'und') return 'und';
  const code1 = francMappings[code3] || iso6393To1[code3];
  return code1 || 'und';
}
