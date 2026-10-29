#!/usr/bin/env node
/**
 * `codex-limits` — when does the OpenAI Codex (ChatGPT plan) usage limit reset?
 *
 * Usage:
 *   codex-limits [--json] [--model <id>] [--auth <path>] [--grace <seconds>]
 *                [--timeout <ms>] [--help]
 *
 * Exit codes:
 *   0  limits are available now (no wait needed)
 *   3  limit reached, reset moment known — resume after `resume_at`
 *   4  limit reached, reset moment unknown — poll again later
 *   1  request/auth failure (details on stderr)
 *
 * The endpoint is internal and read-only; it does not consume quota.
 */

import {
    CODEX_DEFAULT_GRACE_MS,
    CODEX_DEFAULT_TIMEOUT_MS,
    evaluateCodexLimits,
    formatDuration,
    formatLocalTime,
} from "./codex-limits"

interface CliArgs {
    json: boolean
    modelId: string | null
    authPath: string | undefined
    graceMs: number
    timeoutMs: number
    help: boolean
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = {
        json: false,
        modelId: null,
        authPath: undefined,
        graceMs: CODEX_DEFAULT_GRACE_MS,
        timeoutMs: CODEX_DEFAULT_TIMEOUT_MS,
        help: false,
    }
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i]
        switch (arg) {
            case "--json":
                args.json = true
                break
            case "--model":
                args.modelId = argv[++i] ?? null
                break
            case "--auth":
                args.authPath = argv[++i]
                break
            case "--grace": {
                const seconds = Number(argv[++i])
                if (Number.isFinite(seconds) && seconds >= 0) args.graceMs = seconds * 1000
                break
            }
            case "--timeout": {
                const ms = Number(argv[++i])
                if (Number.isFinite(ms) && ms > 0) args.timeoutMs = ms
                break
            }
            case "-h":
            case "--help":
                args.help = true
                break
            default:
                if (arg.startsWith("-")) {
                    throw new Error(`unknown option: ${arg}`)
                }
        }
    }
    return args
}

const HELP = `codex-limits — ChatGPT/Codex usage limit checker

Options:
  --json             print machine-readable JSON (used by opencode-auto-resume)
  --model <id>       consult model_usage.<id>.available_at for this model
  --auth <path>      path to Codex auth.json (default: ~/.codex/auth.json)
  --grace <seconds>  extra wait after reset before resuming (default: 60)
  --timeout <ms>     HTTP timeout (default: 10000)
  -h, --help         show this help

Exit codes:
  0 limits available now
  3 limit reached, resume_at known
  4 limit reached, resume_at unknown
  1 failure (auth/network/format)
`

function describeWindow(used: number | null, seconds: number | null): string {
    if (seconds === null) return used === null ? "n/a" : `${used}%`
    const hours = seconds / 3600
    const label = hours >= 168 ? "7d" : hours >= 1 ? `${Math.round(hours)}h` : `${Math.round(seconds)}s`
    return `${label} ${used === null ? "?" : `${used}%`}`
}

async function main(): Promise<number> {
    let args: CliArgs
    try {
        args = parseArgs(process.argv.slice(2))
    } catch (error) {
        console.error(error instanceof Error ? error.message : String(error))
        console.error(HELP)
        return 1
    }
    if (args.help) {
        console.log(HELP)
        return 0
    }

    const result = await evaluateCodexLimits({
        authPath: args.authPath,
        modelId: args.modelId,
        graceMs: args.graceMs,
        timeoutMs: args.timeoutMs,
    })

    if (!result.ok) {
        if (args.json) {
            console.log(JSON.stringify({ ok: false, reason: result.reason, message: result.message, status: result.status ?? null }, null, 2))
        } else {
            console.error(`codex-limits: ${result.reason}: ${result.message}`)
        }
        return 1
    }

    const now = Date.now()
    const snapshot = result.snapshot
    const waitMs = result.resumeAtMs === null ? null : Math.max(0, result.resumeAtMs - now)

    if (args.json) {
        console.log(JSON.stringify({
            ok: true,
            plan_type: snapshot.planType,
            allowed: snapshot.allowed,
            limit_reached: snapshot.limitReached,
            windows: snapshot.windows.map((w) => ({
                name: w.name,
                used_percent: w.usedPercent,
                limit_window_seconds: w.limitWindowSeconds,
                reset_at: w.effectiveResetMs === null ? null : Math.round(w.effectiveResetMs / 1000),
                reset_at_iso: w.effectiveResetMs === null ? null : new Date(w.effectiveResetMs).toISOString(),
            })),
            reset_credits: snapshot.resetCredits,
            deciding_window: result.decidingWindow,
            reset_at: result.resetAtMs === null ? null : Math.round(result.resetAtMs / 1000),
            reset_at_local: result.resetAtMs === null ? null : formatLocalTime(result.resetAtMs),
            resume_at: result.resumeAtMs === null ? null : Math.round(result.resumeAtMs / 1000),
            resume_at_local: result.resumeAtMs === null ? null : formatLocalTime(result.resumeAtMs),
            resume_in_seconds: waitMs === null ? null : Math.round(waitMs / 1000),
            grace_seconds: Math.round(result.graceMs / 1000),
            fetched_at: new Date(snapshot.fetchedAt).toISOString(),
        }, null, 2))
    } else {
        const status = snapshot.limitReached ? "LIMIT REACHED" : "available"
        const windows = snapshot.windows
            .map((w) => `${w.name} ${describeWindow(w.usedPercent, w.limitWindowSeconds)}`)
            .join(", ")
        console.log(`plan:    ${snapshot.planType ?? "unknown"}`)
        console.log(`status:  ${status}${windows ? ` (${windows})` : ""}`)
        if (result.resetAtMs !== null) {
            console.log(`reset:   ${formatLocalTime(result.resetAtMs)}${result.decidingWindow ? ` [${result.decidingWindow}]` : ""}`)
        }
        if (result.resumeAtMs !== null && waitMs !== null) {
            console.log(`resume:  ${formatLocalTime(result.resumeAtMs)} (+${Math.round(result.graceMs / 1000)}s, in ${formatDuration(waitMs)})`)
        } else if (snapshot.limitReached) {
            console.log("resume:  unknown — poll again later")
        }
        if (snapshot.resetCredits !== null) {
            console.log(`credits: ${snapshot.resetCredits} manual reset(s) available`)
        }
    }

    if (!snapshot.limitReached) return 0
    return result.resumeAtMs === null ? 4 : 3
}

main().then(
    (code) => {
        process.exitCode = code
    },
    (error) => {
        console.error(`codex-limits: ${error instanceof Error ? error.message : String(error)}`)
        process.exitCode = 1
    },
)
