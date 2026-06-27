// src/apps/adapter.ts
// Express <-> web Fetch bridge (D-06/D-07).
//
// ⚠️ Body contract — the caller decides what bytes to forward, by content-type:
//   - multipart/form-data (the REAL VMS BrowserAdapter wire — FormData with _action/_state):
//     pass the raw request Buffer through untouched. src/dashboard/server.ts:171 mounts
//     express.json() globally, but express.json only drains application/json bodies — it does
//     NOT consume a multipart stream, so the raw bytes are still available and the action route
//     captures them with a route-scoped express.raw(). The original content-type (with its
//     boundary) is carried in req.headers, which createAction content-type-detects to parse the
//     FormData. Passing a JSON string here instead is the bug that produced HTTP 400
//     "Failed to parse body as FormData" for every built app's buttons.
//   - application/json: express.json already parsed it, so the caller passes
//     JSON.stringify(req.body ?? {}); createAction parses it as JSON.
import type { Request as ExReq, Response as ExRes } from 'express'

// SKIP_HEADERS: headers the web Fetch layer must not receive from the Express side.
// - content-length: recomputed by Fetch from the body string length.
// - host: reflects the internal proxy address, not the web Fetch target.
const SKIP_HEADERS = new Set(['content-length', 'host'])

/**
 * Build a global web Fetch `Request` from an incoming Express request.
 *
 * @param req  - Express request.
 * @param body - The body bytes to forward: a Buffer of the raw multipart body (the real VMS
 *               action wire), or `JSON.stringify(req.body ?? {})` for the application/json path.
 *               The original content-type header (incl. any multipart boundary) is preserved so
 *               createAction can content-type-detect and parse it.
 */
export function toWebRequest(req: ExReq, body: string | Buffer): Request {
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
