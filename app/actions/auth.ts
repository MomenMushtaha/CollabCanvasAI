"use server"

import { createServerClient } from "@supabase/ssr"
import { cookies, headers } from "next/headers"
import { redirect } from "next/navigation"

async function getOrigin(): Promise<string> {
  if (process.env.NEXT_PUBLIC_SITE_URL) {
    return process.env.NEXT_PUBLIC_SITE_URL.replace(/\/$/, "")
  }

  const headersList = await headers()

  const origin = headersList.get("origin")
  if (origin) {
    try {
      const parsedOrigin = new URL(origin)
      if (parsedOrigin.protocol === "http:" || parsedOrigin.protocol === "https:") {
        return parsedOrigin.origin
      }
    } catch {
      // Ignore malformed origin
    }
  }

  const host = headersList.get("x-forwarded-host") || headersList.get("host")
  const proto = headersList.get("x-forwarded-proto") || "https"
  if (host) {
    const primaryHost = host.split(",")[0].trim()
    if (/^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*(:[0-9]{1,5})?$/.test(primaryHost)) {
      const safeProto = proto === "http" ? "http" : "https"
      return `${safeProto}://${primaryHost}`
    }
  }

  return ""
}

export async function signInWithGoogle() {
  const cookieStore = await cookies()
  const origin = await getOrigin()

  if (!origin) {
    return { error: "Could not determine origin" }
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
          } catch (error) {
            // Cookie setting can fail in certain contexts
          }
        },
      },
    },
  )

  const redirectUrl = `${origin}/auth/callback`

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: redirectUrl,
      queryParams: {
        access_type: "offline",
        prompt: "consent",
      },
    },
  })

  if (error) {
    return { error: error.message }
  }

  if (data.url) {
    redirect(data.url)
  }

  return { error: "No redirect URL received from Supabase" }
}

export async function signInWithGitHub() {
  const cookieStore = await cookies()
  const origin = await getOrigin()

  if (!origin) {
    return { error: "Could not determine origin" }
  }

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll()
        },
        setAll(cookiesToSet) {
          try {
            cookiesToSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options))
          } catch (error) {
            // Cookie setting can fail in certain contexts
          }
        },
      },
    },
  )

  const redirectUrl = `${origin}/auth/callback`

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "github",
    options: {
      redirectTo: redirectUrl,
    },
  })

  if (error) {
    return { error: error.message }
  }

  if (data.url) {
    redirect(data.url)
  }

  return { error: "No redirect URL received from Supabase" }
}
