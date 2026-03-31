import type { Plugin } from "@opencode-ai/plugin"
import {
  notify,
  setStatus,
  clearStatus,
  log,
  createSplit,
  closeSurface,
  focusSurface,
  sendToSurface,
  sendKeyToSurface,
  type SplitDirection,
} from "./cmux.js"

const plugin: Plugin = async ({ client, $, serverUrl }) => {
  const pendingPermissions = new Set<string>()
  const pendingQuestions = new Set<string>()
  const sessionActivity = new Map<string, string>()
  const sessionPrompt = new Map<string, string>()
  const childSessions = new Map<string, Set<string>>()
  const childSessionInfo = new Map<string, { parentID: string; label: string; agent?: string }>()
  const pendingChildMeta = new Map<
    string,
    Map<string, { agent?: string; prompt?: string; activity?: string }>
  >()

  const primaryStatusKey = "opencode"
  const childStatusPrefix = "opencode-agent-"

  const originalSurfaceId = process.env.CMUX_SURFACE_ID

  let resolvedServerUrl = ""
  let splitsEnabled = false
  try {
    const raw = serverUrl?.toString() ?? ""
    const parsed = new URL(raw)
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80")
    if (port !== "0") {
      if (parsed.hostname === "0.0.0.0" || parsed.hostname === "[::]") {
        parsed.hostname = "localhost"
      }
      resolvedServerUrl = parsed.toString().replace(/\/$/, "")
      splitsEnabled = true
    }
  } catch {
    // swallow errors silently
  }

  const activeSplits = new Map<string, string>()

  const rowFrontier: (string | undefined)[] = [undefined, undefined, undefined]
  let agentCount = 0

  let splitQueue = Promise.resolve<unknown>(undefined)
  function enqueueSplitOp<T>(fn: () => Promise<T>): Promise<T> {
    const result = splitQueue.then(fn, fn)
    splitQueue = result.then(
      () => {},
      () => {},
    )
    return result as Promise<T>
  }

  function resetGridState(): void {
    rowFrontier[0] = undefined
    rowFrontier[1] = undefined
    rowFrontier[2] = undefined
    agentCount = 0
  }

  function removeAndClose(sessionId: string): void {
    const surfaceId = activeSplits.get(sessionId)
    if (!surfaceId) return
    activeSplits.delete(sessionId)
    closeSurface($, surfaceId).catch(() => {})
    if (activeSplits.size === 0) {
      resetGridState()
    }
  }

  function isWaitingForInput(): boolean {
    return pendingPermissions.size > 0 || pendingQuestions.size > 0
  }

  function getChildStatusKey(sessionID: string): string {
    return `${childStatusPrefix}${sessionID}`
  }

  function parseChildLabel(label: string): { label: string; agent?: string } {
    const trimmed = label.trim()
    const match = trimmed.match(/^(.*?)\s*\(@([^)\s]+)\s+subagent\)$/i)
    if (!match) {
      return { label: truncateSingleLine(trimmed, 40) }
    }

    return {
      label: truncateSingleLine(match[1].trim() || trimmed, 40),
      agent: match[2].trim(),
    }
  }

  function rememberPendingChildMeta(parentID: string, part: any): void {
    if (!part?.id) return
    const entries = pendingChildMeta.get(parentID)
    const next = {
      agent: typeof part.agent === "string" ? part.agent : undefined,
      prompt: typeof part.prompt === "string" ? part.prompt : undefined,
      activity:
        typeof part.description === "string"
          ? part.description
          : typeof part.prompt === "string"
            ? part.prompt
            : undefined,
    }

    if (entries) {
      entries.set(part.id, next)
      return
    }

    pendingChildMeta.set(parentID, new Map([[part.id, next]]))
  }

  function consumePendingChildMeta(
    parentID: string,
  ): { agent?: string; prompt?: string; activity?: string } | undefined {
    const entries = pendingChildMeta.get(parentID)
    if (!entries || entries.size === 0) return undefined

    const first = entries.entries().next().value as
      | [string, { agent?: string; prompt?: string; activity?: string }]
      | undefined
    if (!first) return undefined

    const [key, value] = first
    entries.delete(key)
    if (entries.size === 0) {
      pendingChildMeta.delete(parentID)
    }
    return value
  }

  function upsertChildSession(
    parentID: string,
    sessionID: string,
    label: string,
    agent?: string,
  ): void {
    const siblings = childSessions.get(parentID)
    if (siblings) {
      siblings.add(sessionID)
    } else {
      childSessions.set(parentID, new Set([sessionID]))
    }

    const parsed = parseChildLabel(label)
    const current = childSessionInfo.get(sessionID)
    childSessionInfo.set(sessionID, {
      parentID,
      label: parsed.label,
      agent: agent ?? parsed.agent ?? current?.agent,
    })
  }

  function removeChildSession(sessionID: string): string | undefined {
    const info = childSessionInfo.get(sessionID)
    if (!info) return undefined

    childSessionInfo.delete(sessionID)

    const siblings = childSessions.get(info.parentID)
    if (siblings) {
      siblings.delete(sessionID)
      if (siblings.size === 0) {
        childSessions.delete(info.parentID)
      }
    }

    return info.parentID
  }

  async function clearChildStatus(sessionID: string): Promise<void> {
    await clearStatus($, getChildStatusKey(sessionID))
  }

  async function renderChildStatuses(parentID: string | undefined): Promise<void> {
    if (!parentID) return

    const siblings = childSessions.get(parentID)
    if (!siblings || siblings.size === 0) return

    for (const childID of siblings) {
      const child = childSessionInfo.get(childID)
      if (!child) continue
      const prefix = child.agent ? `[@${child.agent}] ` : `${child.label}: `
      const text = getSessionStatusText(childID)
      await setStatus($, getChildStatusKey(childID), `• ${prefix}${text}`, {
        icon: "sparkles",
        color: "#60a5fa",
      })
    }
  }

  function describeTool(tool: string | undefined, title: string | undefined): string | undefined {
    const label = title?.trim() || tool?.trim()
    if (!label) return undefined
    return truncateSingleLine(label)
  }

  function describePartActivity(part: any): string | undefined {
    if (!part?.type) return undefined

    if (part.type === "tool") {
      if (part.state?.status !== "pending" && part.state?.status !== "running") {
        return undefined
      }
      return describeTool(part.tool, part.state?.title) ?? "Using tool"
    }

    if (part.type === "subtask") {
      return truncateSingleLine(part.description || part.prompt || "Starting subagent")
    }

    if (part.type === "reasoning") {
      return "Thinking"
    }

    if (part.type === "patch") {
      return "Preparing file patches"
    }

    if (part.type === "file") {
      return truncateSingleLine(`Reviewing ${part.filename || part.source?.path || "file"}`)
    }

    if (part.type === "step-start") {
      return "Working"
    }

    return undefined
  }

  function truncateSingleLine(value: string, max = 72): string {
    const collapsed = value.replace(/\s+/g, " ").trim()
    if (collapsed.length <= max) return collapsed
    return `${collapsed.slice(0, max - 3).trimEnd()}...`
  }

  function setSessionActivity(sessionID: string | undefined, detail: string | undefined): void {
    if (!sessionID) return
    const next = detail ? truncateSingleLine(detail) : ""
    if (next) {
      sessionActivity.set(sessionID, next)
      return
    }
    sessionActivity.delete(sessionID)
  }

  function setSessionPrompt(sessionID: string | undefined, prompt: string | undefined): void {
    if (!sessionID) return
    const next = prompt ? truncateSingleLine(prompt) : ""
    if (next) {
      sessionPrompt.set(sessionID, next)
      return
    }
    sessionPrompt.delete(sessionID)
  }

  function getSessionActivity(sessionID: string | undefined): string | undefined {
    if (!sessionID) return undefined
    return sessionActivity.get(sessionID)
  }

  function getSessionPrompt(sessionID: string | undefined): string | undefined {
    if (!sessionID) return undefined
    return sessionPrompt.get(sessionID)
  }

  function getSessionStatusText(sessionID: string | undefined): string {
    const activity = getSessionActivity(sessionID)
    const prompt = getSessionPrompt(sessionID)

    if (activity && prompt) {
      return truncateSingleLine(`${activity}: "${prompt}"`)
    }

    if (activity) {
      return truncateSingleLine(activity)
    }

    if (prompt) {
      return truncateSingleLine(`Prompt: "${prompt}"`)
    }

    return "working"
  }

  async function setWorkingStatus(sessionID?: string): Promise<void> {
    const text = getSessionStatusText(sessionID)

    await setStatus($, primaryStatusKey, text, {
      icon: "terminal",
      color: "#f59e0b",
    })

    const session = sessionID ? await fetchSession(sessionID) : null
    await renderChildStatuses(session?.parentID ?? sessionID)
  }

  async function clearWorkingStatus(): Promise<void> {
    await clearStatus($, primaryStatusKey)
  }

  function getPermissionRequestID(source: any): string | undefined {
    if (!source) return undefined
    const rawID = source.id ?? source.requestID ?? source.permissionID
    if (typeof rawID !== "string") return undefined
    const trimmed = rawID.trim()
    return trimmed === "" ? undefined : trimmed
  }

  function getQuestionRequestID(source: any): string | undefined {
    if (!source) return undefined
    const rawID = source.id ?? source.requestID
    if (typeof rawID !== "string") return undefined
    const trimmed = rawID.trim()
    return trimmed === "" ? undefined : trimmed
  }

  async function fetchSession(
    sessionID: string,
  ): Promise<{ title: string; parentID?: string } | null> {
    try {
      const result = await client.session.get({ path: { id: sessionID } })
      if (result.data) {
        return { title: result.data.title, parentID: result.data.parentID }
      }
      return null
    } catch {
      return null
    }
  }

  return {
    async "chat.message"(input, output) {
      const textPart = output.parts.find((part) => part.type === "text")
      const prompt =
        textPart?.type === "text"
          ? textPart.text
          : output.message.summary?.title

      if (prompt) {
        setSessionPrompt(input.sessionID, prompt)
      }
    },

    async event({ event }) {
      const e = event as any

      if (e.type === "message.part.updated") {
        const part = e.properties.part

        if (part?.type === "subtask") {
          rememberPendingChildMeta(part.sessionID, part)
        }

        const activity = describePartActivity(part)
        if (activity) {
          setSessionActivity(part.sessionID, activity)

          const child = childSessionInfo.get(part.sessionID)
          if (child) {
            await renderChildStatuses(child.parentID)
          }

          return
        }
      }

      if (e.type === "session.created") {
        const info = e.properties.info
        if (info?.parentID && info?.id) {
          const meta = consumePendingChildMeta(info.parentID)
          upsertChildSession(info.parentID, info.id, info.title ?? info.id, meta?.agent)
          if (meta?.prompt) {
            setSessionPrompt(info.id, meta.prompt)
          }
          if (meta?.activity) {
            setSessionActivity(info.id, meta.activity)
          }
          await renderChildStatuses(info.parentID)
        }
        if (info?.parentID && splitsEnabled) {
          await enqueueSplitOp(async () => {
            if (activeSplits.has(info.id)) return

            let direction: SplitDirection
            let fromSurface: string | undefined
            const n = agentCount

            if (n === 0) {
              direction = "right"
              fromSurface = originalSurfaceId
            } else if (n === 1) {
              direction = "down"
              fromSurface = rowFrontier[0]
            } else if (n === 2) {
              direction = "down"
              fromSurface = originalSurfaceId
            } else {
              const rowIdx = (n - 3) % 3
              direction = "right"
              fromSurface = rowFrontier[rowIdx]
            }

            const surfaceId = await createSplit($, direction, fromSurface)
            if (!surfaceId) return

            if (n < 3) {
              rowFrontier[n] = surfaceId
            } else {
              const rowIdx = (n - 3) % 3
              rowFrontier[rowIdx] = surfaceId
            }

            activeSplits.set(info.id, surfaceId)
            agentCount++

            const attachCmd = `opencode attach ${resolvedServerUrl} --session ${info.id}`
            await sendToSurface($, surfaceId, attachCmd)
            await sendKeyToSurface($, surfaceId, "enter")

            if (originalSurfaceId) {
              await focusSurface($, originalSurfaceId)
            }
          })
        }
        return
      }

      if (e.type === "session.deleted") {
        const info = e.properties.info
        if (info?.id) {
          setSessionActivity(info.id, undefined)
          setSessionPrompt(info.id, undefined)
          const parentID = removeChildSession(info.id)
          await clearChildStatus(info.id)
          await renderChildStatuses(parentID)
          removeAndClose(info.id)
        }
        return
      }

      if (e.type === "session.status") {
        const { sessionID, status } = e.properties

        if (status.type === "busy") {
          const child = childSessionInfo.get(sessionID)
          if (child) {
            await renderChildStatuses(child.parentID)
          }

          if (!isWaitingForInput()) {
            await setWorkingStatus(sessionID)
          }
          return
        }

        if (status.type === "idle") {
          if (isWaitingForInput()) {
            return
          }

          const session = await fetchSession(sessionID)
          const title = session?.title ?? sessionID

          if (!session?.parentID) {
            await notify($, { title: `Done: ${title}` })
            await log($, `Done: ${title}`, { level: "success", source: "opencode" })
            setSessionActivity(sessionID, undefined)
            setSessionPrompt(sessionID, undefined)
            await clearWorkingStatus()
          } else {
            await log($, `Subagent finished: ${title}`, {
              level: "info",
              source: "opencode",
            })

            setSessionActivity(sessionID, undefined)
            setSessionPrompt(sessionID, undefined)
            const parentID = removeChildSession(sessionID)
            await clearChildStatus(sessionID)
            await renderChildStatuses(parentID)
            removeAndClose(sessionID)
          }
          return
        }
      }

      if (e.type === "session.error") {
        pendingPermissions.clear()
        pendingQuestions.clear()

        const sessionID = e.properties.sessionID
        setSessionActivity(sessionID, undefined)
        setSessionPrompt(sessionID, undefined)
        const title = sessionID
          ? (await fetchSession(sessionID))?.title ?? sessionID
          : "unknown session"

        await notify($, { title: `Error: ${title}` })
        await log($, `Error in session: ${title}`, {
          level: "error",
          source: "opencode",
        })
        await clearWorkingStatus()

        if (sessionID) {
          const parentID = removeChildSession(sessionID)
          await clearChildStatus(sessionID)
          await renderChildStatuses(parentID)
          removeAndClose(sessionID)
        }
        return
      }

      if (e.type === "permission.asked" || e.type === "permission.updated") {
        const id = getPermissionRequestID(e.properties)
        if (id && !pendingPermissions.has(id)) {
          pendingPermissions.add(id)
          const title = e.properties.title ?? e.properties.permission ?? "command"
          await setStatus($, primaryStatusKey, "waiting", {
            icon: "lock",
            color: "#ef4444",
          })
          await notify($, { title: "Needs your permission", subtitle: title })
          await log($, `Permission requested: ${title}`, {
            level: "info",
            source: "opencode",
          })
        }
        return
      }

      if (e.type === "permission.replied") {
        const id = getPermissionRequestID(e.properties)
        if (id) {
          pendingPermissions.delete(id)
        }

        if (!isWaitingForInput()) {
          await setWorkingStatus(e.properties.sessionID)
        }
        return
      }

      if (e.type === "question.asked") {
        const id = getQuestionRequestID(e.properties)
        if (id) {
          pendingQuestions.add(id)
        }

        const header = e.properties.questions?.[0]?.header ?? "Question"
        await setStatus($, primaryStatusKey, "question", {
          icon: "help-circle",
          color: "#a855f7",
        })
        await notify($, { title: "Has a question", subtitle: header })
        await log($, `Question: ${header}`, { level: "info", source: "opencode" })
        return
      }

      if (e.type === "question.replied" || e.type === "question.rejected") {
        const id = getQuestionRequestID(e.properties)
        if (id) {
          pendingQuestions.delete(id)
        }

        if (!isWaitingForInput()) {
          await setWorkingStatus(e.properties.sessionID)
        }
        return
      }
    },

    async "permission.ask"(input) {
      const id = getPermissionRequestID(input as any)
      if (id) {
        pendingPermissions.add(id)
      }

      const title = (input as any).title ?? (input as any).permission ?? "command"
      await setStatus($, primaryStatusKey, "waiting", {
        icon: "lock",
        color: "#ef4444",
      })
      await notify($, { title: "Needs your permission", subtitle: title })
      await log($, `Permission requested: ${title}`, {
        level: "info",
        source: "opencode",
      })
    },
  }
}

export default plugin
