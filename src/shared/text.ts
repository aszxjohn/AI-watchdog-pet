/**
 * Small text helpers shared by every layer. No imports, so the sandbox
 * bundle can use them too.
 */

/**
 * `text` at most `max` UTF-16 code units long: a longer one is cut between
 * characters (never inside a surrogate pair) and ends with `…`, which
 * counts toward `max`.
 */
export function cutText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  if (max < 1) {
    return '';
  }
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  // Do not leave the high half of a surrogate pair at the end.
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) {
    end -= 1;
  }
  return `${text.slice(0, end)}…`;
}
