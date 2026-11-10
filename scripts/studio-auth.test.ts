import assert from "node:assert/strict"
import { hasStudioAccess, studioAccessResponse } from "../lib/server/studio-auth"
import { NextRequest } from "next/server"
import { config, middleware } from "../middleware"

const originalPassword = process.env.STUDIO_PASSWORD
const originalUsername = process.env.STUDIO_USERNAME
const basic = (value: string) => new Headers({ authorization: `Basic ${Buffer.from(value).toString("base64")}` })

try {
  delete process.env.STUDIO_PASSWORD
  assert.equal(studioAccessResponse(new Headers())?.status, 503)
  process.env.STUDIO_PASSWORD = "local-test-password"
  process.env.STUDIO_USERNAME = "studio"
  for (const headers of [new Headers(), basic("studio:wrong"), basic("other:local-test-password"), new Headers({ authorization: "Basic !!!" }), new Headers({ authorization: "Bearer local-test-password" })]) {
    assert.equal(hasStudioAccess(headers), false)
    const response = studioAccessResponse(headers)
    assert.equal(response?.status, 401)
    assert.equal(response?.headers.get("cache-control"), "private, no-store")
  }
  assert.equal(studioAccessResponse(basic("studio:local-test-password")), null)
  assert.deepEqual(config.matcher, ["/studio/:path*", "/api/:path*"])
  for (const path of ["/studio/", "/api/stories/", "/api/stories/example/", "/api/book-jobs/", "/api/story-chat/"]) {
    assert.equal(middleware(new NextRequest(`http://localhost${path}`)).status, 401)
  }
  assert.equal(middleware(new NextRequest("http://localhost/api/keepalive/")).headers.get("x-middleware-next"), "1")
  process.env.STUDIO_USERNAME = "author"
  assert(hasStudioAccess(basic("author:local-test-password")))
  assert(!hasStudioAccess(basic("studio:local-test-password")))
  console.log("Studio authentication tests passed")
} finally {
  if (originalPassword === undefined) delete process.env.STUDIO_PASSWORD
  else process.env.STUDIO_PASSWORD = originalPassword
  if (originalUsername === undefined) delete process.env.STUDIO_USERNAME
  else process.env.STUDIO_USERNAME = originalUsername
}
