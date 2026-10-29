/**
 * OpenAI Codex usage-limit client.
 *
 * Reads the ChatGPT usage endpoint used by the Codex CLI `/status` command
 * (`GET https://chatgpt.com/backend-api/wham/usage`) and turns the response
 * into an actionable "when does the limit reset" answer.
 *
 * The endpoint is undocumented and read-only: it does not consume quota.
 * Credentials come from `~/.codex/auth.json` (`tokens.access_token`,
 * `tokens.account_id`). A stale token surfaces as a 401/403 -> `auth-invalid`.
 *
 * This module is the single implementation shared by the plugin and by the
 * `codex-limits` CLI (`src/codex-limits-cli.ts`).
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage"
export const CODEX_DEFAULT_AUTH_PATH = join(homedir(), ".codex", "auth.json")
export const CODEX_DEFAULT_GRACE_MS = 60_000
export const CODEX_DEFAULT_TIMEOUT_MS = 10_000
export const CODEX_DEFAULT_USER_AGENT = "codex-cli/1.0.0"

export interface CodexWindow {
    /** `primary` (5h) / `secondary` (weekly) or any future window name. */
    name: string
    usedPercent: number | null
    limitWindowSeconds: number | null
    /** Unix time in milliseconds, derived from `reset_at` (seconds). */
    resetAtMs: number | null
    /** Unix time in milliseconds, derived from `reset_after_seconds`. */
    resetAfterMs: number | null
    /** Best-effort absolute reset moment: `reset_at` first, then `reset_after_seconds`. */
    effectiveResetMs: number | null
}

export interface CodexModelUsage {
    /** Unix time in milliseconds from `model_usage.<model>.available_at`. */
    availableAtMs: number | null
}

export interface CodexUsageSnapshot {
    planType: string | null
    allowed: boolean
    limitReached: boolean
    windows: CodexWindow[]
    modelUsage: Record<string, CodexModelUsage>
    resetCredits: number | null
    fetchedAt: number
}

export type CodexLimitsErrorReason =
    | "auth-missing"
    | "auth-invalid"
    | "http-error"
    | "network"
    | "timeout"
    | "bad-response"

export interface CodexLimitsError {
    ok: false
    reason: CodexLimitsErrorReason
    message: string
    status?: number
}

export interface CodexLimitsEvaluation {
    ok: true
    snapshot: CodexUsageSnapshot
    limitReached: boolean
    /** Moment the deciding window (and the requested model) is usable again. */
    resetAtMs: number | null
    /** `resetAtMs + graceMs`: the moment a resume attempt is worth making. */
    resumeAtMs: number | null
    decidingWindow: string | null
    graceMs: number
}

export interface EvaluateCodexLimitsOptions {
    /** Path to `auth.json`. Defaults to `$CODEX_AUTH_PATH` or `~/.codex/auth.json`. */
    authPath?: string
    /** Model id used to consult `model_usage.<model>.available_at`. */
    modelId?: string | null
    /** Injectable clock, milliseconds. */
    now?: number
    /** HTTP timeout, milliseconds. */
    timeoutMs?: number
    /** Extra time added to the reset moment before resuming. */
    graceMs?: number
    /** Injectable fetch implementation (tests). */
    fetchImpl?: typeof fetch
    /** Injected auth payload (tests); bypasses reading `auth.json`. */
    auth?: { accessToken: string; accountId?: string | null } | null
}

function asNumber(value: unknown): number | null {
    if (typeof value === "number" && Number.isFinite(value)) return value
    if (typeof value === "string" && value.trim() !== "") {
        const parsed = Number(value)
        if (Number.isFinite(parsed)) return parsed
    }
    return null
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        return value as Record<string, unknown>
    }
    return null
}

/**
 * Convert a Codex `reset_at` (seconds) / `available_at` value into milliseconds.
 * Values already large enough to be milliseconds are passed through unchanged,
 * which keeps the parser tolerant of a backend that switches units.
 */
