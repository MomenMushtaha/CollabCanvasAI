import type { CanvasObject } from "@/lib/types"

interface ExportOptions {
  format: "png" | "svg"
  objects: CanvasObject[]
  backgroundColor?: string
  scale?: number
  viewport?: { x: number; y: number; zoom: number }
  canvasWidth?: number
  canvasHeight?: number
}

export function exportCanvas({
  format,
  objects,
  backgroundColor = "#ffffff",
  scale = 2,
  viewport,
  canvasWidth = 1920,
  canvasHeight = 1080,
}: ExportOptions) {
  const visibleBounds = viewport
    ? {
        x: -viewport.x / viewport.zoom,
        y: -viewport.y / viewport.zoom,
        width: canvasWidth / viewport.zoom,
        height: canvasHeight / viewport.zoom,
      }
    : null

  const visibleObjects = visibleBounds
    ? objects.filter((obj) => {
        const objRight = obj.x + obj.width
        const objBottom = obj.y + obj.height
        const boundsRight = visibleBounds.x + visibleBounds.width
        const boundsBottom = visibleBounds.y + visibleBounds.height

        return obj.x < boundsRight && objRight > visibleBounds.x && obj.y < boundsBottom && objBottom > visibleBounds.y
      })
    : objects

  if (visibleObjects.length === 0) {
    console.warn("[v0] No visible objects to export")
    return
  }

  if (format === "png") {
    exportPNG(visibleObjects, backgroundColor, scale, visibleBounds)
  } else {
    exportSVG(visibleObjects, backgroundColor, visibleBounds)
  }
}

function exportPNG(
  objects: CanvasObject[],
  backgroundColor: string,
  scale: number,
  visibleBounds: { x: number; y: number; width: number; height: number } | null,
) {
  const bounds = visibleBounds || calculateBounds(objects)
  const padding = 20

  const canvas = document.createElement("canvas")
  canvas.width = (bounds.width + padding * 2) * scale
  canvas.height = (bounds.height + padding * 2) * scale

  const ctx = canvas.getContext("2d")
  if (!ctx) return

  ctx.scale(scale, scale)

  // Fill background
  ctx.fillStyle = backgroundColor
  ctx.fillRect(0, 0, bounds.width + padding * 2, bounds.height + padding * 2)

  ctx.translate(padding - bounds.x, padding - bounds.y)

  // Render objects
  objects.forEach((obj) => {
    ctx.save()
    renderObject(ctx, obj)
    ctx.restore()
  })

  // Download
  canvas.toBlob((blob) => {
    if (blob) {
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = `canvas-export-${Date.now()}.png`
      a.click()
      URL.revokeObjectURL(url)
    }
  })
}

function exportSVG(
  objects: CanvasObject[],
  backgroundColor: string,
  visibleBounds: { x: number; y: number; width: number; height: number } | null,
) {
  const bounds = visibleBounds || calculateBounds(objects)
  const padding = 20

  const width = bounds.width + padding * 2
  const height = bounds.height + padding * 2
  const safeBg = sanitizeColor(backgroundColor, "#ffffff")

  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">\n`
  svg += `  <rect width="${width}" height="${height}" fill="${safeBg}"/>\n`
  svg += `  <g transform="translate(${padding - bounds.x}, ${padding - bounds.y})">\n`

  objects.forEach((obj) => {
    svg += renderObjectSVG(obj)
  })

  svg += `  </g>\n`
  svg += `</svg>`

  const blob = new Blob([svg], { type: "image/svg+xml" })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = `canvas-export-${Date.now()}.svg`
  a.click()
  URL.revokeObjectURL(url)
}

function calculateBounds(objects: CanvasObject[]) {
  if (objects.length === 0) {
    return { x: 0, y: 0, width: 800, height: 600 }
  }

  let minX = Number.POSITIVE_INFINITY
  let minY = Number.POSITIVE_INFINITY
  let maxX = Number.NEGATIVE_INFINITY
  let maxY = Number.NEGATIVE_INFINITY

  objects.forEach((obj) => {
    minX = Math.min(minX, obj.x)
    minY = Math.min(minY, obj.y)
    maxX = Math.max(maxX, obj.x + obj.width)
    maxY = Math.max(maxY, obj.y + obj.height)
  })

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY,
  }
}

