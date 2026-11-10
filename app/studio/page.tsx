import Link from "next/link"
import { headers } from "next/headers"
import { redirect } from "next/navigation"
import { hasStudioAccess } from "@/lib/server/studio-auth"
import { StudioWorkspace } from "@/components/studio/studio-workspace"
import { listStudioStories, loadStudioStory } from "@/lib/server/studio-story-service"

type StudioPageProps = {
  searchParams?: Promise<{
    storyId?: string
  }>
}

export default async function StudioPage({ searchParams }: StudioPageProps) {
  if (!hasStudioAccess(await headers())) redirect("/")
  const resolvedSearchParams = searchParams ? await searchParams : undefined
  const story = await loadStudioStory(resolvedSearchParams?.storyId ?? null)
  const stories = await listStudioStories()

  if (!story) {
    return (
      <main className="reader-shell">
        <section className="reader-topbar">
          <div>
            <p className="reader-eyebrow">EMBER Studio</p>
            <h1>Keine Story in Supabase gefunden</h1>
            <p>
              Lege zuerst einen Workspace und eine Story in der Datenbank an oder übergib
              `?storyId=...`, damit das Studio ein echtes Projekt laden kann.
            </p>
          </div>
          <div className="reader-actions">
            <Link href="/" className="landing-button">
              Store öffnen
            </Link>
          </div>
        </section>
      </main>
    )
  }

  return <StudioWorkspace story={story} stories={stories} />
}
