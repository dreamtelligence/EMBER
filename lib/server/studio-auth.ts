import { timingSafeEqual } from "node:crypto"

export function hasStudioAccess(headers: Pick<Headers, "get">): boolean {
  const password = process.env.STUDIO_PASSWORD
  const authorization = headers.get("authorization")
  if (!password || !authorization?.startsWith("Basic ")) return false

  const supplied = Buffer.from(authorization.slice(6), "base64")
  const expected = Buffer.from(`${process.env.STUDIO_USERNAME || "studio"}:${password}`)
  return supplied.length === expected.length && timingSafeEqual(supplied, expected)
}

export function studioAccessResponse(headers: Pick<Headers, "get">): Response | null {
  if (!process.env.STUDIO_PASSWORD) {
    return new Response("Studio access is not configured.", {
      status: 503,
      headers: { "Cache-Control": "private, no-store" }
    })
  }
  if (hasStudioAccess(headers)) return null
  return new Response("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="EMBER Studio", charset="UTF-8"',
      "Cache-Control": "private, no-store"
    }
  })
}
