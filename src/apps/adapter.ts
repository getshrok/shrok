// src/apps/adapter.ts
// Express <-> web Fetch bridge (D-06/D-07).
//
// ⚠️ D-07 contract — callers MUST pass the body as JSON.stringify(req.body ?? {}).
// src/dashboard/server.ts:170 mounts express.json() GLOBALLY, so the raw request
// stream is already consumed by the time the action route runs. Reading the raw stream
// would yield an empty body. Build the web Request from req.body (already parsed) by
// re-serialising it back to a JSON string. The content-type stays "application/json"
// (carried in req.headers), which createAction content-type-detects to parse the VMS
// {name,state} payload.
//
// Multipart / file-upload is explicitly deferred — this adapter handles the JSON
// action wire only (Deferred Ideas in 55-02-PLAN.md).
import type { Request as ExReq, Response as ExRes } from 'express'

// SKIP_HEADERS: headers the web Fetch layer must not receive from the Express side.
// - content-length: recomputed by Fetch from the body string length.
// - host: reflects the internal proxy address, not the web Fetch target.
const SKIP_HEADERS = new Set(['content-length', 'host'])

/**
 * Build a global web Fetch `Request` from an incoming Express request.
 *
 * @param req  - Express request (already populated by express.json middleware, D-07).
 * @param body - The serialised body string. Callers must supply `JSON.stringify(req.body ?? {})`.
 *               Do NOT attempt to re-read `req` as a raw stream — it is already consumed.
 */
export function toWebRequest(req: ExReq, body: string): Request {
  const headers = new Headers()
  for (const [k, v] of Object.entries(req.headers)) {
    if (SKIP_HEADERS.has(k.toLowerCase())) continue
    if (typeof v === 'string') {
      headers.set(k, v)
    }
    // Array values (Express multi-value headers) are intentionally skipped —
    // the JSON action wire is single-value; multi-value edge cases are deferred.
  }

  return new Request(`http://localhost${req.originalUrl}`, {
    method: req.method,
    headers,
    body,
  })
}

/**
 * Write a web Fetch `Response` back onto an Express response object.
 *
 * Copies: status code, all response headers, response body text.
 */
export async function sendWeb(webRes: Response, res: ExRes): Promise<void> {
  res.status(webRes.status)
  webRes.headers.forEach((v, k) => {
    res.setHeader(k, v)
  })
  res.send(await webRes.text())
}
