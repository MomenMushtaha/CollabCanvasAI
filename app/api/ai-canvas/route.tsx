import { NextResponse } from "next/server"
import { createServerClient } from "@supabase/ssr"
import { createServiceRoleClient } from "@/lib/supabase/service-role"
import { streamText, tool } from "ai"
import { z } from "zod"
import { getObjectsToMove } from "@/lib/group-utils"
import { cookies } from "next/headers"
import { safeFetchHtml } from "@/lib/ssrf"

export const maxDuration = 30

// Simple in-memory rate limiter: max 20 requests per minute per user
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_MAX = 20
const RATE_LIMIT_WINDOW_MS = 60_000

function isRateLimited(userId: string): boolean {
  const now = Date.now()
  const entry = rateLimitMap.get(userId)

  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(userId, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS })
    return false
  }

  entry.count++
  return entry.count > RATE_LIMIT_MAX
}

export async function POST(request: Request) {
  try {
    // Authenticate the request using Supabase session cookies
    const cookieStore = await cookies()
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() {
            return cookieStore.getAll()
          },
          setAll() {},
        },
      },
    )

    const { data: { user }, error: authError } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Rate limit per authenticated user
    if (isRateLimited(user.id)) {
      return NextResponse.json({ error: "Too many requests. Please try again later." }, { status: 429 })
    }

    const body = await request.json()
    const {
      message,
      messages: conversationHistory,
      currentObjects,
      selectedObjectIds,
      selectedObjects: selectedObjectsPayload,
      canvasId,
      userName,
      viewport,
      usableCanvasDimensions,
    } = body

    // Use the authenticated user's ID instead of trusting the request body
    const userId = user.id

    const safeCurrentObjects = Array.isArray(currentObjects) ? currentObjects : []
    const safeSelectedIds = Array.isArray(selectedObjectIds) ? selectedObjectIds : []
    const safeSelectedObjects = Array.isArray(selectedObjectsPayload) ? selectedObjectsPayload : []

    if (!message) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 })
    }

    if (currentObjects && !Array.isArray(currentObjects)) {
      return NextResponse.json(
        { error: "Invalid currentObjects format", details: "currentObjects must be an array" },
        { status: 400 },
      )
    }

    let queueItemId: string | null = null
    if (canvasId && userId && userName) {
      try {
        const supabase = createServiceRoleClient()
        const { data: queueItem, error: queueError } = await supabase
          .from("ai_operations_queue")
          .insert({
            canvas_id: canvasId,
            user_id: userId,
            user_name: userName,
            status: "processing",
            prompt: message,
            started_at: new Date().toISOString(),
          })
          .select()
          .single()

        if (queueError) {
          // [v0] Queue management unavailable (table may not exist):", queueError.message)
        } else {
          queueItemId = queueItem.id
          // [v0] Added to queue with ID:", queueItemId)
        }
      } catch (queueErr) {
        // [v0] Queue management error (continuing without queue):", queueErr)
      }
    }

    // [v0] Calling AI SDK with function calling...")

    const canvasContext = safeCurrentObjects.map((obj: any, idx: number) => {
      const objectId = (() => {
        if (typeof obj.id === "string" && obj.id.length > 0) {
          return obj.id
        }
        if (obj.id !== undefined && obj.id !== null) {
          return String(obj.id)
        }
        return `object-${idx}`
      })()

      const isSelectedFromIds = safeSelectedIds.includes(objectId)
      const isSelectedFromPayload = safeSelectedObjects.some((selected: any) => {
        if (!selected) return false
        if (typeof selected === "string") {
          return selected === objectId
        }
        if (typeof selected?.id === "string" && selected.id.length > 0) {
          return selected.id === objectId
        }
        if (selected?.id !== undefined && selected?.id !== null) {
          return String(selected.id) === objectId
        }
        return false
      })

      const toRoundedNumber = (value: any, fallback = 0) =>
        typeof value === "number" && Number.isFinite(value) ? Math.round(value) : fallback

      return {
        index: idx,
        id: objectId,
        type: obj.type,
        color: obj.fill_color,
        strokeColor: obj.stroke_color,
        strokeWidth: typeof obj.stroke_width === "number" ? obj.stroke_width : undefined,
        x: toRoundedNumber(obj.x),
        y: toRoundedNumber(obj.y),
        width: toRoundedNumber(obj.width),
        height: toRoundedNumber(obj.height),
        rotation: typeof obj.rotation === "number" ? obj.rotation : 0,
        text: obj.text_content || obj.content || "",
        locked: Boolean(obj.locked),
        visible: obj.visible !== false,
        isSelected: isSelectedFromIds || isSelectedFromPayload,
      }
    })

    const selectedContext = canvasContext.filter((obj: any) => obj.isSelected)
    const selectedIndices = selectedContext.map((obj: any) => obj.index)

    const canvasStats = {
      totalShapes: safeCurrentObjects.length,
      shapeTypes: safeCurrentObjects.reduce(
        (acc: any, obj: any) => {
          acc[obj.type] = (acc[obj.type] || 0) + 1
          return acc
        },
        {} as Record<string, number>,
      ),
      colorGroups: safeCurrentObjects.reduce(
        (acc: any, obj: any) => {
          const color = obj.fill_color
          acc[color] = (acc[color] || 0) + 1
          return acc
        },
        {} as Record<string, number>,
      ),
    }

    const canvasWidth = typeof window !== "undefined" ? window.innerWidth : 1920
    const canvasHeight = typeof window !== "undefined" ? window.innerHeight : 1080

    const MIN_ZOOM = 0.1 // Changed from 0 to 0.1 to set minimum zoom to 10%
    const MAX_ZOOM = 3

    const visibleArea = viewport
      ? {
          left: Math.max(0, Math.round(-viewport.x / viewport.zoom)),
          top: Math.max(0, Math.round(-viewport.y / viewport.zoom)),
          right: Math.min(2000, Math.round((-viewport.x + canvasWidth) / viewport.zoom)),
          bottom: Math.min(2000, Math.round((-viewport.y + canvasHeight) / viewport.zoom)),
          width: Math.round(canvasWidth / viewport.zoom),
          height: Math.round(canvasHeight / viewport.zoom),
          centerX: Math.round((-viewport.x + canvasWidth / 2) / viewport.zoom),
          centerY: Math.round((-viewport.y + canvasHeight / 2) / viewport.zoom),
        }
      : {
          left: 0,
          top: 0,
          right: 1920,
          bottom: 1080,
          width: 1920,
          height: 1080,
          centerX: 960,
          centerY: 540,
        }

    const usableArea =
      usableCanvasDimensions && viewport
        ? {
            // Convert panel offsets from screen pixels to canvas coordinates
            leftOffset: Math.round(usableCanvasDimensions.leftOffset / viewport.zoom),
            rightOffset: Math.round(usableCanvasDimensions.rightOffset / viewport.zoom),
            topOffset: Math.round(usableCanvasDimensions.topOffset / viewport.zoom),
            bottomOffset: Math.round(usableCanvasDimensions.bottomOffset / viewport.zoom),
            // Calculate usable bounds
            left: visibleArea.left + Math.round(usableCanvasDimensions.leftOffset / viewport.zoom),
            top: visibleArea.top + Math.round(usableCanvasDimensions.topOffset / viewport.zoom),
            right: visibleArea.right - Math.round(usableCanvasDimensions.rightOffset / viewport.zoom),
            bottom: visibleArea.bottom - Math.round(usableCanvasDimensions.bottomOffset / viewport.zoom),
            // Calculate usable dimensions
            width: Math.round(
              (canvasWidth - usableCanvasDimensions.leftOffset - usableCanvasDimensions.rightOffset) / viewport.zoom,
            ),
            height: Math.round(
              (canvasHeight - usableCanvasDimensions.topOffset - usableCanvasDimensions.bottomOffset) / viewport.zoom,
            ),
            // Calculate center of usable area
            centerX: Math.round(
              (-viewport.x +
                (canvasWidth - usableCanvasDimensions.rightOffset + usableCanvasDimensions.leftOffset) / 2) /
                viewport.zoom,
            ),
            centerY: Math.round(
              (-viewport.y +
                (canvasHeight - usableCanvasDimensions.bottomOffset + usableCanvasDimensions.topOffset) / 2) /
                viewport.zoom,
            ),
          }
        : {
            leftOffset: 0,
            rightOffset: 0,
            topOffset: 0,
            bottomOffset: 0,
            left: visibleArea.left,
            top: visibleArea.top,
            right: visibleArea.right,
            bottom: visibleArea.bottom,
            width: visibleArea.width,
            height: visibleArea.height,
            centerX: visibleArea.centerX,
            centerY: visibleArea.centerY,
          }

    // [v0] Visible area:", visibleArea)
    // [v0] Usable area:", usableArea)

    const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

    const NAMED_COLORS: Record<string, string> = {
      black: "#000000",
      white: "#ffffff",
      red: "#ef4444",
      blue: "#3b82f6",
      green: "#22c55e",
      yellow: "#eab308",
      purple: "#a855f7",
      pink: "#ec4899",
      orange: "#f97316",
      cyan: "#06b6d4",
      teal: "#14b8a6",
      indigo: "#6366f1",
      gray: "#6b7280",
      slate: "#1f2937",
      navy: "#1d4ed8",
    }

    const normalizeColorInput = (input: string | undefined, fallback: string) => {
      if (!input) {
        return fallback
      }

      if (/^#[0-9A-Fa-f]{6}$/.test(input)) {
        return input
      }

      const normalized = input.toLowerCase().trim()
      return NAMED_COLORS[normalized] || fallback
    }

    let operations: any[] = []
    const validationErrors: string[] = []
    const shapeIndexSchema = z.union([z.number(), z.literal("selected")])

    const tools = {
      fetchAndAnalyzeWebsite: tool({
        description:
          "Fetch and analyze a website from a URL to extract design inspiration. Use this when the user provides a URL (like apple.com, stripe.com, etc.) and wants to create a design inspired by it.",
        inputSchema: z.object({
          url: z.string().url().describe("The website URL to fetch and analyze (e.g., https://apple.com)"),
        }),
        execute: async ({ url }) => {
          try {
            // [v0] Fetching website:", url)

            // Fetch the website HTML safely with SSRF protection
            const fetchResult = await safeFetchHtml(url, { maxBytes: 2 * 1024 * 1024, timeoutMs: 8000 })

            if (!fetchResult.ok || !fetchResult.html) {
              return {
                success: false,
                error: fetchResult.error || `Failed to fetch website: ${fetchResult.status} ${fetchResult.statusText}`,
              }
            }

            const html = fetchResult.html

            // Extract design elements from HTML
            const designAnalysis = analyzeWebsiteDesign(html, url)

            // Generate canvas objects inspired by the design
            const inspirationObjects = generateCanvasFromDesign(designAnalysis, usableArea)

            // Add operations to create the inspired design
            inspirationObjects.forEach((obj) => {
              if (obj.type === "text") {
                operations.push({
                  type: "createText",
                  text: obj.text,
                  x: obj.x,
                  y: obj.y,
                  fontSize: obj.fontSize,
                  color: obj.color,
                })
              } else {
                operations.push({
                  type: "create",
                  object: {
                    id: crypto.randomUUID(),
                    type: obj.shapeType,
                    x: obj.x,
                    y: obj.y,
                    width: obj.width,
                    height: obj.height,
                    rotation: 0,
                    fill_color: obj.color,
                    stroke_color: obj.color,
                    stroke_width: 2,
                  },
                })
              }
            })

            return {
              success: true,
              url,
              designAnalysis,
              objectsCreated: inspirationObjects.length,
              message: `Analyzed ${url} and created ${inspirationObjects.length} design elements inspired by it.`,
            }
          } catch (error) {
            // Error fetching website
            return {
              success: false,
              error: `Failed to fetch website: ${error instanceof Error ? error.message : String(error)}`,
            }
          }
        },
      }),
      getCanvasState: tool({
        description:
          "Query information about the current canvas state. Use this to answer questions about shapes, count objects, or get information before making making changes.",
        inputSchema: z.object({
          query: z.string().describe("What information to retrieve (e.g., 'count', 'list all', 'find blue shapes')"),
        }),
        execute: async ({ query }) => {
          return {
            query,
            canvasContext,
            canvasStats,
            selectedObjects: selectedContext,
            availableOperations: Object.keys(tools),
          }
        },
      }),
      createText: tool({
        description: "Create a text layer on the canvas with customizable content, position, size, and color",
        inputSchema: z.object({
          text: z.string().describe("The text content to display"),
          x: z.number().optional().describe("X coordinate position on the canvas"),
          y: z.number().optional().describe("Y coordinate position on the canvas"),
          fontSize: z.number().optional().describe("Font size in pixels (default: 16)"),
          color: z.string().optional().describe("Text color as hex code (e.g., #000000 for black)"),
        }),
        execute: async ({ text, x, y, fontSize, color }) => {
          const validation = validateCreateText({ text, x, y, fontSize, color })
          if (!validation.valid) {
            validationErrors.push(`createText: ${validation.error}`)
            return { error: validation.error }
          }

          const finalColor = normalizeColorInput(color, "#000000")
          const finalX = x !== undefined ? x : usableArea.centerX
          const finalY = y !== undefined ? y : usableArea.centerY

          operations.push({
            type: "createText",
            text,
            x: finalX,
            y: finalY,
            fontSize: fontSize || 16,
            color: finalColor,
          })

          return {
            success: true,
            text,
            x: finalX,
            y: finalY,
            fontSize: fontSize || 16,
            color: finalColor,
          }
        },
      }),
      createShape: tool({
        description: "Create a new shape on the canvas",
        inputSchema: z.object({
          shape: z.enum(["rectangle", "circle", "triangle", "line"]).describe("The type of shape to create"),
          x: z.number().optional().describe("X coordinate position on the canvas"),
          y: z.number().optional().describe("Y coordinate position on the canvas"),
          width: z.number().describe("Width of the shape in pixels"),
          height: z.number().describe("Height of the shape in pixels"),
          color: z.string().describe("Hex color code (e.g., #ff0000 for red, #3b82f6 for blue)"),
        }),
        execute: async ({ shape, x, y, width, height, color }) => {
          const validation = validateCreateShape({ shape, x, y, width, height, color })
          if (!validation.valid) {
            validationErrors.push(`createShape: ${validation.error}`)
            return { error: validation.error }
          }

          const finalColor = normalizeColorInput(color, "#3b82f6")
          const finalX = x !== undefined ? x : usableArea.centerX
          const finalY = y !== undefined ? y : usableArea.centerY

          operations.push({
            type: "create",
            object: {
              id: crypto.randomUUID(),
              type: shape,
              x: finalX,
              y: finalY,
              width,
              height,
              rotation: 0,
              fill_color: finalColor,
              stroke_color: finalColor,
              stroke_width: 2,
            },
          })

          return {
            success: true,
            shape,
            x: finalX,
            y: finalY,
            width,
            height,
            color: finalColor,
          }
        },
      }),
      moveShape: tool({
        description:
          "Move one or more existing shapes to a new position. If a shape is part of a group, the entire group will move together.",
        inputSchema: z.object({
          shapeIdentifier: z
            .union([
              z.number(),
              z.literal("selected"),
              z.object({
                type: z.enum(["rectangle", "circle", "triangle", "line", "group"]),
                color: z.string().optional(),
              }),
            ])
            .describe(
              "Identifier for the shape(s) to move. Can be an index (0-based, -1 for last), 'selected', or an object specifying shape type and optional color (e.g., { type: 'circle', color: '#ff0000' }). Note: Moving a shape that's part of a group will move the entire group.",
            ),
          x: z.number().optional().describe("New X coordinate (absolute position)"),
          y: z.number().optional().describe("New Y coordinate (absolute position)"),
          deltaX: z.number().optional().describe("Relative X movement (alternative to absolute x)"),
          deltaY: z.number().optional().describe("Relative Y movement (alternative to absolute y)"),
          applyToAll: z
            .boolean()
            .optional()
            .describe(
              "If true and shapeIdentifier is a type, apply to ALL shapes of that type. Use this when user says 'all the triangles', 'all circles', etc.",
            ),
        }),
        execute: async ({ shapeIdentifier, x, y, deltaX, deltaY, applyToAll }) => {
          let resolvedShapeIndices: number[] = []

          if (typeof shapeIdentifier === "number" || shapeIdentifier === "selected") {
            const indexResult = resolveShapeIndex(shapeIdentifier, selectedIndices, safeCurrentObjects.length)
            if (!indexResult.valid) {
              validationErrors.push(`moveShape: ${indexResult.error}`)
              return { error: indexResult.error }
            }
            const objectId = safeCurrentObjects[indexResult.shapeIndex]?.id
            if (objectId) {
              const objectsToMove = getObjectsToMove(objectId, safeCurrentObjects)
              resolvedShapeIndices = objectsToMove
                .map((id) => safeCurrentObjects.findIndex((obj) => obj.id === id))
                .filter((idx) => idx !== -1)
            } else {
              resolvedShapeIndices = [indexResult.shapeIndex]
            }
          } else if (typeof shapeIdentifier === "object" && shapeIdentifier.type) {
            const matchingShapes = canvasContext.filter(
              (obj) =>
                obj.type === shapeIdentifier.type &&
                (!shapeIdentifier.color || obj.color === normalizeColorInput(shapeIdentifier.color, "")),
            )

            if (matchingShapes.length === 0) {
              validationErrors.push(
                `moveShape: No ${shapeIdentifier.color ? `${shapeIdentifier.color} ` : ""}${shapeIdentifier.type} found on the canvas.`,
              )
              return {
                error: `No ${shapeIdentifier.color ? `${shapeIdentifier.color} ` : ""}${shapeIdentifier.type} found on the canvas.`,
              }
            } else if (matchingShapes.length > 1 && !applyToAll) {
              const clarification = `Which ${shapeIdentifier.type}? I see ${matchingShapes.map((s, i) => `${i === 0 ? "an" : "a"} ${s.color} ${s.type}`).join(", ")}. Or did you mean all of them?`
              validationErrors.push(`moveShape: Ambiguous request. ${clarification}`)
              return { error: clarification }
            } else {
              const allIndicesToMove = new Set<number>()
              for (const shape of matchingShapes) {
                const objectId = safeCurrentObjects[shape.index]?.id
                if (objectId) {
                  const objectsToMove = getObjectsToMove(objectId, safeCurrentObjects)
                  objectsToMove.forEach((id) => {
                    const idx = safeCurrentObjects.findIndex((obj) => obj.id === id)
                    if (idx !== -1) allIndicesToMove.add(idx)
                  })
                } else {
                  allIndicesToMove.add(shape.index)
                }
              }
              resolvedShapeIndices = Array.from(allIndicesToMove)
            }
          } else {
            validationErrors.push("moveShape: Invalid shapeIdentifier provided.")
            return { error: "Invalid shapeIdentifier provided. Must be an index, 'selected', or an object with type." }
          }

          if (resolvedShapeIndices.length === 0) {
            validationErrors.push("moveShape: Could not resolve shape index.")
            return { error: "Could not resolve shape index." }
          }

          for (const shapeIndex of resolvedShapeIndices) {
            const validation = validateMoveShape(
              { shapeIndex, x, y, deltaX, deltaY },
              safeCurrentObjects,
              selectedIndices,
            )
            if (!validation.valid) {
              validationErrors.push(`moveShape: ${validation.error}`)
              return { error: validation.error }
            }

            operations.push({
              type: "move",
              shapeIndex: validation.shapeIndex,
              x,
              y,
              deltaX,
              deltaY,
            })
          }

          return {
            success: true,
            shapeIndices: resolvedShapeIndices,
            x,
            y,
            deltaX,
            deltaY,
            count: resolvedShapeIndices.length,
            message: `Moved ${resolvedShapeIndices.length} shape${resolvedShapeIndices.length > 1 ? "s" : ""}${resolvedShapeIndices.length > 1 ? " (including group members)" : ""}`,
          }
        },
      }),
      resizeShape: tool({
        description: "Resize one or more existing shapes",
        inputSchema: z.object({
          shapeIdentifier: z
            .union([
              z.number(),
              z.literal("selected"),
              z.object({ type: z.enum(["rectangle", "circle", "triangle", "line"]), color: z.string().optional() }),
            ])
            .describe(
              "Identifier for the shape(s) to resize. Can be an index (0-based, -1 for last), 'selected', or an object specifying shape type and optional color (e.g., { type: 'circle', color: '#ff0000' }).",
            ),
          width: z.number().optional().describe("New width in pixels (absolute size)"),
          height: z.number().optional().describe("New height in pixels (absolute size)"),
          scale: z.number().optional().describe("Scale factor (e.g., 2 for twice as big, 0.5 for half size)"),
          applyToAll: z
            .boolean()
            .optional()
            .describe(
              "If true and shapeIdentifier is a type, apply to ALL shapes of that type. Use this when user says 'all the triangles', 'all circles', etc.",
            ),
        }),
        execute: async ({ shapeIdentifier, width, height, scale, applyToAll }) => {
          let resolvedShapeIndices: number[] = []

          if (typeof shapeIdentifier === "number" || shapeIdentifier === "selected") {
            const indexResult = resolveShapeIndex(shapeIdentifier, selectedIndices, safeCurrentObjects.length)
            if (!indexResult.valid) {
              validationErrors.push(`resizeShape: ${indexResult.error}`)
              return { error: indexResult.error }
            }
            resolvedShapeIndices = [indexResult.shapeIndex]
          } else if (typeof shapeIdentifier === "object" && shapeIdentifier.type) {
            const matchingShapes = canvasContext.filter(
              (obj) =>
                obj.type === shapeIdentifier.type &&
                (!shapeIdentifier.color || obj.color === normalizeColorInput(shapeIdentifier.color, "")),
            )

            if (matchingShapes.length === 0) {
              validationErrors.push(
                `resizeShape: No ${shapeIdentifier.color ? `${shapeIdentifier.color} ` : ""}${shapeIdentifier.type} found on the canvas.`,
              )
              return {
                error: `No ${shapeIdentifier.color ? `${shapeIdentifier.color} ` : ""}${shapeIdentifier.type} found on the canvas.`,
              }
            } else if (matchingShapes.length > 1 && !applyToAll) {
              const clarification = `Which ${shapeIdentifier.type}? I see ${matchingShapes.map((s, i) => `${i === 0 ? "an" : "a"} ${s.color} ${s.type}`).join(", ")}. Or did you mean all of them?`
              validationErrors.push(`resizeShape: Ambiguous request. ${clarification}`)
              return { error: clarification }
            } else {
              resolvedShapeIndices = matchingShapes.map((s) => s.index)
            }
          } else {
            validationErrors.push("resizeShape: Invalid shapeIdentifier provided.")
            return { error: "Invalid shapeIdentifier provided. Must be an index, 'selected', or an object with type." }
          }

          if (resolvedShapeIndices.length === 0) {
            validationErrors.push("resizeShape: Could not resolve shape index.")
            return { error: "Could not resolve shape index." }
          }

          for (const shapeIndex of resolvedShapeIndices) {
            const validation = validateResizeShape(
              { shapeIndex, width, height, scale },
              safeCurrentObjects,
              selectedIndices,
            )
            if (!validation.valid) {
              validationErrors.push(`resizeShape: ${validation.error}`)
              return { error: validation.error }
            }

            operations.push({
              type: "resize",
              shapeIndex: validation.shapeIndex,
              width,
              height,
              scale,
            })
          }

          return {
            success: true,
            shapeIndices: resolvedShapeIndices,
            width,
            height,
            scale,
            count: resolvedShapeIndices.length,
            message: `Resized ${resolvedShapeIndices.length} shape${resolvedShapeIndices.length > 1 ? "s" : ""}`,
          }
        },
      }),
      rotateShape: tool({
        description: "Rotate one or more existing shapes",
        inputSchema: z.object({
          shapeIdentifier: z
            .union([
              z.number(),
              z.literal("selected"),
              z.object({ type: z.enum(["rectangle", "circle", "triangle", "line"]), color: z.string().optional() }),
            ])
            .describe(
              "Identifier for the shape(s) to rotate. Can be an index (0-based, -1 for last), 'selected', or an object specifying shape type and optional color (e.g., { type: 'circle', color: '#ff0000' }).",
            ),
          degrees: z.number().describe("Rotation amount in degrees"),
          absolute: z
            .boolean()
            .optional()
            .describe("If true, set absolute rotation; if false, rotate relative to current rotation"),
          applyToAll: z
            .boolean()
            .optional()
            .describe(
              "If true and shapeIdentifier is a type, apply to ALL shapes of that type. Use this when user says 'all the triangles', 'all circles', etc.",
            ),
        }),
        execute: async ({ shapeIdentifier, degrees, absolute, applyToAll }) => {
          let resolvedShapeIndices: number[] = []

          if (typeof shapeIdentifier === "number" || shapeIdentifier === "selected") {
            const indexResult = resolveShapeIndex(shapeIdentifier, selectedIndices, safeCurrentObjects.length)
            if (!indexResult.valid) {
              validationErrors.push(`rotateShape: ${indexResult.error}`)
              return { error: indexResult.error }
            }
            resolvedShapeIndices = [indexResult.shapeIndex]
          } else if (typeof shapeIdentifier === "object" && shapeIdentifier.type) {
            const matchingShapes = canvasContext.filter(
              (obj) =>
                obj.type === shapeIdentifier.type &&
                (!shapeIdentifier.color || obj.color === normalizeColorInput(shapeIdentifier.color, "")),
            )

            if (matchingShapes.length === 0) {
              validationErrors.push(
                `rotateShape: No ${shapeIdentifier.color ? `${shapeIdentifier.color} ` : ""}${shapeIdentifier.type} found on the canvas.`,
              )
              return {
                error: `No ${shapeIdentifier.color ? `${shapeIdentifier.color} ` : ""}${shapeIdentifier.type} found on the canvas.`,
              }
            } else if (matchingShapes.length > 1 && !applyToAll) {
              const clarification = `Which ${shapeIdentifier.type}? I see ${matchingShapes.map((s, i) => `${i === 0 ? "an" : "a"} ${s.color} ${s.type}`).join(", ")}. Or did you mean all of them?`
              validationErrors.push(`rotateShape: Ambiguous request. ${clarification}`)
              return { error: clarification }
            } else {
              resolvedShapeIndices = matchingShapes.map((s) => s.index)
            }
          } else {
            validationErrors.push("rotateShape: Invalid shapeIdentifier provided.")
            return { error: "Invalid shapeIdentifier provided. Must be an index, 'selected', or an object with type." }
          }

          if (resolvedShapeIndices.length === 0) {
            validationErrors.push("rotateShape: Could not resolve shape index.")
            return { error: "Could not resolve shape index." }
          }

          for (const shapeIndex of resolvedShapeIndices) {
            const validation = validateRotateShape(
              { shapeIndex, degrees, absolute },
              safeCurrentObjects,
              selectedIndices,
            )
            if (!validation.valid) {
              validationErrors.push(`rotateShape: ${validation.error}`)
              return { error: validation.error }
            }

            operations.push({
              type: "rotate",
              shapeIndex: validation.shapeIndex,
              degrees: degrees ?? 0,
              absolute: absolute ?? false,
            })
          }

          return {
            success: true,
            shapeIndices: resolvedShapeIndices,
            degrees,
            absolute,
            count: resolvedShapeIndices.length,
            message: `Rotated ${resolvedShapeIndices.length} shape${resolvedShapeIndices.length > 1 ? "s" : ""}`,
          }
        },
      }),
      deleteShape: tool({
        description: "Delete one or more shapes from the canvas",
        inputSchema: z.object({
          shapeIdentifier: z
            .union([
              z.number(),
              z.literal("selected"),
              z.object({ type: z.enum(["rectangle", "circle", "triangle", "line"]), color: z.string().optional() }),
            ])
            .optional()
            .describe(
              "Identifier for the shape(s) to delete. Can be an index (0-based, -1 for last), 'selected', or an object specifying shape type and optional color. If omitted and 'all' is false, deletes the selected shape.",
            ),
          all: z.boolean().optional().describe("If true, delete all shapes from the canvas"),
        }),
        execute: async ({ shapeIdentifier, all }) => {
          if (all) {
            operations.push({
              type: "delete",
              all: true,
            })
            return { success: true, all: true }
          }

          let resolvedShapeIndex: number | undefined
          let shapeToDelete: string | undefined

          if (shapeIdentifier === undefined || shapeIdentifier === "selected") {
            if (selectedIndices.length === 0) {
              validationErrors.push(
                "deleteShape: No shape selected and no identifier provided. Please select a shape or provide an identifier.",
              )
              return {
                error: "No shape selected and no identifier provided. Please select a shape or provide an identifier.",
              }
            }
            resolvedShapeIndex = selectedIndices[0]
            shapeToDelete = "selected shape"
          } else if (typeof shapeIdentifier === "number" || shapeIdentifier === "selected") {
            // This case is already covered by the above, but keeping for clarity if logic evolves
            const indexResult = resolveShapeIndex(shapeIdentifier, selectedIndices, safeCurrentObjects.length)
            if (!indexResult.valid) {
              validationErrors.push(`deleteShape: ${indexResult.error}`)
              return { error: indexResult.error }
            }
            resolvedShapeIndex = indexResult.shapeIndex
            shapeToDelete = `shape at index ${resolvedShapeIndex}`
          } else if (typeof shapeIdentifier === "object" && shapeIdentifier.type) {
            const matchingShapes = canvasContext.filter(
              (obj) =>
                obj.type === shapeIdentifier.type &&
                (!shapeIdentifier.color || obj.color === normalizeColorInput(shapeIdentifier.color, "")),
            )

            if (matchingShapes.length === 0) {
              validationErrors.push(
                `deleteShape: No ${shapeIdentifier.color ? `${shapeIdentifier.color} ` : ""}${shapeIdentifier.type} found on the canvas.`,
              )
              return {
                error: `No ${shapeIdentifier.color ? `${shapeIdentifier.color} ` : ""}${shapeIdentifier.type} found on the canvas.`,
              }
            } else if (matchingShapes.length > 1) {
              const clarification = `Which ${shapeIdentifier.type}? I see ${matchingShapes.map((s, i) => `${i === 0 ? "an" : "a"} ${s.color} ${s.type}`).join(", ")}.`
              validationErrors.push(`deleteShape: Ambiguous request. ${clarification}`)
              return { error: clarification }
            } else {
              resolvedShapeIndex = matchingShapes[0].index
              shapeToDelete = `the ${shapeIdentifier.color ? `${shapeIdentifier.color} ` : ""}${shapeIdentifier.type}`
            }
          } else {
            validationErrors.push("deleteShape: Invalid shapeIdentifier provided.")
            return { error: "Invalid shapeIdentifier provided. Must be an index, 'selected', or an object with type." }
          }

          if (resolvedShapeIndex === undefined) {
            validationErrors.push(`deleteShape: Could not resolve shape identifier for "${shapeToDelete}".`)
            return { error: `Could not resolve shape identifier for "${shapeToDelete}".` }
          }

          operations.push({
            type: "delete",
            shapeIndex: resolvedShapeIndex,
            all: false,
          })

          return { success: true, shapeIndex: resolvedShapeIndex, all: false, message: `Deleted ${shapeToDelete}.` }
        },
      }),
      deleteShapesByType: tool({
        description:
          "Delete all shapes of a specific type (e.g., all rectangles, all circles). Use this when user asks to delete shapes by type.",
        inputSchema: z.object({
          shapeType: z
            .enum(["rectangle", "circle", "triangle", "line", "text"])
            .describe("The type of shapes to delete"),
        }),
        execute: async ({ shapeType }) => {
          const matchingIndices = canvasContext
            .filter((obj: any) => obj.type === shapeType)
            .map((obj: any) => obj.index)

          if (matchingIndices.length === 0) {
            return {
              success: false,
              error: `No ${shapeType} shapes found on the canvas.`,
              deletedCount: 0,
            }
          }

          matchingIndices.reverse().forEach((index: number) => {
            operations.push({
              type: "delete",
              shapeIndex: index,
              all: false,
            })
          })

          return {
            success: true,
            shapeType,
            deletedCount: matchingIndices.length,
            message: `Deleted ${matchingIndices.length} ${shapeType}${matchingIndices.length > 1 ? "s" : ""}`,
          }
        },
      }),
      deleteShapesByColor: tool({
        description: "Delete all shapes of a specific color. Use this when user asks to delete shapes by color.",
        inputSchema: z.object({
          color: z.string().describe("The color to match (hex code like #ff0000 or color name like 'red')"),
        }),
        execute: async ({ color }) => {
          const normalizedColor = normalizeColorInput(color, "")

          const matchingIndices = canvasContext
            .filter((obj: any) => obj.color === normalizedColor || obj.strokeColor === normalizedColor)
            .map((obj: any) => obj.index)

          if (matchingIndices.length === 0) {
            return {
              success: false,
              error: `No shapes with color ${color} found on the canvas.`,
              deletedCount: 0,
            }
          }

          matchingIndices.reverse().forEach((index: number) => {
            operations.push({
              type: "delete",
              shapeIndex: index,
              all: false,
            })
          })

          return {
            success: true,
            color: normalizedColor,
            deletedCount: matchingIndices.length,
            message: `Deleted ${matchingIndices.length} shape${matchingIndices.length > 1 ? "s" : ""} with color ${color}`,
          }
        },
      }),
      arrangeShapes: tool({
        description: "Arrange multiple shapes in a pattern (grid, row, column, circle)",
        inputSchema: z.object({
          pattern: z.enum(["grid", "row", "column", "circle"]).describe("The arrangement pattern"),
          shapeIdentifiers: z
            .array(
              z.union([
                z.number(),
                z.literal("selected"),
                z.object({ type: z.enum(["rectangle", "circle", "triangle", "line"]), color: z.string().optional() }),
              ]),
            )
            .optional()
            .describe(
              "Identifiers of shapes to arrange (empty array means all shapes). Each identifier can be an index, 'selected', or an object specifying shape type and optional color.",
            ),
          spacing: z.number().optional().describe("Spacing between shapes in pixels"),
          columns: z.number().optional().describe("Number of columns (for grid pattern)"),
        }),
        execute: async ({ pattern, shapeIdentifiers, spacing, columns }) => {
          let resolvedShapeIndices: number[] = []

          if (!shapeIdentifiers || shapeIdentifiers.length === 0) {
            resolvedShapeIndices = canvasContext.map((obj) => obj.index)
          } else {
            for (const identifier of shapeIdentifiers) {
              let resolvedIndex: number | undefined
              if (typeof identifier === "number" || identifier === "selected") {
                const indexResult = resolveShapeIndex(identifier, selectedIndices, safeCurrentObjects.length)
                if (!indexResult.valid) {
                  validationErrors.push(`arrangeShapes: ${indexResult.error}`)
                  return { error: indexResult.error }
                }
                resolvedIndex = indexResult.shapeIndex
              } else if (typeof identifier === "object" && identifier.type) {
                const matchingShapes = canvasContext.filter(
                  (obj) =>
                    obj.type === identifier.type &&
                    (!identifier.color || obj.color === normalizeColorInput(identifier.color, "")),
                )
                if (matchingShapes.length === 0) {
                  validationErrors.push(
                    `arrangeShapes: No ${identifier.color ? `${identifier.color} ` : ""}${identifier.type} found.`,
                  )
                  return { error: `No ${identifier.color ? `${identifier.color} ` : ""}${identifier.type} found.` }
                } else if (matchingShapes.length > 1) {
                  const clarification = `Which ${identifier.type}? I see ${matchingShapes.map((s, i) => `${i === 0 ? "an" : "a"} ${s.color} ${s.type}`).join(", ")}.`
                  validationErrors.push(`arrangeShapes: Ambiguous request for ${identifier.type}. ${clarification}`)
                  return { error: clarification }
                } else {
                  resolvedIndex = matchingShapes[0].index
                }
              } else {
                validationErrors.push("arrangeShapes: Invalid shapeIdentifier provided.")
                return {
                  error: "Invalid shapeIdentifier provided. Must be an index, 'selected', or an object with type.",
                }
              }
              if (resolvedIndex !== undefined) {
                resolvedShapeIndices.push(resolvedIndex)
              }
            }
            // Remove duplicates if any
            resolvedShapeIndices = Array.from(new Set(resolvedShapeIndices))
          }

          if (resolvedShapeIndices.length === 0) {
            return { valid: false, error: "No shapes found to arrange." }
          }

          const validation = validateArrangeShapes(
            { pattern, shapeIndices: resolvedShapeIndices, spacing, columns },
            safeCurrentObjects,
          )
          if (!validation.valid) {
            validationErrors.push(`arrangeShapes: ${validation.error}`)
            return { error: validation.error }
          }

          operations.push({
            type: "arrange",
            pattern,
            shapeIndices: resolvedShapeIndices,
            spacing: spacing || 50,
            columns,
          })

          return { success: true, pattern, shapeIndices: resolvedShapeIndices, spacing, columns }
        },
      }),
      createLoginForm: tool({
        description:
          "Create a polished login form with title, username/password fields, and a primary action button arranged vertically.",
        inputSchema: z.object({
          x: z.number().optional().describe("Center X coordinate for the form"),
          y: z.number().optional().describe("Center Y coordinate for the form"),
          title: z.string().optional().describe("Heading text to display above the form"),
          subtitle: z.string().optional().describe("Optional supporting text shown below the title"),
          primaryColor: z.string().optional().describe("Accent color for the button (hex code or common color name)"),
        }),
        execute: async ({ x, y, title, subtitle, primaryColor }) => {
          const formWidth = 360
          const formHeight = 320

          const finalX = x !== undefined ? x : usableArea.centerX
          const finalY = y !== undefined ? y : usableArea.centerY

          const buttonColor = normalizeColorInput(primaryColor, "#3b82f6")

          operations.push({
            type: "createLoginForm",
            x: finalX,
            y: finalY,
            width: formWidth,
            height: formHeight,
            titleText: title || "Welcome back",
            subtitleText: subtitle || "Please sign in to continue",
            usernameLabel: "Email",
            passwordLabel: "Password",
            buttonText: "Sign In",
            backgroundColor: "#ffffff",
            fieldColor: "#f3f4f6",
            buttonColor,
            buttonTextColor: "#ffffff",
            textColor: "#111827",
            mutedTextColor: "#6b7280",
            helpText: "Forgot password?",
          })

          return { success: true, x: finalX, y: finalY, width: formWidth, height: formHeight }
        },
      }),

      createNavigationBar: tool({
        description:
          "Create a horizontal navigation bar with a brand label and evenly spaced menu items across the top of the canvas.",
        inputSchema: z.object({
          items: z.number().int().min(2).max(8).optional().describe("How many navigation items to include (2-8)"),
          x: z.number().optional().describe("Center X coordinate for the navigation bar"),
          y: z.number().optional().describe("Top Y coordinate for the navigation bar (defaults to top of view)"),
          brand: z.string().optional().describe("Brand or product name to show on the left"),
          accentColor: z.string().optional().describe("Highlight color for the active navigation item"),
        }),
        execute: async ({ items, x, y, brand, accentColor }) => {
          const navItems = clamp(items ?? 4, 2, 8)
          const navWidth = Math.max(420, Math.min(960, navItems * 140))
          const navHeight = 64

          const finalX = x !== undefined ? x : usableArea.centerX
          const finalY = y !== undefined ? y : usableArea.top + navHeight / 2 + 20

          const leftX = finalX - navWidth / 2
          const topY = finalY - navHeight / 2
          const highlightColor = normalizeColorInput(accentColor, "#3b82f6")

          operations.push({
            type: "createNavBar",
            x: leftX,
            y: topY,
            width: navWidth,
            height: navHeight,
            items: navItems,
            brandText: brand || "Product",
            menuItems: Array.from({ length: navItems }, (_, index) => (index === 0 ? "Home" : `Item ${index + 1}`)),
            backgroundColor: "#111827",
            itemColor: "#1f2937",
            activeItemColor: highlightColor,
            textColor: "#f9fafb",
          })

          return { success: true, x: leftX, y: topY, width: navWidth, height: navHeight, items: navItems }
        },
      }),
      createCardLayout: tool({
        description:
          "Create a content card with an image placeholder, title, description text, and call-to-action button.",
        inputSchema: z.object({
          x: z.number().optional().describe("Center X coordinate for the card"),
          y: z.number().optional().describe("Center Y coordinate for the card"),
          title: z.string().optional().describe("Title text inside the card"),
          description: z.string().optional().describe("Supporting description text for the card"),
          buttonText: z.string().optional().describe("Call-to-action label for the card button"),
          accentColor: z.string().optional().describe("Accent color for the media area and button"),
        }),
        execute: async ({ x, y, title, description, buttonText, accentColor }) => {
          const cardWidth = 320
          const cardHeight = 220

          const finalX = x !== undefined ? x : usableArea.centerX
          const finalY = y !== undefined ? y : usableArea.centerY

          const accent = normalizeColorInput(accentColor, "#3b82f6")

          operations.push({
            type: "createCard",
            x: finalX,
            y: finalY,
            width: cardWidth,
            height: cardHeight,
            titleText: title || "Card title",
            descriptionText: description || "Add supporting details here.",
            buttonText: buttonText || "Learn more",
            accentColor: accent,
            backgroundColor: "#ffffff",
            textColor: "#111827",
            mutedTextColor: "#6b7280",
            buttonTextColor: "#ffffff",
          })

          return { success: true, x: finalX, y: finalY, width: cardWidth, height: cardHeight }
        },
      }),

      createDashboard: tool({
        description:
          "Create a complete, professional dashboard layout with header, metric cards, charts, and data sections. Use this when the user asks for a dashboard, analytics view, or admin panel.",
        inputSchema: z.object({
          title: z.string().optional().describe("Dashboard title (e.g., 'Sales Dashboard', 'Analytics Overview')"),
          metrics: z
            .array(
              z.object({
                label: z.string().describe("Metric label (e.g., 'Total Revenue', 'Active Users')"),
                value: z.string().describe("Metric value (e.g., '$45,231', '1,234')"),
                trend: z.enum(["up", "down", "neutral"]).optional().describe("Trend indicator"),
                trendValue: z.string().optional().describe("Trend percentage (e.g., '+12%', '-5%')"),
              }),
            )
            .optional()
            .describe("Array of metric cards to display (2-6 recommended)"),
          charts: z
            .array(
              z.object({
                type: z.enum(["bar", "line", "pie", "area"]).describe("Type of chart (bar, line, pie, or area chart)"),
                title: z.string().describe("Chart title"),
                width: z.enum(["half", "full"]).optional().describe("Chart width (half or full width)"),
              }),
            )
            .optional()
            .describe("Array of charts to include (1-4 recommended)"),
          colorScheme: z
            .enum(["blue", "purple", "green", "orange", "dark"])
            .optional()
            .describe("Color scheme for the dashboard"),
          layout: z.enum(["modern", "classic", "minimal"]).optional().describe("Dashboard layout style"),
        }),
        execute: async ({ title, metrics, charts, colorScheme, layout }) => {
          // ⭐⭐⭐ UPDATED DASHBOARD CREATION LOGIC ⭐⭐⭐
          // Always create the dashboard immediately with sensible defaults,
          // unless the user provides specific customization.

          let dashboardTitle = title || "Dashboard"
          let dashboardMetrics: any[] = []
          let dashboardCharts: any[] = []
          const scheme = colorScheme || "blue" // Default color scheme
          const layoutStyle = layout || "modern" // Default layout

          // Determine dashboard type and set defaults based on title or user input context
          if (title?.toLowerCase().includes("sales")) {
            dashboardTitle = title || "Sales Dashboard"
            dashboardMetrics = metrics || [
              { label: "Total Revenue", value: "$45,231", trend: "up", trendValue: "+12%" },
              { label: "Total Orders", value: "1,234", trend: "up", trendValue: "+8%" },
              { label: "Conversion Rate", value: "3.24%", trend: "down", trendValue: "-2%" },
              { label: "Avg. Order Value", value: "$127", trend: "neutral" },
            ]
            dashboardCharts = charts || [
              { type: "line", title: "Revenue Over Time", width: "full" },
              { type: "bar", title: "Sales by Category", width: "half" },
            ]
          } else if (title?.toLowerCase().includes("analytics")) {
            dashboardTitle = title || "Analytics Overview"
            dashboardMetrics = metrics || [
              { label: "Total Users", value: "1.5M", trend: "up", trendValue: "+15%" },
              { label: "Active Users", value: "150K", trend: "up", trendValue: "+10%" },
              { label: "Page Views", value: "10M", trend: "up", trendValue: "+25%" },
              { label: "Bounce Rate", value: "45%", trend: "down", trendValue: "-5%" },
            ]
            dashboardCharts = charts || [
              { type: "line", title: "Traffic Over Time", width: "full" },
              { type: "pie", title: "Traffic Sources", width: "half" },
            ]
          } else if (title?.toLowerCase().includes("admin panel") || title?.toLowerCase().includes("admin dashboard")) {
            dashboardTitle = title || "Admin Panel"
            dashboardMetrics = metrics || [
              { label: "Total Users", value: "2.1M", trend: "up", trendValue: "+18%" },
              { label: "Active Sessions", value: "5K", trend: "up", trendValue: "+7%" },
              { label: "System Load", value: "65%", trend: "neutral" },
              { label: "Storage Used", value: "750GB", trend: "up", trendValue: "+5%" },
            ]
            dashboardCharts = charts || [
              { type: "line", title: "User Activity", width: "full" },
              { type: "bar", title: "User Distribution", width: "half" },
            ]
          } else if (title?.toLowerCase().includes("e-commerce")) {
            dashboardTitle = title || "E-commerce Dashboard"
            dashboardMetrics = metrics || [
              { label: "Total Sales", value: "$1.2M", trend: "up", trendValue: "+14%" },
              { label: "Total Orders", value: "25K", trend: "up", trendValue: "+11%" },
              { label: "Total Customers", value: "50K", trend: "up", trendValue: "+9%" },
              { label: "Revenue", value: "$980K", trend: "up", trendValue: "+13%" },
            ]
            dashboardCharts = charts || [
              { type: "line", title: "Sales Trend", width: "full" },
              { type: "bar", title: "Top Selling Products", width: "half" },
            ]
          } else if (!title && !metrics && !charts) {
            // If the request is just "create a dashboard", ask for clarification
            validationErrors.push(
              "Dashboard type is ambiguous. Please specify the type of dashboard (e.g., 'sales dashboard', 'analytics dashboard', 'admin panel', 'e-commerce dashboard').",
            )
            return {
              error:
                "Dashboard type is ambiguous. Please specify the type of dashboard (e.g., 'sales dashboard', 'analytics dashboard', 'admin panel', 'e-commerce dashboard').",
            }
          } else {
            // Fallback for generic dashboards or if specific types aren't matched
            dashboardTitle = title || "Dashboard"
            dashboardMetrics = metrics || [
              { label: "Metric 1", value: "100", trend: "up", trendValue: "+10%" },
              { label: "Metric 2", value: "200", trend: "down", trendValue: "-5%" },
              { label: "Metric 3", value: "300", trend: "neutral" },
              { label: "Metric 4", value: "400", trend: "up", trendValue: "+15%" },
            ]
            dashboardCharts = charts || [
              { type: "line", title: "Data Trend", width: "full" },
              { type: "bar", title: "Category Distribution", width: "half" },
            ]
          }

          // Color schemes
          const colorSchemes = {
            blue: { primary: "#3b82f6", secondary: "#60a5fa", accent: "#2563eb", bg: "#eff6ff" },
            purple: { primary: "#a855f7", secondary: "#c084fc", accent: "#9333ea", bg: "#faf5ff" },
            green: { primary: "#22c55e", secondary: "#4ade80", accent: "#16a34a", bg: "#f0fdf4" },
            orange: { primary: "#f97316", secondary: "#fb923c", accent: "#ea580c", bg: "#fff7ed" },
            dark: { primary: "#1f2937", secondary: "#374151", accent: "#111827", bg: "#f9fafb" },
          }

          const colors = colorSchemes[scheme]

          // Calculate layout dimensions
          const dashboardWidth = usableArea.width * 0.9
          const startX = usableArea.left + (usableArea.width - dashboardWidth) / 2
          const startY = usableArea.top + 80

          // Create dashboard header
          operations.push({
            type: "createText",
            text: dashboardTitle,
            x: startX + 40,
            y: startY,
            fontSize: 32,
            color: "#111827",
          })

          // Create metric cards
          const metricCardWidth = (dashboardWidth - (dashboardMetrics.length - 1) * 20) / dashboardMetrics.length
          const metricCardHeight = 120
          const metricsY = startY + 80

          dashboardMetrics.forEach((metric, index) => {
            const cardX = startX + index * (metricCardWidth + 20)

            // Card background
            operations.push({
              type: "create",
              object: {
                id: crypto.randomUUID(),
                type: "rectangle",
                x: cardX,
                y: metricsY,
                width: metricCardWidth,
                height: metricCardHeight,
                rotation: 0,
                fill_color: "#ffffff",
                stroke_color: "#e5e7eb",
                stroke_width: 1,
              },
            })

            // Metric label
            operations.push({
              type: "createText",
              text: metric.label,
              x: cardX + 20,
              y: metricsY + 20,
              fontSize: 14,
              color: "#6b7280",
            })

            // Metric value
            operations.push({
              type: "createText",
              text: metric.value,
              x: cardX + 20,
              y: metricsY + 50,
              fontSize: 28,
              color: "#111827",
            })

            // Trend indicator
            if (metric.trend && metric.trendValue) {
              const trendColor = metric.trend === "up" ? "#22c55e" : metric.trend === "down" ? "#ef4444" : "#6b7280"
              operations.push({
                type: "createText",
                text: metric.trendValue,
                x: cardX + 20,
                y: metricsY + 85,
                fontSize: 14,
                color: trendColor,
              })
            }
          })

          // Create charts
          const chartsY = metricsY + metricCardHeight + 40
          let currentChartX = startX
          let currentChartY = chartsY

          dashboardCharts.forEach((chart, index) => {
            const chartWidth = chart.width === "full" ? dashboardWidth : (dashboardWidth - 20) / 2
            const chartHeight = 300

            // Chart container
            operations.push({
              type: "create",
              object: {
                id: crypto.randomUUID(),
                type: "rectangle",
                x: currentChartX,
                y: currentChartY,
                width: chartWidth,
                height: chartHeight,
                rotation: 0,
                fill_color: "#ffffff",
                stroke_color: "#e5e7eb",
                stroke_width: 1,
              },
            })

            // Chart title
            operations.push({
              type: "createText",
              text: chart.title,
              x: currentChartX + 20,
              y: currentChartY + 20,
              fontSize: 18,
              color: "#111827",
            })

            // Chart visualization placeholder
            const chartContentY = currentChartY + 60
            const chartContentHeight = chartHeight - 80

            if (chart.type === "bar") {
              // Create bar chart representation
              const barCount = 6
              const barWidth = (chartWidth - 80) / barCount - 10
              for (let i = 0; i < barCount; i++) {
                const barHeight = Math.random() * chartContentHeight * 0.7 + chartContentHeight * 0.2
                operations.push({
                  type: "create",
                  object: {
                    id: crypto.randomUUID(),
                    type: "rectangle",
                    x: currentChartX + 40 + i * (barWidth + 10),
                    y: currentChartY + chartHeight - 40 - barHeight / 2,
                    width: barWidth,
                    height: barHeight,
                    rotation: 0,
                    fill_color: colors.primary,
                    stroke_color: colors.primary,
                    stroke_width: 0,
                  },
                })
              }
            } else if (chart.type === "line") {
              const linePoints = 8
              const pointSpacing = (chartWidth - 80) / (linePoints - 1)
              const baseY = currentChartY + chartHeight - 60

              // Create line segments connecting data points
              for (let i = 0; i < linePoints - 1; i++) {
                const x1 = currentChartX + 40 + i * pointSpacing
                const y1 = baseY - Math.random() * (chartContentHeight - 60)
                const x2 = currentChartX + 40 + (i + 1) * pointSpacing
                const y2 = baseY - Math.random() * (chartContentHeight - 60)

                // Create line segment
                operations.push({
                  type: "create",
                  object: {
                    id: crypto.randomUUID(),
                    type: "line",
                    x: (x1 + x2) / 2,
                    y: (y1 + y2) / 2,
                    width: Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2),
                    height: 0,
                    rotation: Math.atan2(y2 - y1, x2 - x1),
                    fill_color: colors.primary,
                    stroke_color: colors.primary,
                    stroke_width: 3,
                  },
                })

                // Create data point circle
                operations.push({
                  type: "create",
                  object: {
                    id: crypto.randomUUID(),
                    type: "circle",
                    x: x1,
                    y: y1,
                    width: 8,
                    height: 8,
                    rotation: 0,
                    fill_color: colors.primary,
                    stroke_color: "#ffffff",
                    stroke_width: 2,
                  },
                })
              }

              // Add last data point
              const lastX = currentChartX + 40 + (linePoints - 1) * pointSpacing
              const lastY = baseY - Math.random() * (chartContentHeight - 60)
              operations.push({
                type: "create",
                object: {
                  id: crypto.randomUUID(),
                  type: "circle",
                  x: lastX,
                  y: lastY,
                  width: 8,
                  height: 8,
                  rotation: 0,
                  fill_color: colors.primary,
                  stroke_color: "#ffffff",
                  stroke_width: 2,
                },
              })
            } else if (chart.type === "pie") {
              // Create pie chart representation
              operations.push({
                type: "create",
                object: {
                  id: crypto.randomUUID(),
                  type: "circle",
                  x: currentChartX + chartWidth / 2,
                  y: chartContentY + chartContentHeight / 2,
                  width: Math.min(chartWidth - 80, chartContentHeight - 40),
                  height: Math.min(chartWidth - 80, chartContentHeight - 40),
                  rotation: 0,
                  fill_color: colors.primary,
                  stroke_color: colors.secondary,
                  stroke_width: 4,
                },
              })
            } else if (chart.type === "area") {
              const areaPoints = 8
              const pointSpacing = (chartWidth - 80) / (areaPoints - 1)
              const baseY = currentChartY + chartHeight - 60

              // Create area segments
              for (let i = 0; i < areaPoints - 1; i++) {
                const x1 = currentChartX + 40 + i * pointSpacing
                const height1 = Math.random() * (chartContentHeight - 60)
                const x2 = currentChartX + 40 + (i + 1) * pointSpacing
                const height2 = Math.random() * (chartContentHeight - 60)

                // Create area segment (trapezoid approximation)
                const avgHeight = (height1 + height2) / 2
                operations.push({
                  type: "create",
                  object: {
                    id: crypto.randomUUID(),
                    type: "rectangle",
                    x: (x1 + x2) / 2,
                    y: baseY - avgHeight / 2,
                    width: pointSpacing,
                    height: avgHeight,
                    rotation: 0,
                    fill_color: colors.bg,
                    stroke_color: colors.primary,
                    stroke_width: 0,
                  },
                })
              }

              // Add top line
              for (let i = 0; i < areaPoints - 1; i++) {
                const x1 = currentChartX + 40 + i * pointSpacing
                const y1 = baseY - Math.random() * (chartContentHeight - 60)
                const x2 = currentChartX + 40 + (i + 1) * pointSpacing
                const y2 = baseY - Math.random() * (chartContentHeight - 60)

                operations.push({
                  type: "create",
                  object: {
                    id: crypto.randomUUID(),
                    type: "line",
                    x: (x1 + x2) / 2,
                    y: (y1 + y2) / 2,
                    width: Math.sqrt((x2 - x1) ** 2 + (y2 - y1) ** 2),
                    height: 0,
                    rotation: Math.atan2(y2 - y1, x2 - x1),
                    fill_color: colors.accent,
                    stroke_color: colors.accent,
                    stroke_width: 2,
                  },
                })
              }
            }

            // Update position for next chart
            if (chart.width === "full") {
              currentChartX = startX
              currentChartY += chartHeight + 20
            } else {
              if (index % 2 === 0) {
                currentChartX += chartWidth + 20
              } else {
                currentChartX = startX
                currentChartY += chartHeight + 20
              }
            }
          })

          return {
            success: true,
            title: dashboardTitle,
            metricsCount: dashboardMetrics.length,
            chartsCount: dashboardCharts.length,
            colorScheme: scheme,
            layout: layoutStyle,
            message: `Created ${dashboardTitle} with ${dashboardMetrics.length} metrics and ${dashboardCharts.length} charts`,
          }
        },
      }),
      changeColor: tool({
        description: "Change the color of one or more existing shapes",
        inputSchema: z.object({
          shapeIdentifier: z
            .union([
              z.number(),
              z.literal("selected"),
              z.object({ type: z.enum(["rectangle", "circle", "triangle", "line"]), color: z.string().optional() }),
            ])
            .describe(
              "Identifier for the shape(s) to recolor. Can be an index (0-based, -1 for last), 'selected', or an object specifying shape type and optional current color.",
            ),
          newColor: z.string().describe("New color as hex code (e.g., #ff0000 for red)"),
          applyToAll: z
            .boolean()
            .optional()
            .describe(
              "If true and shapeIdentifier is a type, apply to ALL shapes of that type. Use this when user says 'all the triangles', 'all circles', etc.",
            ),
        }),
        execute: async ({ shapeIdentifier, newColor, applyToAll }) => {},
      }),
    }

    const spatialReasoningPrompt = `⭐⭐⭐ SPATIAL REASONING & RELATIVE POSITIONING ⭐⭐⭐

**UNDERSTANDING SPATIAL REFERENCES:**
When the user mentions spatial relationships (e.g., "above the squares", "below the circles", "to the right of the triangles"):
1. **Identify the reference object type** - What object type is being used as the spatial anchor?
2. **Find ALL objects of that reference type** - Get their positions to calculate the reference point
3. **Calculate the reference position** - Use the average or appropriate position of the reference objects
4. **Apply the spatial offset** - Calculate the new position relative to the reference

**SPATIAL REFERENCE PRIORITY:**
When user says "create X above Y":
1. **Y is the reference object** - Find all objects of type Y on the canvas
2. **Calculate Y's bounding box** - Find the topmost Y value (min Y value)
3. **Position X above Y** - Place X at (Y's center X, Y's top Y - offset)
4. **NEVER confuse reference objects** - If user says "above the squares", use squares as reference, NOT circles or triangles

**TRACKING SPATIAL RELATIONSHIPS:**
Maintain awareness of the spatial layout:
- **Most recently created objects** - Track what was just created and where
- **Object type positions** - Know where each type of object is located (top, middle, bottom, left, right)
- **Spatial hierarchy** - Understand the vertical/horizontal arrangement of different object types

**RESOLVING AMBIGUOUS SPATIAL REFERENCES:**
When user says "above them" or "below those":
1. **Check the previous message** - What object type was mentioned last?
2. **Use that type as the reference** - "them" = the objects from the previous message
3. **If still ambiguous**, ask for clarification: "Above which objects? The circles or the squares?"

**CONCRETE SPATIAL EXAMPLES:**

Example 1: Sequential creation with spatial references
- User: "create 10 adjacent circles"
  → AI: Creates 10 circles at Y=500 (for example)
  → Spatial memory: circles at Y=500
- User: "create 10 adjacent squares above them"
  → AI: "them" = circles from previous message
  → Reference: circles at Y=500
  → Calculate: squares at Y = 500 - 113.4 (3cm) - square_height/2 = ~387
  → Creates squares at Y=387
  → Spatial memory: circles at Y=500, squares at Y=387
- User: "create 5 adjacent triangles 3 cm above them"
  → AI: "them" = squares from previous message (most recent "them" reference)
  → Reference: squares at Y=387
  → Calculate: triangles at Y = 387 - 113.4 - triangle_height/2 = ~274
  → Creates triangles at Y=274
  → Spatial memory: circles at Y=500, squares at Y=387, triangles at Y=274

Example 2: Explicit spatial reference overriding "them"
- User: "create 10 adjacent circles"
  → Creates circles at Y=500
- User: "create 10 adjacent squares above them"
  → Creates squares at Y=387 (above circles)
- User: "create 5 adjacent triangles 3 cm above them"
  → Creates triangles at Y=274 (above squares)
- User: "above the squares"
  → AI: User is clarifying - they want triangles above SQUARES, not above the previous "them"
  → Reference: squares at Y=387 (explicitly mentioned)
  → Recalculate: triangles at Y = 387 - 113.4 - triangle_height/2 = ~274
  → This is correct positioning
- User: "no delete all the triangles you created, and instead I want you to create 5 adjacent triangles 3 cm above the adjacent squares created"
  → AI: User is being very explicit - reference is "the adjacent squares"
  → Reference: squares at Y=387
  → Delete existing triangles
  → Create new triangles at Y = 387 - 113.4 - triangle_height/2 = ~274

Example 3: Correcting spatial confusion
- User: "no this is 3 cm above the circles, not the squares"
  → AI: User is correcting a mistake - triangles are currently above circles, but should be above squares
  → Current: triangles at Y=387 (above circles at Y=500)
  → Desired: triangles above squares at Y=387
  → Correct calculation: triangles at Y = 387 - 113.4 - triangle_height/2 = ~274
  → Delete wrong triangles, create correct ones

**CRITICAL SPATIAL RULES:**
1. **Always identify the reference object explicitly** - Don't assume
2. **When user says "above X"**, X is the reference, calculate from X's position
3. **When user says "above them"**, "them" refers to the previous message's objects
4. **Track the spatial layout** - Know where each object type is positioned
5. **When corrected, acknowledge and recalculate** - "You're right, let me position them above the squares at Y=..."
6. **Show your spatial reasoning** - Explain which objects you're using as reference and why

**SPATIAL CALCULATION FORMULAS:**
- **Above**: new_y = reference_top_y - offset - new_object_height/2
- **Below**: new_y = reference_bottom_y + offset + new_object_height/2
- **Left of**: new_x = reference_left_x - offset - new_object_width/2
- **Right of**: new_x = reference_right_x + offset + new_object_width/2
- **3 cm offset**: ~113.4 pixels (37.8 pixels per cm)

**WHEN TO ASK FOR CLARIFICATION:**
Only ask when truly ambiguous:
- ❌ DON'T ask when user explicitly names the reference: "above the squares" is clear
- ❌ DON'T ask when "them" is clear from context
- ✅ DO ask when multiple interpretations exist: "above them" when both circles and squares were mentioned
- ✅ DO ask when spatial relationship is unclear: "near the shapes" without specific direction
`

    const systemPrompt = `You are a canvas assistant that helps users create and manipulate shapes on a collaborative canvas.

⭐⭐⭐ CONVERSATION CONTEXT & REFERENCE RESOLUTION ⭐⭐⭐

**MAINTAINING CONVERSATION CONTEXT:**
You have access to the full conversation history. Use it to understand:
1. **What objects were mentioned in previous messages** - Track which shapes the user has been working with
2. **Pronoun resolution** - "them", "those", "the same ones" refer to objects from the previous message
3. **Implicit references** - "reduce them to half their size" after "double all triangles" means reduce the triangles
4. **Sequential operations** - Build on previous operations to understand the user's workflow

**REFERENCE RESOLUTION RULES:**
1. **"them" / "those" / "these"** → Refers to the objects mentioned in the immediately previous user message
2. **"the same ones"** → Refers to the exact same objects from the previous operation
3. **"again"** → Repeat the previous operation type on the same objects
4. **"also" / "too"** → Apply the same operation to additional objects

**TRACKING WORKING SET:**
Maintain a mental model of which objects the user is currently working with:
- When user says "double all triangles" → Working set = all triangles
- When user says "now double the circles" → Working set = all circles
- When user says "reduce them to half" → Apply to current working set (circles from previous message)
- When user says "make them red" → Apply to current working set

⭐⭐⭐ DASHBOARD CREATION GUIDELINES ⭐⭐⭐

When a user asks for a dashboard, analytics view, admin panel, or similar:

**USE THE createDashboard TOOL IMMEDIATELY** - Create professional dashboards with sensible defaults

**Default Behavior:**
- **Always create the dashboard immediately** with default settings unless user specifies otherwise
- **Default color scheme**: blue (professional and widely accepted)
- **Default layout**: modern (clean and contemporary)
- **Default metrics**: Include 4 relevant KPI cards based on dashboard type
- **Default charts**: Include 2-3 appropriate charts based on dashboard type

**Dashboard Types & Defaults:**
- **Sales Dashboard**: Revenue, Orders, Conversion Rate, Avg Order Value + Revenue trend line + Sales by category bar chart
- **Analytics Dashboard**: Total Users, Active Users, Page Views, Bounce Rate + Traffic over time line + Traffic sources pie chart
- **Admin Panel**: Total Users, Active Sessions, System Load, Storage Used + Activity line chart + User distribution bar chart
- **E-commerce Dashboard**: Total Sales, Orders, Customers, Revenue + Sales trend + Top products

**Only Ask Questions When:**
- User request is too vague (e.g., just "create a dashboard" without context)
- User explicitly asks for customization options
- You need to clarify the specific business domain or metrics

**Customization (when user requests it):**
- User can specify different metrics, chart types, colors, or layouts
- Offer alternatives only if the user asks "what options do I have?"
- Keep responses concise and create the dashboard quickly

**Example Responses:**
- User: "create a sales dashboard" → Immediately create with sales-related defaults
- User: "build an analytics dashboard" → Immediately create with analytics defaults
- User: "make a dashboard" → Ask: "What type of dashboard? (e.g., sales, analytics, admin, e-commerce)"
- User: "create a dashboard with custom colors" → Ask about color preference, then create

${spatialReasoningPrompt}

CANVAS DIMENSIONS: 20000x20000 pixels
CANVAS CENTER: (10000, 10000)
VIEWPORT: Users can pan and zoom (10% to 300%)

${
  viewport && usableCanvasDimensions
    ? `
