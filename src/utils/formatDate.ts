/**
 * Utility functions for formatting dates in API responses.
 * All dates are formatted as ISO 8601 strings (e.g. "2026-04-05T08:53:27.212Z").
 */

/**
 * Formats a Date object as an ISO 8601 string suitable for API responses.
 *
 * @param date - The Date object to format.
 * @returns An ISO 8601 formatted string, or `null` if the input is null/undefined/invalid.
 *
 * @example
 * formatDate(new Date())       // "2026-04-05T08:53:27.212Z"
 * formatDate(null)             // null
 * formatDate(new Date("bad"))  // null
 */
export function formatDate(date: Date | null | undefined): string | null {
  if (date == null) return null;
  if (isNaN(date.getTime())) return null;
  return date.toISOString();
}

/**
 * Formats a Date object as an ISO 8601 string, throwing if the input is invalid.
 * Use this when a missing or invalid date is a programming error, not a runtime condition.
 *
 * @param date - The Date object to format.
 * @returns An ISO 8601 formatted string.
 * @throws {TypeError} If the date is null, undefined, or invalid.
 *
 * @example
 * formatDateOrThrow(new Date())  // "2026-04-05T08:53:27.212Z"
 * formatDateOrThrow(null)        // throws TypeError
 */
export function formatDateOrThrow(date: Date | null | undefined): string {
  if (date == null) throw new TypeError("Date must not be null or undefined.");
  if (isNaN(date.getTime())) throw new TypeError(`Invalid date value: ${date}`);
  return date.toISOString();
}

/**
 * Returns the current UTC timestamp as an ISO 8601 string.
 * Useful for `createdAt`, `updatedAt`, and similar API fields.
 *
 * @returns The current UTC time as an ISO 8601 string.
 *
 * @example
 * nowIso() // "2026-04-05T08:53:27.212Z"
 */
export function nowIso(): string {
  return new Date().toISOString();
}
