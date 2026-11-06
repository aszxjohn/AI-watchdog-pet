/**
 * Local-time text formats used in file names and log lines. Everything here
 * reads the machine's local time zone; timestamps in data stay epoch ms.
 */

function pad(value: number, width = 2): string {
  return String(value).padStart(width, '0');
}

/** `2026-11-05T17:04:09.123+08:00`: local time with its UTC offset. */
export function localIsoTimestamp(at: Date): string {
  const offset = -at.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}` +
    `T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}` +
    `.${pad(at.getMilliseconds(), 3)}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** `2026-11-05-17`: the local hour, as run log files are named. */
export function localHourStamp(at: Date): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}`;
}

/** `20261105-170409`: the local second, as backup file suffixes use. */
export function localSecondStamp(at: Date): string {
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`
  );
}