CURRENT VIEWPORT (User's visible area):
- Zoom: ${Math.round(viewport.zoom * 100)}%
- Full visible bounds: Left=${visibleArea.left}, Top=${visibleArea.top}, Right=${visibleArea.right}, Bottom=${visibleArea.bottom}
- Full visible size: ${visibleArea.width}x${visibleArea.height} pixels

⭐ USABLE CANVAS AREA (excluding UI panels):
- **Usable bounds: Left=${usableArea.left}, Top=${usableArea.top}, Right=${usableArea.right}, Bottom=${usableArea.bottom}**
- **Usable size: ${usableArea.width}x${usableArea.height} pixels**
- **Center of usable area: (${usableArea.centerX}, ${usableArea.centerY})** ← USE THIS FOR NEW OBJECTS
- UI panel offsets: Left=${usableArea.leftOffset}px, Right=${usableArea.rightOffset}px, Top=${usableArea.topOffset}px, Bottom=${usableArea.bottomOffset}px

⭐ CRITICAL POSITIONING RULES: 
1. **ALWAYS create new objects at (${usableArea.centerX}, ${usableArea.centerY})** - the center of the usable area
2. The user has panels open that cover parts of the canvas:
   - Left side (toolbar): ~${usableArea.leftOffset}px
   - Right side (panels): ~${usableArea.rightOffset}px
   - Top (toolbar): ~${usableArea.topOffset}px
   - Bottom (comments): ~${usableArea.bottomOffset}px
3. **NEVER create objects in areas covered by panels** - they won't be visible to the user
4. When user requests relative positioning (e.g., "5cm down", "below X"), calculate from existing objects but ensure result is within usable area
5. For navigation bars, position near top of usable area: y ≈ ${usableArea.top + 50}
6. For forms/cards, use center of usable area: (${usableArea.centerX}, ${usableArea.centerY})
7. The usable area is where the user can actually see and interact with objects
`
    : viewport
      ? `
CURRENT VIEWPORT (User's visible area):
- Zoom: ${Math.round(viewport.zoom * 100)}%
- Visible bounds: Left=${visibleArea.left}, Top=${visibleArea.top}, Right=${visibleArea.right}, Bottom=${visibleArea.bottom}
- Visible size: ${visibleArea.width}x${visibleArea.height} pixels
- **Center of visible area: (${visibleArea.centerX}, ${visibleArea.centerY})**

⭐ POSITIONING GUIDELINES: 
1. Default position for new objects: (${visibleArea.centerX}, ${visibleArea.centerY}) - center of user's view
2. When user requests relative positioning (e.g., "5cm down", "below X"), calculate from existing objects
3. Ensure objects are positioned within or near the visible viewport for best user experience
4. For navigation bars, position near top of viewport: y ≈ ${visibleArea.top + 50}
5. For forms/cards, use center of viewport: (${visibleArea.centerX}, ${visibleArea.centerY})
`
      : `
⭐ DEFAULT POSITIONING: Create new objects at (10000, 10000) - center of default view.
`
}

CURRENT CANVAS STATE:
Total shapes: ${canvasStats.totalShapes}
${canvasStats.totalShapes > 0 ? `Shape types: ${JSON.stringify(canvasStats.shapeTypes)}` : ""}
${canvasStats.totalShapes > 0 ? `Colors used: ${JSON.stringify(canvasStats.colorGroups)}` : ""}

${
  selectedContext.length > 0
    ? `
⭐ CURRENTLY SELECTED SHAPES (${selectedContext.length}):
${JSON.stringify(selectedContext, null, 2)}
Selected indices: ${JSON.stringify(selectedIndices)}
`
    : "No shapes are currently selected.\n"
}

OBJECTS ON CANVAS (${safeCurrentObjects.length} total):
${JSON.stringify(canvasContext, null, 2)}

⭐⭐⭐ CRITICAL SHAPE IDENTIFICATION RULES ⭐⭐⭐

**RULE 1: USER EXPLICITLY MENTIONS OBJECT TYPE**
When the user mentions a specific object type in their request (e.g., "the circle", "the rectangle", "the triangle"):
1. **IGNORE the current selection** - the user is explicitly targeting a different object
2. **Search the canvas for objects matching that type**
3. **If exactly ONE object of that type exists, automatically target it by index**
4. **If multiple objects of that type exist, ask for clarification (e.g., "by color", "by position")**
5. **NEVER ask if they meant the selected object when they explicitly mentioned a different type**

**RULE 1.5: USER SAYS "ALL" OR USES PLURAL FORMS**
When the user says "all the triangles", "all circles", "the triangles" (plural), or similar:
1. **Set applyToAll: true in the tool call**
2. **Target ALL objects of that type automatically**
3. **Do NOT ask for clarification when user explicitly says "all"**
4. **Plural forms ("triangles", "circles", "rectangles") indicate bulk operations**

Examples:
- "double the size of all the triangles" → resizeShape({ type: 'triangle' }, scale: 2, applyToAll: true)
- "move all circles to the right" → moveShape({ type: 'circle' }, deltaX: 100, applyToAll: true)
- "rotate the rectangles 45 degrees" → rotateShape({ type: 'rectangle' }, degrees: 45, applyToAll: true)
- "make all the blue shapes bigger" → resizeShape({ type: 'rectangle', color: '#3b82f6' }, scale: 1.5, applyToAll: true) for each type

Examples:
- "double the size of the circle" → Find all circles on canvas
  - If 1 circle exists at index 3 → Use index 3, don't ask about selection
  - If 2+ circles exist → Ask "Which circle? There's a blue one and a green one"
- "move the rectangle left" → Find all rectangles
  - If 1 rectangle exists → Use that rectangle's index automatically
  - If 2+ rectangles exist → Ask for clarification
- "delete the triangle" → Find all triangles
  - If 1 triangle exists → Delete it by index
  - If 0 triangles exist → Say "There are no triangles on the canvas"

**RULE 2: USER USES PRONOUNS OR REFERS TO SELECTION**
When the user says "it", "this", "the selected shape", "the selection":
1. **Use the currently selected object(s)**: ${JSON.stringify(selectedIndices)}
2. **If nothing is selected, ask them to select an object or be more specific**

**RULE 3: USER MENTIONS COLOR + TYPE**
When the user mentions both color and type (e.g., "the blue circle", "the red rectangle"):
1. **Search for objects matching BOTH type AND color**
2. **If exactly ONE match, use it automatically**
3. **If multiple matches, ask for position-based clarification**
4. **If no matches, tell them clearly what doesn't exist**

**RULE 4: AMBIGUOUS REQUESTS**
When the request is ambiguous (e.g., "make it bigger" with no selection and multiple shapes):
1. **Ask for clarification with specific options from the canvas**
2. **List what's available: "Which shape? I see a blue rectangle, a green circle, an orange triangle, a red line, and a yellow text"**

**RULE 5: VERIFY OBJECT EXISTENCE**
Before operating on any object:
1. **Check the canvas context to confirm the object exists**
2. **Never hallucinate objects that aren't in the canvas context**
3. **If an object doesn't exist, clearly state what IS on the canvas**

AVAILABLE FUNCTIONS:
1. getCanvasState - Query canvas information (use for questions like "how many shapes?")
2. createShape - Create new shapes (rectangle, circle, triangle, line)
3. moveShape - Move existing shapes by index
4. resizeShape - Resize existing shapes
5. rotateShape - Rotate existing shapes
6. deleteShape - Delete specific shapes or clear all
7. deleteShapesByType - Delete all shapes of a specific type (e.g., all rectangles)
8. deleteShapesByColor - Delete all shapes of a specific color
9. arrangeShapes - Arrange multiple shapes in patterns (grid, row, column, circle)
10. createText - Create a text layer on the canvas
11. createLoginForm - Build a multi-element login form layout with labels and button
12. createNavigationBar - Create a navigation bar with menu items
13. createCardLayout - Create a card with media area, text, and button
14. fetchAndAnalyzeWebsite - Fetch and analyze a website for design inspiration.
15. createDashboard - Create a complete professional dashboard with metrics, charts, and data sections.

TEXT LAYER RULES:
- Use createText to add text layers
- Provide text content, position (x, y), font size, and color
- Font size defaults to 16 pixels if not specified
- Text color defaults to black (#000000) if not specified

COLOR REFERENCE (use hex codes):
- red: #ef4444, blue: #3b82f6, green: #22c55e, yellow: #eab308
- purple: #a855f7, pink: #ec4899, orange: #f97316, cyan: #06b6d4
- teal: #14b8a6, indigo: #6366f1, gray: #6b7280
- black: #000000, white: #ffffff

POSITION REFERENCE:
${
  usableCanvasDimensions && viewport
    ? `
- **DEFAULT position**: (${usableArea.centerX}, ${usableArea.centerY}) - Center of USABLE area (visible to user)
- Usable top-left: (${usableArea.left}, ${usableArea.top})
- Usable top-right: (${usableArea.right}, ${usableArea.top})
- Usable bottom-left: (${usableArea.left}, ${usableArea.bottom})
- Usable bottom-right: (${usableArea.right}, ${usableArea.bottom})
- **AVOID areas covered by panels** (outside usable bounds)
`
    : viewport
      ? `
- **DEFAULT position**: (${visibleArea.centerX}, ${visibleArea.centerY}) - Center of user's visible area
- Visible top-left: (${visibleArea.left}, ${visibleArea.top})
- Visible top-right: (${visibleArea.right}, ${visibleArea.top})
- Visible bottom-left: (${visibleArea.left}, ${visibleArea.bottom})
- Visible bottom-right: (${visibleArea.right}, ${visibleArea.bottom})
`
      : `
- **DEFAULT position**: (10000, 10000) - Center of default view
- Accessible area: (0, 0) to (20000, 20000)
`
}

RELATIVE POSITIONING:
- When user says "5cm down" or "below X", calculate relative to existing objects or viewport center
- 1cm ≈ 37.8 pixels (standard screen DPI)
- "above" = negative Y, "below" = positive Y
- "left of" = negative X, "right of" = positive X
- Calculate positions to keep objects visible and well-positioned in the usable area
- **Ensure calculated positions stay within usable bounds to remain visible**

DEFAULT VALUES:
- Shape size: 100x100 pixels
- Spacing: 50 pixels
- Grid columns: 3
- Font size: 16 pixels
- **DEFAULT position: (${usableArea.centerX}, ${usableArea.centerY}) - Center of usable area**

BEST PRACTICES:
1. **ALWAYS check the canvas context before making assumptions about what exists**
2. **When user mentions an object type, search for it in the canvas context first**
3. **If only one object of the mentioned type exists, use it automatically - don't ask about selection**
4. **NEVER hallucinate objects - only work with what's in the canvas context**
5. **When user says "all" or uses plural forms, set applyToAll: true to operate on all matching shapes**
6. For questions about the canvas, use getCanvasState first
7. For complex operations, call multiple functions in sequence
8. Be conversational and explain what you're doing
9. If a request is truly ambiguous (multiple matches AND no "all" keyword), ask for clarification with specific options
10. **Position objects in the usable area so they're visible to the user**
11. **When deleting by type or color, use deleteShapesByType or deleteShapesByColor**

CONCRETE EXAMPLES:

Example 1: User says "double the size of the circle" (rectangle is selected)
- Canvas has: 1 rectangle (selected), 1 circle, 3 triangles
- ✅ CORRECT: Find the circle at index 1, call resizeShape({ type: 'circle' }, scale: 2)
- ❌ WRONG: Ask "Did you mean the selected rectangle?"
- ❌ WRONG: Say "There's no square on the canvas" (hallucinating)

Example 1.5: User says "double the size of all the triangles"
- Canvas has: 1 rectangle, 1 circle, 3 triangles
- ✅ CORRECT: Call resizeShape({ type: 'triangle' }, scale: 2, applyToAll: true) → resizes all 3 triangles
- ❌ WRONG: Ask "Which triangle?"
- ❌ WRONG: Only resize one triangle

Example 2: User says "move the triangle up" (nothing selected)
- Canvas has: 2 circles, 3 triangles
- ✅ CORRECT: Ask "Which triangle? I see 3 triangles - an orange one at the top, a blue one in the middle, and a green one at the bottom. Or did you mean all of them?"
- ❌ WRONG: Say "Please select a triangle first"

Example 2.5: User says "move the triangles up" or "move all triangles up"
- Canvas has: 2 circles, 3 triangles
- ✅ CORRECT: Call moveShape({ type: 'triangle' }, deltaY: -50, applyToAll: true) → moves all 3 triangles
- ❌ WRONG: Ask "Which triangle?"

Example 3: User says "delete the blue rectangle" (circle is selected)
- Canvas has: 1 blue rectangle, 1 red rectangle, 1 green circle (selected)
- ✅ CORRECT: Find the blue rectangle, call deleteShape with its index
- ❌ WRONG: Ask "Did you mean the selected circle?"

Example 4: User says "make it bigger" (nothing selected)
- Canvas has: 5 shapes
- ✅ CORRECT: Ask "Which shape would you like to make bigger? I see a blue rectangle, green circle, orange triangle, red line, and yellow text"
- ❌ WRONG: Assume they mean the last created shape

Example 5: User says "change the color of the selected shape to red" (rectangle is selected)
- Canvas has: 1 rectangle (selected), 2 circles
- ✅ CORRECT: Use the selected rectangle's index
- ❌ WRONG: Ask which shape they mean

Example 6: User says "rotate all the blue shapes 90 degrees"
- Canvas has: 2 blue rectangles, 1 blue circle, 1 red triangle
- ✅ CORRECT: Call rotateShape for each blue shape type with applyToAll: true
- ❌ WRONG: Ask "Which blue shape?"
- ❌ WRONG: Only rotate one blue shape

Example 7: User says "create 10 circles" then "create 10 squares above them" then "create 5 triangles 3cm above them"
- First: Creates 10 circles at Y=500
- Second: "them" = circles, creates squares at Y=387 (above circles)
- Third: "them" = squares (most recent), creates triangles at Y=274 (above squares)
- ✅ CORRECT: Track spatial relationships, use correct reference for each "them"
- ❌ WRONG: Create triangles above circles instead of squares
- ❌ WRONG: Ask "above which objects?" when "them" is clear from context
`

    const messages = []

    // Add conversation history if provided
    if (conversationHistory && Array.isArray(conversationHistory)) {
      messages.push(...conversationHistory)
    }

    // Add current user message
    messages.push({
      role: "user",
      content: message,
    })

    // [v0] Calling AI SDK with conversation context...")

    const result = await streamText({
      model: "openai/gpt-4o-mini",
      system: systemPrompt,
      messages,
      tools,
      maxSteps: 5,
    })

    let fullText = ""
    for await (const chunk of result.textStream) {
      fullText += chunk
    }

    operations = operations.map((operation) => {
      if (operation?.type === "create") {
        return {
          ...operation,
          object: {
            ...operation.object,
            id: operation.object?.id ?? crypto.randomUUID(),
          },
        }
      }

      if (operation?.type === "createText") {
        return {
          ...operation,
          id: operation.id ?? crypto.randomUUID(),
        }
      }

      return operation
    })

    // [v0] AI SDK response received")
    // [v0] Operations collected:", operations.length)

    let aiMessage = fullText || "I've processed your request!"

    if (validationErrors.length > 0) {
      aiMessage += `\n\nNote: Some operations couldn't be completed:\n${validationErrors.map((e) => `• ${e}`).join("\n")}`
    }

    if (queueItemId && canvasId) {
      try {
        const supabase = createServiceRoleClient()
        await supabase
          .from("ai_operations_queue")
          .update({
            status: "completed",
            operations: operations,
            completed_at: new Date().toISOString(),
          })
          .eq("id", queueItemId)
      } catch (err) {
        // [v0] Failed to update queue status:", err)
      }
    }

    // [v0] Returning", operations.length, "operations")
    return NextResponse.json({
      message: aiMessage,
      operations,
      queueItemId,
      validationErrors: validationErrors.length > 0 ? validationErrors : undefined,
    })
  } catch (error) {
    return NextResponse.json(
      { error: "Failed to process request" },
      { status: 500 },
    )
  }
}

