import { Plugin } from "@opencode/plugin"
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

/**
 * Global OpenCode plugin: two-way Telegram bridge.
 *
 * OUT (OpenCode -> Telegram)
 *  - input : a question / permission request is waiting for an answer
 *  - done  : a session turn finished (includes a short summary of the reply)
 *  - error : a session turn failed
 *  Long messages are split into multiple Telegram messages.
 *
 * IN (Telegram -> OpenCode)
 *  A message written in the configured chat becomes the next prompt of a
 *  session:
 *   - a reply to a notification goes to that notification's session
 *   - any other message goes to the session that notified last
 *   - /stop interrupts the running turn, /help and /id explain themselves
 *  Only getUpdates (long polling) is used, so the bot must not have a webhook.
 *  Updates are consumed exactly once: the offset is persisted to disk.
 *
 * Credentials are resolved in this order:
 *  1. plugin options in opencode.json
 *  2. environment variables OPENCODE_TELEGRAM_BOT_TOKEN / OPENCODE_TELEGRAM_CHAT_ID
 *  3. ~/.config/opencode/telegram-notify.json
 *
 * A global plugin is instantiated once per loaded location and every instance
 * receives every server event. Each notification is de-duplicated by event id
 * through an exclusive lock file, so one event sends exactly one message no
 * matter how many instances see it. The inbound long poller is owned by exactly
 * one instance (lock file with a heartbeat + pid token).
 */

const CONFIG_DIR = join(homedir(), ".config", "opencode")
const CONFIG_PATH = join(CONFIG_DIR, "telegram-notify.json")
const SEEN_DIR = join(CONFIG_DIR, "telegram-notify-seen")
const DEBUG_PATH = join(CONFIG_DIR, "telegram-notify-debug.log")
// message_id -> session that notification belongs to (a Telegram reply is routed by it)
const ROUTE_DIR = join(CONFIG_DIR, "telegram-notify-routes")
// chat_id -> the session that notified last (a plain message goes there)
const LAST_DIR = join(CONFIG_DIR, "telegram-notify-last")
const OFFSET_PATH = join(CONFIG_DIR, "telegram-notify-offset.json")
const POLL_LOCK_PATH = join(CONFIG_DIR, "telegram-notify-poll.lock")

// How long a prompt sent while OpenCode was closed may still be delivered on
// the first start after the offset file appears. Older updates are skipped so a
// stale backlog can never be replayed as fresh prompts.
const FIRST_RUN_MAX_AGE_MS = 15 * 60 * 1000
const POLL_TIMEOUT_S = 25
const LOCK_STALE_MS = 90 * 1000

const HELP_TEXT = [
  "📖 <b>OpenCode ↔ Telegram</b>",
  "",
  "• Normal mesaj → son aktif oturuma prompt olarak iletilir.",
  "• Bir bildirime <b>yanıt</b> → o bildirimin oturumuna gider.",
  "• /stop → çalışan turu durdurur.",
  "• /id → bu sohbetin kimliği.",
  "• /help → bu mesaj.",
  "",
  "Not: onay (permission) ve soru bildirimleri buradan yanıtlanamaz;",
  "OpenCode arayüzünde cevaplanmalıdır.",
].join("\n")

type Flags = { input: boolean; done: boolean; error: boolean }
type Resolved = { botToken: string; chatId: string; flags: Flags; inbound: boolean; debug: boolean }
type PollLock = { pid: number; token: string; at: number }

type AnyRecord = Record<string, any>

function debugLog(entry: AnyRecord): void {
  try {
    appendFileSync(DEBUG_PATH, `${JSON.stringify(entry)}\n`)
  } catch {
    // ignore
  }
}

function readJson(path: string): AnyRecord | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as AnyRecord
  } catch {
    return undefined
  }
}

function resolveConfig(options: AnyRecord | undefined): Resolved | undefined {
  const file = readJson(CONFIG_PATH)

  const botToken =
    (options?.botToken as string | undefined) ??
    process.env.OPENCODE_TELEGRAM_BOT_TOKEN ??
    file?.botToken
  const chatId =
    (options?.chatId as string | undefined) ??
    process.env.OPENCODE_TELEGRAM_CHAT_ID ??
    file?.chatId

  if (!botToken || !chatId) return undefined

  const notify = file?.notify ?? {}
  const flags: Flags = {
    input: notify.input !== false,
    done: notify.done !== false,
    error: notify.error !== false,
  }

  const inboundSetting = options?.inbound ?? file?.inbound?.enabled
  const inbound = inboundSetting !== false

  return {
    botToken: String(botToken),
    chatId: String(chatId),
    flags,
    inbound,
    debug: file?.debug === true,
  }
}

