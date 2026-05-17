import { describe, it, expect } from 'vitest';
import { htmlToPlainText, paragraphsToHtml, escapeHtml } from '../../src/utils/html-utils';

describe('htmlToPlainText', () => {
  it('strips <style> blocks', () => {
    expect(htmlToPlainText('<style>body { color: red }</style>Hello')).toBe('Hello');
  });
  it('strips <script> blocks', () => {
    expect(htmlToPlainText('<script>alert(1)</script>Hi')).toBe('Hi');
  });
  it('converts paragraph and br tags to newlines', () => {
    expect(htmlToPlainText('<p>A</p><p>B</p>')).toBe('A\nB');
  });
  it('preserves paragraph break across nested div', () => {
    expect(htmlToPlainText('<div>First</div><div>Second</div>')).toBe('First\nSecond');
  });
  it('decodes &amp; &lt; &gt; &quot; &nbsp;', () => {
    expect(htmlToPlainText('&amp; &lt; &gt; &quot; A&nbsp;B')).toBe('& < > " A B');
  });
  it('collapses 3+ blank lines to one', () => {
    expect(htmlToPlainText('A<br><br><br><br>B')).toBe('A\n\nB');
  });
  it('returns empty string for null/empty input', () => {
    expect(htmlToPlainText(null)).toBe('');
    expect(htmlToPlainText('')).toBe('');
  });
});

describe('escapeHtml', () => {
  it('escapes <, >, &, ", \'', () => {
    expect(escapeHtml(`<script>"a'&b"</script>`))
      .toBe('&lt;script&gt;&quot;a&#39;&amp;b&quot;&lt;/script&gt;');
  });
});

describe('paragraphsToHtml', () => {
  it('wraps each paragraph in <p>', () => {
    expect(paragraphsToHtml('A\n\nB')).toBe('<p>A</p><p>B</p>');
  });
  it('converts single \\n to <br> within a paragraph', () => {
    expect(paragraphsToHtml('Line1\nLine2\n\nPara2')).toBe('<p>Line1<br>Line2</p><p>Para2</p>');
  });
  it('escapes injection attempts from model output', () => {
    expect(paragraphsToHtml('<script>alert(1)</script>'))
      .toBe('<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });
  it('returns empty <p></p> for empty input', () => {
    expect(paragraphsToHtml('')).toBe('<p></p>');
  });
});