type ValidationFailure = { valid: false; error: string }
type ValidationSuccess<T extends Record<string, unknown> = Record<string, never>> = { valid: true } & T
type ValidationResult<T extends Record<string, unknown> = Record<string, never>> =
  | ValidationFailure
  | ValidationSuccess<T>

function resolveShapeIndex(
  shapeIndex: number | "selected" | undefined,
  selectedIndices: number[],
  totalShapes: number,
): ValidationResult<{ shapeIndex: number }> {
  if (shapeIndex === "selected") {
    if (selectedIndices.length === 0) {
      return { valid: false, error: "No shape is currently selected." }
    }
    return resolveShapeIndex(selectedIndices[0], selectedIndices, totalShapes)
  }

  if (typeof shapeIndex !== "number") {
    return { valid: false, error: "shapeIndex must be a number or 'selected'." }
  }

  if (!Number.isFinite(shapeIndex)) {
    return { valid: false, error: "shapeIndex must be a finite number." }
  }

  const resolvedIndex = shapeIndex === -1 ? totalShapes - 1 : shapeIndex

  if (totalShapes === 0) {
    return { valid: false, error: "There are no shapes on the canvas." }
  }

  if (resolvedIndex < 0 || resolvedIndex >= totalShapes) {
    return {
      valid: false,
      error: `Invalid shape index ${shapeIndex}. Canvas has ${totalShapes} shapes (indices 0-${Math.max(0, totalShapes - 1)}).`,
    }
  }

  return { valid: true, shapeIndex: resolvedIndex }
}

