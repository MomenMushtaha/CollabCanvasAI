import dns from "node:dns/promises"
import net from "node:net"

export interface SafeUrlResult {
  safe: boolean
  error?: string
  url?: URL
}

/**
 * Checks whether an IPv4 address belongs to private, reserved, or internal ranges.
 */
export function isPrivateIPv4(ip: string): boolean {
  const parts = ip.split(".").map((p) => Number.parseInt(p, 10))
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) {
    return true // Invalid format treated as unsafe
  }

  const [a, b] = parts

  // 0.0.0.0/8 (Current network)
  if (a === 0) return true
  // 10.0.0.0/8 (Private)
  if (a === 10) return true
  // 100.64.0.0/10 (Shared Address Space / CGNAT)
  if (a === 100 && b >= 64 && b <= 127) return true
  // 127.0.0.0/8 (Loopback)
  if (a === 127) return true
  // 169.254.0.0/16 (Link-local, including 169.254.169.254 metadata service)
  if (a === 169 && b === 254) return true
  // 172.16.0.0/12 (Private: 172.16.0.0 - 172.31.255.255)
  if (a === 172 && b >= 16 && b <= 31) return true
  // 192.0.0.0/24 (IETF Protocol Assignments)
  if (a === 192 && b === 0 && parts[2] === 0) return true
  // 192.0.2.0/24 (Documentation / TEST-NET-1)
  if (a === 192 && b === 0 && parts[2] === 2) return true
  // 192.168.0.0/16 (Private)
  if (a === 192 && b === 168) return true
  // 198.18.0.0/15 (Benchmarking)
  if (a === 198 && (b === 18 || b === 19)) return true
  // 198.51.100.0/24 (Documentation / TEST-NET-2)
  if (a === 198 && b === 51 && parts[2] === 100) return true
  // 203.0.113.0/24 (Documentation / TEST-NET-3)
  if (a === 203 && b === 0 && parts[2] === 113) return true
  // 224.0.0.0/4 (Multicast)
  if (a >= 224 && a <= 239) return true
  // 240.0.0.0/4 (Reserved / Future Use)
  if (a >= 240) return true

  return false
}

/**
 * Checks whether an IPv6 address belongs to private, loopback, or reserved ranges.
 */
export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase().trim()

  // Loopback and unspecified
  if (normalized === "::1" || normalized === "::" || normalized === "0:0:0:0:0:0:0:1" || normalized === "0:0:0:0:0:0:0:0") {
    return true
  }

  // IPv4-mapped IPv6 (::ffff:x.x.x.x)
  if (normalized.startsWith("::ffff:") || normalized.startsWith("0:0:0:0:0:ffff:")) {
    const ipv4Part = normalized.substring(normalized.lastIndexOf(":") + 1)
    if (net.isIPv4(ipv4Part)) {
      return isPrivateIPv4(ipv4Part)
    }
    return true
  }

  // Unique local addresses (fc00::/7 -> fc00:: to fdff::)
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
    return true
  }

  // Link-local addresses (fe80::/10 -> fe80:: to febf::)
  if (/^fe[89ab]/i.test(normalized)) {
    return true
  }

  // Multicast (ff00::/8)
  if (normalized.startsWith("ff")) {
    return true
  }

  return false
}

/**
 * Validates a target URL against SSRF attacks:
 * - Ensures scheme is strictly http: or https:
 * - Blocks loopback, internal hostnames, and cloud metadata hostnames
 * - Resolves hostname via DNS and checks all returned IPs against private/internal blocks
 */
