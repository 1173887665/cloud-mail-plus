import { describe, it, expect } from 'vitest';
import { robustJsonParse } from '../../src/utils/robust-json';

describe('robustJsonParse', () => {
  it('parses bare JSON', () => {
    expect(robustJsonParse('{"a":1}')).toEqual({ a: 1 });
  });
  it('strips ```json``` fences', () => {
    expect(robustJsonParse('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('strips plain ``` fences', () => {
    expect(robustJsonParse('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('extracts JSON when model adds leading commentary', () => {
    expect(robustJsonParse('Here is the result:\n{"a":1}\nDone.')).toEqual({ a: 1 });
  });
  it('handles nested } in string values', () => {
    expect(robustJsonParse('{"body":"end of sentence}"}')).toEqual({ body: 'end of sentence}' });
  });
  it('returns null for null/empty/undefined', () => {
    expect(robustJsonParse(null)).toBeNull();
    expect(robustJsonParse('')).toBeNull();
    expect(robustJsonParse(undefined)).toBeNull();
  });
  it('returns null for non-JSON garbage', () => {
    expect(robustJsonParse('I am not JSON at all')).toBeNull();
  });
  it('returns null for malformed JSON inside fence', () => {
    expect(robustJsonParse('```{"a":}```')).toBeNull();
  });
});