function validateCreateShape(args: any): { valid: boolean; error?: string } {
  if (!args.shape || !["rectangle", "circle", "triangle", "line"].includes(args.shape)) {
    return { valid: false, error: "Invalid shape type. Must be rectangle, circle, triangle, or line." }
  }

  if (args.x !== undefined && (typeof args.x !== "number" || args.x < 0 || args.x > 20000)) {
    return { valid: false, error: "X position must be a number between 0 and 20000." }
  }

  if (args.y !== undefined && (typeof args.y !== "number" || args.y < 0 || args.y > 20000)) {
    return { valid: false, error: "Y position must be a number between 0 and 20000." }
  }

  if (typeof args.width !== "number" || typeof args.height !== "number") {
    return { valid: false, error: "Dimensions (width, height) must be numbers." }
  }

  if (args.width <= 0 || args.height <= 0) {
    return { valid: false, error: "Dimensions must be positive numbers." }
  }

  if (args.width > 5000 || args.height > 5000) {
    return { valid: false, error: "Dimensions cannot exceed 5000 pixels." }
  }

  return { valid: true }
}

function validateMoveShape(
  args: any,
  currentObjects: any[],
  selectedIndices: number[],
): ValidationResult<{ shapeIndex: number }> {
  // The shapeIndex in args is already resolved by the tool execution logic
  if (args.shapeIndex === undefined) {
    return { valid: false, error: "Internal error: shapeIndex not resolved." }
  }

  if (args.x !== undefined && (typeof args.x !== "number" || args.x < 0 || args.x > 20000)) {
    return { valid: false, error: "X position must be a number between 0 and 20000." }
  }

  if (args.y !== undefined && (typeof args.y !== "number" || args.y < 0 || args.y > 20000)) {
    return { valid: false, error: "Y position must be a number between 0 and 20000." }
  }

  if (args.deltaX !== undefined && typeof args.deltaX !== "number") {
    return { valid: false, error: "deltaX must be a number." }
  }

  if (args.deltaY !== undefined && typeof args.deltaY !== "number") {
    return { valid: false, error: "deltaY must be a number." }
  }

  if (args.x === undefined && args.y === undefined && args.deltaX === undefined && args.deltaY === undefined) {
    return {
      valid: false,
      error: "Must provide either absolute position (x, y) or relative movement (deltaX, deltaY).",
    }
  }

  return { valid: true, shapeIndex: args.shapeIndex }
}