export function toEpochMs(value: unknown): number | null {
    const raw = asNumber(value)
    if (raw === null || raw <= 0) return null
    return raw > 1e12 ? Math.round(raw) : Math.round(raw * 1000)
}

export function parseWindow(name: string, raw: unknown): CodexWindow | null {
    const record = asRecord(raw)
    if (!record) return null
    const resetAtMs = toEpochMs(record.reset_at)
    const resetAfterSeconds = asNumber(record.reset_after_seconds)
    return {
        name,
        usedPercent: asNumber(record.used_percent),
        limitWindowSeconds: asNumber(record.limit_window_seconds),
        resetAtMs,
        resetAfterMs: resetAfterSeconds === null ? null : resetAfterSeconds,
        effectiveResetMs: resetAtMs,
    }
}

/**
 * Parse a raw `wham/usage` payload. Pure: all clock-dependent fields are
 * derived from `now` so tests stay deterministic.
 */
export function parseCodexUsage(raw: unknown, now: number = Date.now()): CodexUsageSnapshot | null {
    const root = asRecord(raw)
    if (!root) return null
    const rateLimit = asRecord(root.rate_limit)
    if (!rateLimit) return null

    const windows: CodexWindow[] = []
    const primary = parseWindow("primary", rateLimit.primary_window)
    if (primary) windows.push(primary)
    const secondary = parseWindow("secondary", rateLimit.secondary_window)
    if (secondary) windows.push(secondary)

    // A window without `reset_at` still lets us derive an absolute moment.
    for (const window of windows) {
        if (window.effectiveResetMs === null && window.resetAfterMs !== null) {
            window.effectiveResetMs = now + Math.round(window.resetAfterMs * 1000)
        }
    }

    const modelUsage: Record<string, CodexModelUsage> = {}
    const rawModelUsage = asRecord(root.model_usage)
    if (rawModelUsage) {
        for (const [model, value] of Object.entries(rawModelUsage)) {
            const record = asRecord(value)
            if (!record) continue
            modelUsage[model] = {
                availableAtMs: toEpochMs(record.available_at ?? record.available_at_ms),
            }
        }
    }

    const limitReached =
        rateLimit.limit_reached === true ||
        rateLimit.allowed === false
    const resetCredits = asNumber(
        asRecord(root.rate_limit_reset_credits)?.available_count,
    )

    return {
        planType: typeof root.plan_type === "string" ? root.plan_type : null,
        allowed: rateLimit.allowed !== false,
        limitReached,
        windows,
        modelUsage,
        resetCredits,
        fetchedAt: now,
    }
}

/**
 * Pick the window that governs the wait:
 *  1. exhausted windows (`used_percent >= 100`) -> the latest reset among them;
 *  2. `limit_reached` without an obviously exhausted window -> the latest reset
 *     among all windows, because we cannot tell which one blocks us;
 *  3. otherwise no wait.
 */
export function pickDecidingWindow(snapshot: CodexUsageSnapshot): CodexWindow | null {
    const withReset = snapshot.windows.filter((w) => w.effectiveResetMs !== null)
    const exhausted = withReset.filter((w) => (w.usedPercent ?? 0) >= 100)
    if (exhausted.length > 0) {
        return exhausted.reduce((a, b) =>
            (b.effectiveResetMs ?? 0) > (a.effectiveResetMs ?? 0) ? b : a,
        )
    }
    if (snapshot.limitReached && withReset.length > 0) {
        return withReset.reduce((a, b) =>
            (b.effectiveResetMs ?? 0) > (a.effectiveResetMs ?? 0) ? b : a,
        )
    }
    return null
}

export interface ResumePlan {
    resetAtMs: number | null
    resumeAtMs: number | null
    decidingWindow: string | null
    graceMs: number
}

/**
 * Compute when it is worth retrying. Returns `resumeAtMs === null` when the
 * reset moment is unknown — callers must then fall back to a periodic recheck
 * instead of hammering the model.
 */
