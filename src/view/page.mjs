// One paging rule for every view that returns a slice of text: task status
// views, the research report, and anything that builds on them.
//
// Offsets are UTF-16 code-unit offsets. A page never exceeds `limit`, never
// splits a surrogate pair, and always advances: an offset past the end clamps
// to the end rather than failing, an offset inside a surrogate pair is
// rejected, and `complete`/`nextOffset: null` mark the final page.
export const DEFAULT_PAGE_LIMIT = 2000;
export const MAX_PAGE_LIMIT = 4000;

const isHighSurrogate = c => c >= 0xd800 && c <= 0xdbff;
const isLowSurrogate = c => c >= 0xdc00 && c <= 0xdfff;

/** Validate a page offset: a non-negative safe integer. */
export function safeOffset(value, label = 'offset') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative safe integer`);
  }
  return value;
}

/** Validate a page limit: a safe integer between 1 and MAX_PAGE_LIMIT. */
export function safePageLimit(value, label = 'limit') {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
      value < 1 || value > MAX_PAGE_LIMIT) {
    throw new Error(`${label} must be a safe integer between 1 and ${MAX_PAGE_LIMIT}`);
  }
  return value;
}

/**
 * Slice one page of a string.
 * @returns {{text: string, offset: number, limit: number, totalChars: number,
 *   nextOffset: number|null, complete: boolean}} one bounded page.
 */
export function pageOf(value, offset, limit) {
  const text = typeof value === 'string' ? value : '';
  const totalChars = text.length;
  // An offset in the middle of a surrogate pair cannot start a valid page.
  // Reject it explicitly instead of returning a lone low surrogate.
  if (offset > 0 && offset < totalChars &&
      isLowSurrogate(text.charCodeAt(offset)) && isHighSurrogate(text.charCodeAt(offset - 1))) {
    throw new Error(`offset ${offset} splits a surrogate pair; use the previous nextOffset`);
  }
  const start = Math.min(offset, totalChars);
  let end = Math.min(start + limit, totalChars);
  if (end < totalChars && end > start) {
    if (isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) {
      // A pair at the boundary: shrink the page rather than emit a lone
      // surrogate. With limit=1 there is no room to shrink, so fail clearly
      // instead of returning an empty page that never advances.
      if (end - start === 1) throw new Error('limit is too small to advance over a surrogate pair; use limit >= 2');
      end -= 1;
    }
  }
  return {
    text: text.slice(start, end),
    offset: start,
    limit,
    totalChars,
    nextOffset: end < totalChars ? end : null,
    complete: end >= totalChars,
  };
}