function validateResizeShape(
  args: any,
  currentObjects: any[],
  selectedIndices: number[],
): ValidationResult<{ shapeIndex: number }> {
  // The shapeIndex in args is already resolved by the tool execution logic
  if (args.shapeIndex === undefined) {
    return { valid: false, error: "Internal error: shapeIndex not resolved." }
  }

  if (args.width !== undefined && (typeof args.width !== "number" || args.width <= 0 || args.width > 5000)) {
    return { valid: false, error: "Width must be a positive number not exceeding 5000." }
  }

  if (args.height !== undefined && (typeof args.height !== "number" || args.height <= 0 || args.height > 5000)) {
    return { valid: false, error: "Height must be a positive number not exceeding 5000." }
  }

  if (args.scale !== undefined && (typeof args.scale !== "number" || args.scale <= 0 || args.scale > 10)) {
    return { valid: false, error: "Scale must be a positive number between 0 and 10." }
  }

  if (args.width === undefined && args.height === undefined && args.scale === undefined) {
    return { valid: false, error: "Must provide either dimensions (width, height) or scale factor." }
  }

  return { valid: true, shapeIndex: args.shapeIndex }
}

function validateRotateShape(
  args: any,
  currentObjects: any[],
  selectedIndices: number[],
): ValidationResult<{ shapeIndex: number }> {
  // The shapeIndex in args is already resolved by the tool execution logic
  if (args.shapeIndex === undefined) {
    return { valid: false, error: "Internal error: shapeIndex not resolved." }
  }

  if (args.degrees === undefined) {
    return { valid: false, error: "Rotation degrees are required." }
  }

  if (typeof args.degrees !== "number") {
    return { valid: false, error: "Rotation degrees must be a number." }
  }

  return { valid: true, shapeIndex: args.shapeIndex }
}