function renderObject(ctx: CanvasRenderingContext2D, obj: CanvasObject) {
  if (obj.type === "rectangle") {
    ctx.fillStyle = obj.fill_color
    ctx.strokeStyle = obj.stroke_color
    ctx.lineWidth = obj.stroke_width
    ctx.fillRect(obj.x, obj.y, obj.width, obj.height)
    ctx.strokeRect(obj.x, obj.y, obj.width, obj.height)
  } else if (obj.type === "circle") {
    ctx.fillStyle = obj.fill_color
    ctx.strokeStyle = obj.stroke_color
    ctx.lineWidth = obj.stroke_width
    const radius = Math.min(obj.width, obj.height) / 2
    ctx.beginPath()
    ctx.arc(obj.x + obj.width / 2, obj.y + obj.height / 2, radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  } else if (obj.type === "triangle") {
    ctx.fillStyle = obj.fill_color
    ctx.strokeStyle = obj.stroke_color
    ctx.lineWidth = obj.stroke_width
    ctx.beginPath()
    ctx.moveTo(obj.x + obj.width / 2, obj.y)
    ctx.lineTo(obj.x, obj.y + obj.height)
    ctx.lineTo(obj.x + obj.width, obj.y + obj.height)
    ctx.closePath()
    ctx.fill()
    ctx.stroke()
  } else if (obj.type === "line") {
    ctx.strokeStyle = obj.stroke_color
    ctx.lineWidth = obj.stroke_width
    ctx.beginPath()
    ctx.moveTo(obj.x, obj.y)
    ctx.lineTo(obj.x + obj.width, obj.y + obj.height)
    ctx.stroke()
  } else if (obj.type === "text") {
    ctx.font = `${obj.font_size || 16}px ${obj.font_family || "Arial"}`
    ctx.fillStyle = obj.fill_color
    ctx.textBaseline = "middle"
    ctx.textAlign = "center"
    ctx.fillText(obj.text_content || "", obj.x + obj.width / 2, obj.y + obj.height / 2)
  }
}

export function escapeXml(unsafe: unknown): string {
  if (unsafe === undefined || unsafe === null) return ""
  return String(unsafe)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;")
}

export function sanitizeNumber(value: unknown, fallback = 0): number {
  const num = typeof value === "number" ? value : Number.parseFloat(String(value))
  return Number.isFinite(num) ? num : fallback
}

export function sanitizeColor(color: unknown, fallback = "#000000"): string {
  if (typeof color !== "string") return fallback
  const trimmed = color.trim()
  if (/^(#[0-9a-fA-F]{3,8}|rgba?\([^)]+\)|hsla?\([^)]+\)|[a-zA-Z]+)$/.test(trimmed)) {
    return escapeXml(trimmed)
  }
  return fallback
}

function renderObjectSVG(obj: CanvasObject): string {
  const x = sanitizeNumber(obj.x)
  const y = sanitizeNumber(obj.y)
  const width = Math.max(0, sanitizeNumber(obj.width))
  const height = Math.max(0, sanitizeNumber(obj.height))
  const strokeWidth = Math.max(0, sanitizeNumber(obj.stroke_width, 1))
  const fillColor = sanitizeColor(obj.fill_color, "#3b82f6")
  const strokeColor = sanitizeColor(obj.stroke_color, "#1e40af")

  if (obj.type === "rectangle") {
    return `    <rect x="${x}" y="${y}" width="${width}" height="${height}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>\n`
  } else if (obj.type === "circle") {
    const radius = Math.min(width, height) / 2
    const cx = x + width / 2
    const cy = y + height / 2
    return `    <circle cx="${cx}" cy="${cy}" r="${radius}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>\n`
  } else if (obj.type === "triangle") {
    const x1 = x + width / 2
    const y1 = y
    const x2 = x
    const y2 = y + height
    const x3 = x + width
    const y3 = y + height
    return `    <polygon points="${x1},${y1} ${x2},${y2} ${x3},${y3}" fill="${fillColor}" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>\n`
  } else if (obj.type === "line") {
    return `    <line x1="${x}" y1="${y}" x2="${x + width}" y2="${y + height}" stroke="${strokeColor}" stroke-width="${strokeWidth}"/>\n`
  } else if (obj.type === "text") {
    const fontSize = Math.max(1, sanitizeNumber(obj.font_size, 16))
    const fontFamily = escapeXml(obj.font_family || "Arial")
    const textContent = escapeXml(obj.text_content || "")
    return `    <text x="${x + width / 2}" y="${y + height / 2}" font-size="${fontSize}" font-family="${fontFamily}" fill="${fillColor}" text-anchor="middle" dominant-baseline="middle">${textContent}</text>\n`
  }
  return ""
}