export function planResume(
    snapshot: CodexUsageSnapshot,
    now: number,
    graceMs: number = CODEX_DEFAULT_GRACE_MS,
    modelId?: string | null,
): ResumePlan {
    const deciding = pickDecidingWindow(snapshot)
    let resetAtMs = deciding?.effectiveResetMs ?? null

    if (modelId) {
        const modelAvailableAt = snapshot.modelUsage[modelId]?.availableAtMs ?? null
        if (modelAvailableAt !== null && modelAvailableAt > now) {
            resetAtMs = Math.max(resetAtMs ?? 0, modelAvailableAt)
        }
    }

    if (!snapshot.limitReached || resetAtMs === null) {
        return {
            resetAtMs: snapshot.limitReached ? resetAtMs : null,
            resumeAtMs: null,
            decidingWindow: deciding?.name ?? null,
            graceMs,
        }
    }

    const resumeAtMs = Math.max(now + 1_000, resetAtMs + graceMs)
    return {
        resetAtMs,
        resumeAtMs,
        decidingWindow: deciding?.name ?? null,
        graceMs,
    }
}

export interface CodexAuth {
    accessToken: string
    accountId: string | null
}

/** Read `access_token` / `account_id` out of a Codex `auth.json` payload. */
export function parseCodexAuth(raw: unknown): CodexAuth | null {
    const root = asRecord(raw)
    if (!root) return null
    const tokens = asRecord(root.tokens) ?? root
    const accessToken =
        (tokens.access_token as string | undefined) ??
        (root.access_token as string | undefined) ??
        null
    if (typeof accessToken !== "string" || accessToken.trim() === "") return null
    const accountId =
        (tokens.account_id as string | undefined) ??
        (root.account_id as string | undefined) ??
        null
    return {
        accessToken: accessToken.trim(),
        accountId: typeof accountId === "string" && accountId.trim() !== "" ? accountId.trim() : null,
    }
}

export function readCodexAuth(authPath?: string): CodexAuth | CodexLimitsError {
    const path = authPath ?? process.env.CODEX_AUTH_PATH ?? CODEX_DEFAULT_AUTH_PATH
    let payload: unknown
    try {
        payload = JSON.parse(readFileSync(path, "utf8"))
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return {
            ok: false,
            reason: "auth-missing",
            message: `cannot read Codex auth file ${path}: ${message}`,
        }
    }
    const auth = parseCodexAuth(payload)
    if (!auth) {
        return {
            ok: false,
            reason: "auth-missing",
            message: `no tokens.access_token in ${path}`,
        }
    }
    return auth
}

function isAuthError(value: unknown): value is CodexLimitsError {
    return (
        typeof value === "object" &&
        value !== null &&
        (value as CodexLimitsError).ok === false
    )
}

/**
 * Fetch and evaluate the usage endpoint in one step.
 * Never throws: every failure is reported as `{ ok: false, reason }`.
 */