function validateDeleteShape(
  args: any,
  currentObjects: any[],
  selectedIndices: number[],
): ValidationResult<{ shapeIndex?: number }> {
  // The shapeIndex in args is already resolved by the tool execution logic
  if (args.all === true) {
    return { valid: true }
  }

  if (args.shapeIndex === undefined) {
    return { valid: false, error: "Internal error: shapeIndex not resolved or not applicable." }
  }

  return { valid: true, shapeIndex: args.shapeIndex }
}

function validateArrangeShapes(args: any, currentObjects: any[]): { valid: boolean; error?: string } {
  if (!args.pattern || !["grid", "row", "column", "circle"].includes(args.pattern)) {
    return { valid: false, error: "Pattern must be one of: grid, row, column, circle." }
  }

  if (args.shapeIndices && !Array.isArray(args.shapeIndices)) {
    return { valid: false, error: "shapeIndices must be an array." }
  }

  if (args.shapeIndices && args.shapeIndices.length > 0) {
    for (const index of args.shapeIndices) {
      if (typeof index !== "number" || index < 0 || index >= currentObjects.length) {
        return {
          valid: false,
          error: `Invalid shape index ${index} in shapeIndices. Canvas has ${currentObjects.length} shapes.`,
        }
      }
    }
  }

  if (args.spacing !== undefined && (typeof args.spacing !== "number" || args.spacing < 0)) {
    return { valid: false, error: "Spacing must be a non-negative number." }
  }

  if (args.columns !== undefined && (typeof args.columns !== "number" || args.columns < 1)) {
    return { valid: false, error: "Columns must be a positive number." }
  }

  return { valid: true }
}

