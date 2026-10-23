// Server-only routes (cron jobs, smoke tests) require the Vercel Cron secret,
// sent as "Authorization: Bearer <CRON_SECRET>".
export function hasCronSecret(request: Request) {
  const secret = process.env.CRON_SECRET

  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`
}
