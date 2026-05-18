import { describe, it, expect } from 'vitest';
import { detectLang } from '../../src/utils/lang-detect';

describe('detectLang', () => {
  it('detects English', () => {
    expect(detectLang('The quick brown fox jumps over the lazy dog. ' +
      'A long enough sample for franc to lock in on English.')).toBe('en');
  });
  it('detects Simplified Chinese', () => {
    expect(detectLang('这是一段中文文本，用于测试语言检测功能。请确认检测器能够识别中文。')).toBe('zh');
  });
  it('detects Japanese', () => {
    expect(detectLang('これは日本語のテキストです。言語検出機能をテストするための文字列です。')).toBe('ja');
  });
  it('returns "und" for too-short text', () => {
    expect(detectLang('Hi')).toBe('und');
  });
  it('returns "und" for empty/null', () => {
    expect(detectLang('')).toBe('und');
    expect(detectLang(null)).toBe('und');
  });
});