function validateCreateText(args: any): { valid: boolean; error?: string } {
  if (!args.text) {
    return { valid: false, error: "Text content is required." }
  }

  if (args.x !== undefined && (typeof args.x !== "number" || args.x < 0 || args.x > 20000)) {
    return { valid: false, error: "X position must be a number between 0 and 20000." }
  }

  if (args.y !== undefined && (typeof args.y !== "number" || args.y < 0 || args.y > 20000)) {
    return { valid: false, error: "Y position must be a number between 0 and 20000." }
  }

  if (args.fontSize !== undefined && (typeof args.fontSize !== "number" || args.fontSize <= 0)) {
    return { valid: false, error: "Font size must be a positive number." }
  }

  if (args.color !== undefined && !/^#[0-9A-Fa-f]{6}$/.test(args.color)) {
    return { valid: false, error: "Invalid color format. Must be a hex code." }
  }

  return { valid: true }
}

function analyzeWebsiteDesign(html: string, url: string) {
  const analysis = {
    colors: [] as string[],
    hasHero: false,
    hasNavigation: false,
    hasCards: false,
    hasCTA: false,
    textContent: [] as string[],
    layoutStyle: "unknown" as string,
  }

  // Extract colors from inline styles and style tags
  const colorRegex = /#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/g
  const colors = html.match(colorRegex) || []
  analysis.colors = [...new Set(colors)].slice(0, 5) // Get up to 5 unique colors

  // Detect common design patterns
  analysis.hasHero = /hero|banner|jumbotron/i.test(html)
  analysis.hasNavigation = /<nav|navigation|menu/i.test(html)
  analysis.hasCards = /card|grid|feature/i.test(html)
  analysis.hasCTA = /button|cta|call-to-action/i.test(html)

  // Extract text content from headings
  const h1Match = html.match(/<h1[^>]*>(.*?)<\/h1>/i)
  const h2Matches = html.match(/<h2[^>]*>(.*?)<\/h2>/gi)

  if (h1Match) {
    const cleanText = h1Match[1].replace(/<[^>]*>/g, "").trim()
    if (cleanText.length > 0 && cleanText.length < 100) {
      analysis.textContent.push(cleanText)
    }
  }

  if (h2Matches && h2Matches.length > 0) {
    h2Matches.slice(0, 3).forEach((match) => {
      const cleanText = match.replace(/<[^>]*>/g, "").trim()
      if (cleanText.length > 0 && cleanText.length < 100) {
        analysis.textContent.push(cleanText)
      }
    })
  }

  // Determine layout style based on URL and patterns
  if (url.includes("apple.com")) {
    analysis.layoutStyle = "minimalist-hero"
  } else if (url.includes("stripe.com")) {
    analysis.layoutStyle = "modern-gradient"
  } else if (analysis.hasCards) {
    analysis.layoutStyle = "card-grid"
  } else if (analysis.hasHero) {
    analysis.layoutStyle = "hero-centric"
  } else {
    analysis.layoutStyle = "standard"
  }

  return analysis
}