export async function evaluateCodexLimits(
    options: EvaluateCodexLimitsOptions = {},
): Promise<CodexLimitsEvaluation | CodexLimitsError> {
    const now = options.now ?? Date.now()
    const graceMs = options.graceMs ?? CODEX_DEFAULT_GRACE_MS
    const timeoutMs = options.timeoutMs ?? CODEX_DEFAULT_TIMEOUT_MS
    const doFetch = options.fetchImpl ?? globalThis.fetch
    const url = process.env.CODEX_USAGE_URL ?? CODEX_USAGE_URL

    const rawAuth = options.auth === undefined ? readCodexAuth(options.authPath) : options.auth
    if (rawAuth === null) {
        return { ok: false, reason: "auth-missing", message: "no Codex credentials available" }
    }
    if (isAuthError(rawAuth)) return rawAuth
    const auth: CodexAuth = {
        accessToken: rawAuth.accessToken,
        accountId: rawAuth.accountId ?? null,
    }

    const headers: Record<string, string> = {
        Authorization: `Bearer ${auth.accessToken}`,
        Accept: "application/json",
        "User-Agent": process.env.CODEX_CLI_USER_AGENT ?? CODEX_DEFAULT_USER_AGENT,
    }
    if (auth.accountId) headers["chatgpt-account-id"] = auth.accountId

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let response: Response
    try {
        response = await doFetch(url, { method: "GET", headers, signal: controller.signal })
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const aborted = controller.signal.aborted
        return {
            ok: false,
            reason: aborted ? "timeout" : "network",
            message: aborted ? `usage request timed out after ${timeoutMs}ms` : message,
        }
    } finally {
        clearTimeout(timer)
    }

    if (!response.ok) {
        const body = await response.text().catch(() => "")
        const reason: CodexLimitsErrorReason =
            response.status === 401 || response.status === 403 ? "auth-invalid" : "http-error"
        return {
            ok: false,
            reason,
            status: response.status,
            message: `usage endpoint returned ${response.status}${body ? `: ${body.slice(0, 200)}` : ""}`,
        }
    }

    let payload: unknown
    try {
        payload = await response.json()
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return { ok: false, reason: "bad-response", message: `usage response is not JSON: ${message}` }
    }

    const snapshot = parseCodexUsage(payload, now)
    if (!snapshot) {
        return {
            ok: false,
            reason: "bad-response",
            message: "usage response has no rate_limit object",
        }
    }

    const plan = planResume(snapshot, now, graceMs, options.modelId ?? null)
    return {
        ok: true,
        snapshot,
        limitReached: snapshot.limitReached,
        resetAtMs: plan.resetAtMs,
        resumeAtMs: plan.resumeAtMs,
        decidingWindow: plan.decidingWindow,
        graceMs,
    }
}

/** Human-friendly duration, e.g. `1h 05m`, `31m`, `45s`. */
export function formatDuration(ms: number): string {
    if (!Number.isFinite(ms)) return "?"
    const totalSeconds = Math.max(0, Math.round(ms / 1000))
    const days = Math.floor(totalSeconds / 86_400)
    const hours = Math.floor((totalSeconds % 86_400) / 3_600)
    const minutes = Math.floor((totalSeconds % 3_600) / 60)
    const seconds = totalSeconds % 60
    const parts: string[] = []
    if (days > 0) parts.push(`${days}d`)
    if (hours > 0) parts.push(`${hours}h`)
    if (minutes > 0 && days === 0) parts.push(`${minutes}m`)
    if (parts.length === 0) parts.push(`${seconds}s`)
    return parts.join(" ")
}

/** Local `YYYY-MM-DD HH:MM:SS` rendering used in logs and CLI output. */
export function formatLocalTime(ms: number): string {
    const date = new Date(ms)
    const pad = (value: number) => String(value).padStart(2, "0")
    return (
        `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
        `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    )
}

export const DEFAULT_USAGE_LIMIT_MESSAGE_PATTERNS = [
    "usage limit has been reached",
    "usage limit reached",
    "you've hit your usage limit",
    "you have hit your usage limit",
    "you hit your usage limit",
]

/**
 * True when an error message carries the ChatGPT subscription limit signature.
 * Deliberately narrow: generic 429s are only matched through the explicit
 * status marker so ordinary rate limiting keeps the normal recovery path.
 */
export function matchesUsageLimitMessage(
    message: string,
    patterns: string[] = DEFAULT_USAGE_LIMIT_MESSAGE_PATTERNS,
): boolean {
    if (!message) return false
    const lower = message.toLowerCase()
    for (const pattern of patterns) {
        if (!pattern) continue
        try {
            if (new RegExp(pattern, "i").test(lower)) return true
        } catch {
            if (lower.includes(pattern.toLowerCase())) return true
        }
    }
    return lower.includes("usage limit")
}