const esc = (value: unknown) =>
  String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")

const normDir = (value?: string) =>
  String(value ?? "")
    .replace(/[\\/]+$/, "")
    .toLowerCase()

// Claim an event id across every plugin instance. `wx` fails when the file
// already exists, so exactly one process wins the race for a given event.
function claim(eventId: string): boolean {
  try {
    mkdirSync(SEEN_DIR, { recursive: true })
    writeFileSync(join(SEEN_DIR, `${eventId}.lock`), new Date().toISOString(), { flag: "wx" })
    return true
  } catch {
    return false
  }
}

function pruneDir(dir: string, maxAgeMs: number): void {
  try {
    const cutoff = Date.now() - maxAgeMs
    for (const name of readdirSync(dir)) {
      const file = join(dir, name)
      try {
        if (statSync(file).mtimeMs < cutoff) unlinkSync(file)
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function pruneSeen(): void {
  pruneDir(SEEN_DIR, 2 * 24 * 60 * 60 * 1000)
  pruneDir(ROUTE_DIR, 7 * 24 * 60 * 60 * 1000)
  try {
    if (statSync(DEBUG_PATH).size > 512 * 1024) writeFileSync(DEBUG_PATH, "")
  } catch {
    // ignore
  }
}

/** Remember which session a sent notification belongs to, per Telegram message. */
function writeRoute(messageIds: number[], payload: AnyRecord): void {
  if (messageIds.length === 0) return
  try {
    mkdirSync(ROUTE_DIR, { recursive: true })
    const body = JSON.stringify({ ...payload, at: Date.now() })
    for (const id of messageIds) {
      try {
        writeFileSync(join(ROUTE_DIR, `${id}.json`), body)
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function readRoute(messageId: unknown): AnyRecord | undefined {
  const id = Number(messageId)
  if (!Number.isFinite(id)) return undefined
  return readJson(join(ROUTE_DIR, `${id}.json`))
}

function writeLastSession(chatId: string, payload: AnyRecord): void {
  try {
    mkdirSync(LAST_DIR, { recursive: true })
    writeFileSync(join(LAST_DIR, `${chatId}.json`), JSON.stringify({ ...payload, at: Date.now() }))
  } catch {
    // ignore
  }
}

function readLastSession(chatId: string): AnyRecord | undefined {
  return readJson(join(LAST_DIR, `${chatId}.json`))
}

function readOffset(): number | undefined {
  const value = Number(readJson(OFFSET_PATH)?.offset)
  return Number.isFinite(value) ? value : undefined
}

function writeOffset(offset: number): void {
  try {
    writeFileSync(OFFSET_PATH, JSON.stringify({ offset, at: new Date().toISOString() }))
  } catch {
    // ignore
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException | undefined)?.code === "EPERM"
  }
}

function apiUrl(cfg: Resolved, method: string): string {
  return `https://api.telegram.org/bot${cfg.botToken}/${method}`
}

async function tgCall(cfg: Resolved, method: string, payload: AnyRecord): Promise<AnyRecord | undefined> {
  try {
    const res = await fetch(apiUrl(cfg, method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    })
    const json = (await res.json().catch(() => undefined)) as AnyRecord | undefined
    if (!res.ok || json?.ok === false) {
      console.error(`[telegram-notify] ${method} failed:`, json?.description ?? res.status)
      return undefined
    }
    return json?.result as AnyRecord | undefined
  } catch (error) {
    console.error(`[telegram-notify] ${method} error:`, error)
    return undefined
  }
}

/** Send text (split into 4096-char chunks) and return the created message ids. */
async function sendTelegram(cfg: Resolved, text: string): Promise<number[]> {
  const chunks: string[] = []
  let remaining = text.length > 4000 * 10 ? text.slice(0, 4000 * 10) : text
  while (remaining.length > 0) {
    if (remaining.length <= 3900) {
      chunks.push(remaining)
      break
    }
    let cut = remaining.lastIndexOf("\n", 3900)
    if (cut < 1000) cut = 3900
    chunks.push(remaining.slice(0, cut))
    remaining = remaining.slice(cut).replace(/^\n+/, "")
  }
  const ids: number[] = []
  for (const chunk of chunks) {
    const result = await tgCall(cfg, "sendMessage", {
      chat_id: cfg.chatId,
      text: chunk,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    })
    const id = Number(result?.message_id)
    if (Number.isFinite(id)) ids.push(id)
  }
  return ids
}

type UpdatesResult = { ok: boolean; updates?: AnyRecord[]; conflict?: boolean }

/** One long-poll request. The outer signal cancels a poll that is in flight. */
async function telegramUpdates(
  cfg: Resolved,
  payload: AnyRecord,
  signal: AbortSignal,
): Promise<UpdatesResult> {
  const inner = new AbortController()
  const onAbort = () => inner.abort()
  if (signal.aborted) inner.abort()
  signal.addEventListener("abort", onAbort, { once: true })
  // Telegram holds a long poll open for POLL_TIMEOUT_S; abort a little later so
  // a dead connection cannot stall the loop forever.
  const timer = setTimeout(() => inner.abort(), (POLL_TIMEOUT_S + 20) * 1000)
  try {
    const res = await fetch(apiUrl(cfg, "getUpdates"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: inner.signal,
    })
    const json = (await res.json().catch(() => undefined)) as AnyRecord | undefined
    if (!res.ok || json?.ok === false) {
      const description = String(json?.description ?? res.status)
      const conflict = res.status === 409 || /webhook/i.test(description)
      debugLog({ at: new Date().toISOString(), inbound: "getUpdates failed", status: res.status, description })
      console.error("[telegram-notify] getUpdates failed:", description)
      return { ok: false, conflict }
    }
    return { ok: true, updates: Array.isArray(json?.result) ? (json.result as AnyRecord[]) : [] }
  } catch (error) {
    if (!signal.aborted && !inner.signal.aborted) {
      debugLog({ at: new Date().toISOString(), inbound: "getUpdates error", error: String(error) })
      console.error("[telegram-notify] getUpdates error:", error)
    }
    return { ok: false }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener("abort", onAbort)
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener("abort", finish)
      resolve()
    }
    signal.addEventListener("abort", finish, { once: true })
  })
}

function extractText(message: AnyRecord): string {
  for (const field of ["parts", "content"]) {
    const arr = message?.[field] ?? message?.info?.[field] ?? message?.message?.[field]
    if (Array.isArray(arr)) {
      const text = arr
        .filter((part: AnyRecord) => part?.type === "text" && typeof part.text === "string")
        .map((part: AnyRecord) => part.text)
        .join("\n")
        .trim()
      if (text) return text
    }
  }
  if (typeof message?.content === "string") return message.content.trim()
  if (typeof message?.text === "string") return message.text.trim()
  return ""
}

export default Plugin.define({
  id: "telegram-notify",
  async setup(ctx) {
    const cfg = resolveConfig(ctx.options as AnyRecord | undefined)
    if (!cfg) {
      console.error(
        `[telegram-notify] missing botToken/chatId. Fill ${CONFIG_PATH} (or set OPENCODE_TELEGRAM_BOT_TOKEN / OPENCODE_TELEGRAM_CHAT_ID).`,
      )
      return
    }

    pruneSeen()

    const ownDir = ctx.location?.directory ?? ""

    const sessionInfo = async (sessionID?: string): Promise<AnyRecord | undefined> => {
      if (!sessionID) return undefined
      try {
        return (await ctx.session.get({ sessionID })) as AnyRecord
      } catch {
        return undefined
      }
    }

    const where = async (sessionID: string | undefined, fallbackDir: string): Promise<string> => {
      const info = await sessionInfo(sessionID)
      const locationDir = (info?.location?.directory as string | undefined) ?? fallbackDir
      const title = info?.title
      return title ? `${title} — ${locationDir}` : locationDir
    }

    const isChild = async (sessionID?: string): Promise<boolean> => {
      const info = await sessionInfo(sessionID)
      return Boolean(info?.parentID)
    }

    const lastAssistantExcerpt = async (sessionID?: string): Promise<string | undefined> => {
      if (!sessionID) return undefined
      try {
        const messages = (await ctx.session.context({ sessionID })) as AnyRecord[]
        for (let i = messages.length - 1; i >= 0; i--) {
          const message = messages[i] as AnyRecord
          const kind = (message?.type ?? message?.role ?? message?.info?.role ?? message?.message?.role) as string | undefined
          if (kind !== "assistant") continue
          const text = extractText(message)
          if (text) return text
        }
      } catch {
        // ignore
      }
      return undefined
    }

    const controller = new AbortController()

    // ---------------------------------------------------------------- outbound

    void (async () => {
      try {
        for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
          const event = raw as AnyRecord
          const type: string | undefined = event?.type
          if (!type) continue

          const data: AnyRecord = event?.data ?? event
          const eventId: string | undefined = event?.id
          const eventDir: string | undefined = event?.location?.directory
          const labelDir = eventDir || ownDir

          const isForm = type === "form.created"
          const form: AnyRecord | undefined = isForm ? (data?.form ?? data) : undefined
          const sessionID: string | undefined =
            (form?.sessionID as string | undefined) ?? (data?.sessionID as string | undefined)

          const relevant =
            (type === "permission.asked" && cfg.flags.input) ||
            (isForm && cfg.flags.input) ||
            (type === "session.execution.succeeded" && cfg.flags.done) ||
            (type === "session.execution.failed" && cfg.flags.error)
          if (!relevant) continue

          // Sub-agent turns are internal; only top-level sessions are announced.
          if (type.startsWith("session.execution.") && (await isChild(sessionID))) continue

          const label = await where(sessionID, labelDir)
          let message: string | undefined

          if (type === "permission.asked") {
            const action = String(data?.action ?? "?")
            const resources = Array.isArray(data?.resources) ? data.resources.join(", ") : ""
            const head = action === "question" ? "❓ Soru bekleniyor" : "⏳ Onay bekleniyor"
            const lines = [head, `Eylem: ${esc(action)}`]
            if (resources) lines.push(`Kaynak: ${esc(resources)}`)
            if (data?.message) lines.push(esc(data.message))
            lines.push(`Proje: ${esc(label)}`)
            lines.push("", "⚠️ Bu istek OpenCode arayüzünde yanıtlanmalı.")
            message = lines.join("\n")
          } else if (isForm && form) {
            const fields = Array.isArray(form?.fields) ? form.fields : []
            const questions = fields
              .map((field: AnyRecord) => field?.title ?? field?.label ?? field?.header ?? field?.question)
              .filter(Boolean)
            const lines = ["❓ Soru soruldu (cevap bekleniyor)"]
            if (questions.length) lines.push(esc(questions.join("\n")))
            lines.push(`Proje: ${esc(label)}`)
            lines.push("", "⚠️ Bu soru OpenCode arayüzünde yanıtlanmalı.")
            message = lines.join("\n")
          } else if (type === "session.execution.succeeded") {
            const lines = ["✅ Tur tamamlandı", `Proje: ${esc(label)}`]
            const excerpt = await lastAssistantExcerpt(sessionID)
            if (excerpt) lines.push("", esc(excerpt.slice(0, 4000)))
            if (cfg.inbound) lines.push("", "↩️ Yeni prompt için bu mesaja yanıt yazın.")
            message = lines.join("\n")
          } else if (type === "session.execution.failed") {
            const error = data?.error
            const detail =
              typeof error === "string" ? error : (error?.message ?? JSON.stringify(error ?? ""))
            message = `❌ Tur hata ile bitti\nProje: ${esc(label)}\n${esc(String(detail).slice(0, 2000))}`
            if (cfg.inbound) message += "\n\n↩️ Devam etmek için bu mesaja yanıt yazın."
          }

          if (!message) continue

          // Exactly one instance sends each event.
          const handle = eventId
            ? claim(eventId)
            : !eventDir || !ownDir || normDir(eventDir) === normDir(ownDir)
          if (!handle) continue

          debugLog({ at: new Date().toISOString(), type, eventId, eventDir, ownDir, sent: true, message })
          const messageIds = await sendTelegram(cfg, message)

          // Route Telegram replies back to the session that notified.
          if (messageIds.length > 0 && sessionID && cfg.inbound) {
            writeRoute(messageIds, { sessionID, label })
            writeLastSession(cfg.chatId, { sessionID, label })
          }
        }
      } catch (error) {
        if (!controller.signal.aborted) console.error("[telegram-notify] stream error:", error)
      }
    })()

    // ----------------------------------------------------------------- inbound

    const pollController = new AbortController()
    const lockToken = `${process.pid}-${Math.random().toString(36).slice(2, 10)}`
    let heartbeat: ReturnType<typeof setInterval> | undefined
    let retry: ReturnType<typeof setInterval> | undefined

    const readLock = (): PollLock | undefined => {
      const raw = readJson(POLL_LOCK_PATH)
      if (!raw) return undefined
      return { pid: Number(raw.pid), token: String(raw.token ?? ""), at: Number(raw.at ?? 0) }
    }

    const acquirePollLock = (): boolean => {
      const current = readLock()
      if (current) {
        const fresh = Date.now() - current.at < LOCK_STALE_MS
        // A live holder keeps the lock: same pid (another instance in this
        // process) or a live pid with a heartbeat inside the stale window.
        if (fresh && (current.pid === process.pid || pidAlive(current.pid))) return false
      }
      try {
        writeFileSync(POLL_LOCK_PATH, JSON.stringify({ pid: process.pid, token: lockToken, at: Date.now() }))
        return true
      } catch {
        return false
      }
    }

    const ownsPollLock = (): boolean => readLock()?.token === lockToken

    const releasePollLock = (): void => {
      if (!ownsPollLock()) return
      try {
        unlinkSync(POLL_LOCK_PATH)
      } catch {
        // ignore
      }
    }

    const resolveTarget = (chatId: string, replyTo?: unknown): AnyRecord | undefined => {
      const route = readRoute(replyTo)
      if (route?.sessionID) return route
      return readLastSession(chatId)
    }

    const handleStop = async (chatId: string, replyTo?: unknown): Promise<void> => {
      const target = resolveTarget(chatId, replyTo)
      const sessionID = target?.sessionID ? String(target.sessionID) : undefined
      if (!sessionID) {
        await sendTelegram(cfg, "⚠️ Durdurulacak oturum bilinmiyor.")
        return
      }
      try {
        const result = (await ctx.session.interrupt({ sessionID, resume: false })) as AnyRecord | undefined
        await sendTelegram(
          cfg,
          result?.interrupted === false
            ? "ℹ️ Çalışan bir tur yok."
            : `⏹️ Tur durduruldu → ${esc(target?.label ?? sessionID)}`,
        )
      } catch (error) {
        await sendTelegram(cfg, `❌ Durdurulamadı: ${esc(String((error as Error)?.message ?? error))}`)
      }
    }

    const handleInbound = async (update: AnyRecord): Promise<void> => {
      const message = update?.message
      if (!message) return

      const chatId = String(message?.chat?.id ?? "")
      if (chatId !== cfg.chatId) {
        debugLog({ at: new Date().toISOString(), inbound: "ignored chat", chatId })
        return
      }
      if (message?.from?.is_bot) return

      const replyTo = message?.reply_to_message?.message_id
      const text = typeof message.text === "string" ? message.text.trim() : ""
      if (!text) {
        await sendTelegram(cfg, "ℹ️ Şu an yalnızca metin mesajları iletilir.")
        return
      }

      const command = text.split(/\s+/)[0].toLowerCase().replace(/@.*$/, "")
      if (command === "/start" || command === "/help") {
        await sendTelegram(cfg, HELP_TEXT)
        return
      }
      if (command === "/id") {
        await sendTelegram(cfg, `Chat ID: <code>${esc(chatId)}</code>`)
        return
      }
      if (command === "/stop" || command === "/dur") {
        await handleStop(chatId, replyTo)
        return
      }
      if (text.startsWith("/")) {
        await sendTelegram(cfg, "❔ Bilinmeyen komut. /help yazın.")
        return
      }

      const target = resolveTarget(chatId, replyTo)
      const sessionID = target?.sessionID ? String(target.sessionID) : undefined
      if (!sessionID) {
        await sendTelegram(
          cfg,
          "⚠️ Hangi oturuma göndereceğimi bilmiyorum. Önce OpenCode'da bir tur başlatın (bu sohbete bildirim gelince buradan devam edebilirsiniz).",
        )
        return
      }
      if (!(await sessionInfo(sessionID))) {
        await sendTelegram(cfg, "⚠️ O oturum artık yok. Önce OpenCode'da yeni bir tur başlatın.")
        return
      }

      try {
        await ctx.session.prompt({ sessionID, text })
      } catch (error) {
        const detail = String((error as Error)?.message ?? error)
        debugLog({ at: new Date().toISOString(), inbound: "prompt failed", sessionID, detail })
        await sendTelegram(cfg, `❌ Prompt iletilemedi: ${esc(detail.slice(0, 500))}`)
        return
      }

      const label = String(target?.label ?? sessionID)
      writeLastSession(chatId, { sessionID, label })
      debugLog({ at: new Date().toISOString(), inbound: "prompt sent", sessionID, text })
      await sendTelegram(
        cfg,
        `📨 İletildi → ${esc(label)}\n\n${esc(text.length > 300 ? `${text.slice(0, 300)}…` : text)}`,
      )
    }

    const pollLoop = async (): Promise<void> => {
      let offset = readOffset()

      if (offset === undefined) {
        // First start: read the small tail of the update history and keep only
        // very recent prompts, so a stale backlog is never replayed.
        const probe = await telegramUpdates(
          cfg,
          { offset: -20, limit: 20, timeout: 0, allowed_updates: ["message"] },
          pollController.signal,
        )
        const now = Date.now() / 1000
        const pending = probe.updates ?? []
        const recent = probe.ok
          ? pending.filter((update) => {
              const at = Number(update?.message?.date)
              return Number.isFinite(at) && now - at <= FIRST_RUN_MAX_AGE_MS / 1000
            })
          : []
        const lastId = probe.ok ? Number(pending[pending.length - 1]?.update_id) : undefined
        offset = Number.isFinite(lastId) ? Number(lastId) + 1 : 0
        writeOffset(offset)
        for (const update of recent) {
          try {
            await handleInbound(update)
          } catch (error) {
            debugLog({ at: new Date().toISOString(), inbound: "first-run error", error: String(error) })
          }
        }
      }

      let conflicts = 0
      while (!pollController.signal.aborted) {
        const result = await telegramUpdates(
          cfg,
          { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ["message"] },
          pollController.signal,
        )

        if (!result.ok) {
          if (result.conflict) {
            conflicts += 1
            if (conflicts >= 3) {
              await sendTelegram(
                cfg,
                "⚠️ Bot'ta bir webhook tanımlı olduğu için mesajlar dinlenemiyor.\nTelegram'da webhook'u kaldırın (deleteWebhook), sonra OpenCode'u yeniden yükleyin.",
              )
              pollController.abort()
              break
            }
          }
          await sleep(5000, pollController.signal)
          continue
        }

        conflicts = 0
        for (const update of result.updates ?? []) {
          const id = Number(update?.update_id)
          if (Number.isFinite(id)) {
            offset = id + 1
            writeOffset(offset)
          }
          try {
            await handleInbound(update)
          } catch (error) {
            debugLog({ at: new Date().toISOString(), inbound: "handle error", error: String(error) })
          }
        }
      }
    }

    const startPolling = (): void => {
      if (!cfg.inbound || pollController.signal.aborted) return
      if (!acquirePollLock()) {
        // Another instance/process polls; take over if it disappears.
        retry = setInterval(() => {
          if (pollController.signal.aborted) {
            if (retry) clearInterval(retry)
            retry = undefined
            return
          }
          if (!acquirePollLock()) return
          if (retry) clearInterval(retry)
          retry = undefined
          startPolling()
        }, 60 * 1000)
        return
      }

      heartbeat = setInterval(() => {
        if (!ownsPollLock()) {
          // Someone else took over (this instance lost the lock): stop quietly.
          pollController.abort()
          if (heartbeat) clearInterval(heartbeat)
          heartbeat = undefined
          return
        }
        try {
          writeFileSync(POLL_LOCK_PATH, JSON.stringify({ pid: process.pid, token: lockToken, at: Date.now() }))
        } catch {
          // ignore
        }
      }, 30 * 1000)

      void pollLoop()
    }

    startPolling()

    // A slash command to verify the setup: /telegram-test
    await ctx.command.transform((editor) => {
      editor.add({
        name: "telegram-test",
        description: "Send a test notification to Telegram",
        execute: async () => {
          await sendTelegram(cfg, "🔔 OpenCode test bildirimi — kurulum çalışıyor.")
        },
      })
    })

    return () => {
      controller.abort()
      pollController.abort()
      if (heartbeat) clearInterval(heartbeat)
      if (retry) clearInterval(retry)
      releasePollLock()
    }
  },
})