function generateCanvasFromDesign(analysis: any, usableArea: any) {
  const objects: any[] = []
  const primaryColor = analysis.colors[0] || "#3b82f6"
  const secondaryColor = analysis.colors[1] || "#6366f1"
  const accentColor = analysis.colors[2] || "#8b5cf6"

  // Create navigation bar if detected
  if (analysis.hasNavigation) {
    objects.push({
      type: "shape",
      shapeType: "rectangle",
      x: usableArea.centerX,
      y: usableArea.top + 30,
      width: usableArea.width * 0.9,
      height: 60,
      color: primaryColor,
    })

    objects.push({
      type: "text",
      text: "Navigation",
      x: usableArea.left + 100,
      y: usableArea.top + 30,
      fontSize: 18,
      color: "#ffffff",
    })
  }

  // Create hero section if detected
  if (analysis.hasHero) {
    const heroY = analysis.hasNavigation ? usableArea.top + 150 : usableArea.top + 100

    objects.push({
      type: "shape",
      shapeType: "rectangle",
      x: usableArea.centerX,
      y: heroY,
      width: usableArea.width * 0.8,
      height: 300,
      color: secondaryColor,
    })

    if (analysis.textContent.length > 0) {
      objects.push({
        type: "text",
        text: analysis.textContent[0],
        x: usableArea.centerX,
        y: heroY - 50,
        fontSize: 32,
        color: "#ffffff",
      })
    }

    if (analysis.hasCTA) {
      objects.push({
        type: "shape",
        shapeType: "rectangle",
        x: usableArea.centerX,
        y: heroY + 80,
        width: 200,
        height: 50,
        color: accentColor,
      })

      objects.push({
        type: "text",
        text: "Get Started",
        x: usableArea.centerX,
        y: heroY + 80,
        fontSize: 16,
        color: "#ffffff",
      })
    }
  }

  // Create card grid if detected
  if (analysis.hasCards) {
    const cardY = analysis.hasHero ? usableArea.top + 500 : usableArea.top + 200
    const cardWidth = 250
    const cardHeight = 200
    const spacing = 50
    const cardsPerRow = 3

    for (let i = 0; i < 3; i++) {
      const col = i % cardsPerRow
      const startX = usableArea.centerX - ((cardsPerRow - 1) * (cardWidth + spacing)) / 2

      objects.push({
        type: "shape",
        shapeType: "rectangle",
        x: startX + col * (cardWidth + spacing),
        y: cardY,
        width: cardWidth,
        height: cardHeight,
        color: "#ffffff",
      })

      if (analysis.textContent[i + 1]) {
        objects.push({
          type: "text",
          text: analysis.textContent[i + 1],
          x: startX + col * (cardWidth + spacing),
          y: cardY - 60,
          fontSize: 20,
          color: primaryColor,
        })
      }
    }
  }

  // If no specific patterns detected, create a simple inspired layout
  if (objects.length === 0) {
    objects.push({
      type: "shape",
      shapeType: "rectangle",
      x: usableArea.centerX,
      y: usableArea.centerY - 100,
      width: 600,
      height: 400,
      color: primaryColor,
    })

    objects.push({
      type: "text",
      text: "Inspired Design",
      x: usableArea.centerX,
      y: usableArea.centerY - 150,
      fontSize: 36,
      color: "#ffffff",
    })

    if (analysis.textContent.length > 0) {
      objects.push({
        type: "text",
        text: analysis.textContent[0],
        x: usableArea.centerX,
        y: usableArea.centerY,
        fontSize: 18,
        color: "#ffffff",
      })
    }
  }

  return objects
}