export async function validateSafeUrl(urlString: string): Promise<SafeUrlResult> {
  let parsed: URL
  try {
    parsed = new URL(urlString)
  } catch {
    return { safe: false, error: "Invalid URL format" }
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { safe: false, error: `Disallowed URL protocol: ${parsed.protocol}. Only http: and https: are allowed.` }
  }

  const hostname = parsed.hostname.toLowerCase().trim()
  if (!hostname) {
    return { safe: false, error: "Empty hostname in URL" }
  }

  // Block known internal / metadata hostnames
  const blockedHostnames = new Set([
    "localhost",
    "metadata.google.internal",
    "metadata.google",
    "instance-data",
  ])

  if (
    blockedHostnames.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.endsWith(".onion")
  ) {
    return { safe: false, error: "Access to local or internal hostnames is prohibited" }
  }

  // Check if hostname is an IP literal
  if (net.isIPv4(hostname)) {
    if (isPrivateIPv4(hostname)) {
      return { safe: false, error: "Access to private or reserved IP addresses is prohibited" }
    }
    return { safe: true, url: parsed }
  }

  if (net.isIPv6(hostname)) {
    if (isPrivateIPv6(hostname)) {
      return { safe: false, error: "Access to private or reserved IP addresses is prohibited" }
    }
    return { safe: true, url: parsed }
  }

  // Resolve hostname via DNS to check underlying IP addresses (prevents DNS rebinding and private IP domain mapping)
  try {
    const addresses = await dns.lookup(hostname, { all: true })
    if (!addresses || addresses.length === 0) {
      return { safe: false, error: "Hostname could not be resolved" }
    }

    for (const record of addresses) {
      if (record.family === 4 && isPrivateIPv4(record.address)) {
        return { safe: false, error: "Resolved hostname maps to a private or reserved IP address" }
      }
      if (record.family === 6 && isPrivateIPv6(record.address)) {
        return { safe: false, error: "Resolved hostname maps to a private or reserved IPv6 address" }
      }
    }
  } catch (dnsErr) {
    return { safe: false, error: `DNS lookup failed for hostname: ${dnsErr instanceof Error ? dnsErr.message : String(dnsErr)}` }
  }

  return { safe: true, url: parsed }
}

export interface SafeFetchOptions {
  maxBytes?: number
  timeoutMs?: number
  maxRedirects?: number
}

/**
 * Fetches HTML content safely with full SSRF protection, timeout, size limit, and redirect validation.
 */
export async function safeFetchHtml(
  targetUrl: string,
  options: SafeFetchOptions = {},
): Promise<{ ok: boolean; status: number; statusText: string; html?: string; error?: string }> {
  const maxBytes = options.maxBytes ?? 2 * 1024 * 1024 // Default 2MB limit
  const timeoutMs = options.timeoutMs ?? 8_000 // Default 8s timeout
  const maxRedirects = options.maxRedirects ?? 3

  let currentUrl = targetUrl
  let redirectsCount = 0

  while (redirectsCount <= maxRedirects) {
    const validation = await validateSafeUrl(currentUrl)
    if (!validation.safe || !validation.url) {
      return { ok: false, status: 400, statusText: "Bad Request", error: validation.error || "URL failed SSRF validation" }
    }

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
      const response = await fetch(validation.url.toString(), {
        signal: controller.signal,
        redirect: "manual",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
        },
      })

      clearTimeout(timeoutId)

      // Handle redirect manually to validate the target URL
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location")
        if (!location) {
          return { ok: false, status: response.status, statusText: response.statusText, error: "Redirect missing Location header" }
        }

        const nextUrl = new URL(location, validation.url).toString()
        currentUrl = nextUrl
        redirectsCount++
        continue
      }

      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          statusText: response.statusText,
          error: `Failed to fetch website: ${response.status} ${response.statusText}`,
        }
      }

      // Read response stream with size limitation
      if (!response.body) {
        const text = await response.text()
        return { ok: true, status: response.status, statusText: response.statusText, html: text.slice(0, maxBytes) }
      }

      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let totalBytes = 0

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if (value) {
          totalBytes += value.length
          chunks.push(value)
          if (totalBytes > maxBytes) {
            await reader.cancel("Response exceeded maximum size limit")
            break
          }
        }
      }

      const merged = new Uint8Array(totalBytes)
      let offset = 0
      for (const chunk of chunks) {
        merged.set(chunk, offset)
        offset += chunk.length
      }

      const decoder = new TextDecoder("utf-8", { fatal: false, ignoreBOM: true })
      const html = decoder.decode(merged)

      return { ok: true, status: response.status, statusText: response.statusText, html }
    } catch (err) {
      clearTimeout(timeoutId)
      if (err instanceof Error && err.name === "AbortError") {
        return { ok: false, status: 408, statusText: "Request Timeout", error: "Request timed out or was aborted" }
      }
      return { ok: false, status: 500, statusText: "Fetch Error", error: err instanceof Error ? err.message : String(err) }
    }
  }

  return { ok: false, status: 310, statusText: "Too Many Redirects", error: "Exceeded maximum redirect count" }
}
