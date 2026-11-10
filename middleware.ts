import { NextResponse, type NextRequest } from "next/server"
import { studioAccessResponse } from "./lib/server/studio-auth"

export function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname.replace(/\/$/, "")
  // These two routes validate their own separate cron credential.
  if (path === "/api/keepalive" || path === "/api/smoke-test") return NextResponse.next()
  return studioAccessResponse(request.headers) ?? NextResponse.next()
}

export const config = {
  runtime: "nodejs",
  matcher: ["/studio/:path*", "/api/:path*"]
}
