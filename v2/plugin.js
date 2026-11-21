// opencode-auto-resume — OpenCode v2 plugin port (contract version 2).
//
// Port of /Users/sergejtincurin/dev/projects/opencode-auto-resume (v1, commit
// ca5507a7) onto the v2 plugin contract. The mapping is empirical: every v2
// surface used below was confirmed against opencode 2.3.2 by the probe in
// ./probe (see evidence E12-auto-resume-port.md).
//
//   v1                                        v2 (this file)
//   plugin event hook 'session.status'    ->  ctx.event.subscribe({types})
//   plugin event hook 'session.error'     ->  'session.step.failed' /
//                                             'session.execution.failed'
//                                             + ctx.session.hook('retry')
//   plugin event hook 'session.idle'      ->  'session.idle' /
//                                             'session.execution.succeeded'
//   plugin event hook 'session.interrupted' -> 'session.execution.interrupted'
//   tool.execute.before/after (event hook) -> ctx.tool.hook('execute.before')
//                                             ctx.tool.hook('execute.after')
//   chat.message hook                      -> 'session.inbox.enqueued'
//   client.session.prompt({path, body})    -> ctx.session.prompt({sessionID, text})
//                                             (fallback: ctx.session.synthetic)
//   client.app.log                         -> optional log file + ctx.app.log
//   getSessionProviderModel(sid)           -> ctx.session.hook('model.request')
//                                             payload {providerID, model:{id}}
//   codex-limits CLI (default)             -> $OPENCODE_DIR/stage/codex-limits/
//                                             codex-limits-v2.sh (task 9)
//
// Kept from v1 (behaviour parity): chunk-timeout stall recovery with grace,
// warmup, bounded attempts and exponential backoff; loop guard; in-flight tool
// and pending-question protection; user cancellation (ESC) suppression that
// rearms on the next user input; usage-limit wait driven by the codex-limits
// JSON contract (exit 0/3/4/1), with grace, recheck cycle, max rechecks, max
// wait and the resume-after-pause note.
//
// NOT carried over (documented in the evidence, not silently dropped):
//   * open-todo done-claim nudges — v2 has no todo tool, so "open todos" has
//     no source of truth; the Russian done-claim marker patterns are kept in
//     DONE_CLAIM_PATTERNS for the future but no nudge is emitted.
//   * v1 subagent (`task` tool) stall handling — v2 subagents are separate
//     sessions; they get their own watchdog state instead.
//   * in-process Codex usage evaluation — replaced by the codex-limits-v2.sh
//     wrapper (task 9), which is the same JSON contract v1's script option used.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'

const MAX_TIMER_DELAY_MS = 2_147_000_000

const DEFAULTS = {
    chunkTimeoutMs: 45_000,
    checkIntervalMs: 5_000,
    gracePeriodMs: 3_000,
    restartDelayMs: 1_000,
    warmupMs: 15_000,
    maxRetries: 3,
    baseBackoffMs: 1_000,
    maxBackoffMs: 8_000,
    loopMaxContinues: 3,
    loopWindowMs: 10 * 60_000,
    continuePrompt: 'continue',
    usageLimitEnabled: true,
    usageLimitProviders: ['openai'],
    usageLimitGraceMs: 60_000,
    usageLimitTimeoutMs: 10_000,
    usageLimitRecheckMs: 10 * 60_000,
    usageLimitMaxRechecks: 6,
    usageLimitMaxWaitMs: 8 * 24 * 60 * 60_000,
    usageLimitScript: null,
    usageLimitMessagePatterns: [
        'usage limit has been reached',
        'usage limit reached',
        "you've hit your usage limit",
        'you have hit your usage limit',
        'you hit your usage limit',
    ],
    resumeNoteEnabled: true,
    resumeNoteText:
        'NOTE: This session was resumed automatically after waiting out a provider usage-limit window. ' +
        'Long pauses can lose background subagent sessions from storage: if a task_id, background_output ' +
        'or session reference no longer resolves, do not block on it and do not excavate local storage — ' +
        'restart that subagent task fresh or re-derive the result from on-disk evidence, then continue the plan.',
    homeNoteEnabled: true,
    claimDir: null,
    claimTtlMs: 60_000,
    logFile: null,
    debug: false,
}

// Kept for parity with the v1 fork (see AGENTS.md: Cyrillic needs \p{L} with the
// u flag). No nudge is emitted in v2 — there is no todo tool to read.
export const DONE_CLAIM_PATTERNS = [
    /(?<![\p{L}\p{N}_])готово(?![\p{L}\p{N}_])/iu,
    /(?<![\p{L}\p{N}_])выполнено(?![\p{L}\p{N}_])/iu,
    /(?<![\p{L}\p{N}_])задача выполнена(?![\p{L}\p{N}_])/iu,
    /(?<![\p{L}\p{N}_])все задачи выполнены(?![\p{L}\p{N}_])/iu,
    /(?<![\p{L}\p{N}_])(done|finished|completed)(?![\p{L}\p{N}_])/iu,
]

const SUBSCRIBED_EVENTS = [
    'session.created',
    'session.deleted',
    'session.inbox.enqueued',
    'session.inbox.delivered',
    'session.inbox.cancelled',
    'session.synthetic',
    'form.created',
    'form.replied',
    'form.cancelled',
    'session.execution.started',
    'session.execution.succeeded',
    'session.execution.failed',
    'session.execution.interrupted',
    'session.step.started',
    'session.step.ended',
    'session.step.failed',
    'session.text.started',
    'session.text.delta',
    'session.text.ended',
    'session.reasoning.started',
    'session.reasoning.delta',
    'session.reasoning.ended',
    'session.tool.called',
    'session.tool.input.started',
    'session.tool.input.delta',
    'session.tool.input.ended',
    'session.tool.progress',
    'session.tool.success',
    'session.tool.failed',
    'session.retry.scheduled',
    'session.idle',
    'session.compaction.started',
    'session.compaction.ended',
    'session.compaction.failed',
    'session.moved',
    'permission.asked',
    'permission.replied',
]

const num = (value, fallback) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback

function loadOptions(ctx) {
    const merged = { ...DEFAULTS, ...(ctx?.options ?? {}) }
    // Precedence: DEFAULTS -> ctx.options -> config file -> AUTO_RESUME_OPTIONS.
    // The config file is AUTO_RESUME_OPTIONS_FILE / $OPENCODE_DIR when set
    // (tests rely on this for hermeticity); otherwise config.json shipped next
    // to the plugin. ctx.app.log does not exist on opencode 2.3.2 (probe E12),
    // so the file from `logFile` is the plugin's only working log channel.
    const envFile =
        process.env.AUTO_RESUME_OPTIONS_FILE ??
        (process.env.OPENCODE_DIR
            ? path.join(process.env.OPENCODE_DIR, 'stage', 'auto-resume', 'config.json')
            : null)
    const file =
        envFile ??
        path.join(path.dirname(fileURLToPath(import.meta.url)), 'config.json')
    try {
        const raw = fs.readFileSync(file, 'utf8')
        Object.assign(merged, JSON.parse(raw))
    } catch (err) {
        if (err?.code !== 'ENOENT') {
            merged.__optionsError = `config.json: ${err?.message ?? err}`
        }
    }
    if (process.env.AUTO_RESUME_OPTIONS) {
        try {
            Object.assign(merged, JSON.parse(process.env.AUTO_RESUME_OPTIONS))
        } catch (err) {
            merged.__optionsError = `AUTO_RESUME_OPTIONS: ${err?.message ?? err}`
        }
    }
    return merged
}

function defaultUsageLimitScript() {
    const root = process.env.OPENCODE_DIR
    if (!root) return null
    const candidate = path.join(root, 'stage', 'codex-limits', 'codex-limits-v2.sh')
    try {
        fs.accessSync(candidate, fs.constants.X_OK)
        return candidate
    } catch {
        return null
    }
}

const short = (sid) => (typeof sid === 'string' ? sid.slice(-6) : String(sid))

const formatDuration = (ms) => {
    const total = Math.max(0, Math.round(ms / 1000))
    const h = Math.floor(total / 3600)
    const m = Math.floor((total % 3600) / 60)
    const s = total % 60
    return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${s}s` : `${s}s`
}

const formatLocalTime = (ms) => new Date(ms).toLocaleTimeString()

function asObject(data) {
    if (data && typeof data === 'object') return data
    if (typeof data === 'string') {
        try {
            const parsed = JSON.parse(data)
            return parsed && typeof parsed === 'object' ? parsed : {}
        } catch {
            return {}
        }
    }
    return {}
}

function createLog(opts, ctx) {
    const entries = []
    let appLogDisabled = false

    const toFile = (level, message) => {
        if (!opts.logFile) return
        try {
            fs.mkdirSync(path.dirname(opts.logFile), { recursive: true })
            fs.appendFileSync(
                opts.logFile,
                JSON.stringify({ at: new Date().toISOString(), level, message }) + '\n',
            )
        } catch {
            // Diagnostics must never break the session.
        }
    }

    const toApp = (level, message) => {
        if (appLogDisabled) return
        const log = ctx?.app?.log
        if (typeof log !== 'function') {
            appLogDisabled = true
            return
        }
        try {
            const result = log.call(ctx.app, { service: 'auto-resume', level, message })
            if (result && typeof result.catch === 'function') result.catch(() => {})
        } catch {
            appLogDisabled = true
        }
    }

    const log = (level, message) => {
        entries.push({ level, message })
        if (entries.length > 500) entries.shift()
        toFile(level, message)
        toApp(level, message)
    }

    return {
        log,
        debug: (message) => {
            if (opts.debug) log('debug', message)
        },
        entries,
    }
}

function createPlugin(ctx) {
    const opts = loadOptions(ctx)
    const logger = createLog(opts, ctx)
    const log = logger.log
    const dbg = logger.debug

    const chunkTimeoutMs = num(opts.chunkTimeoutMs, DEFAULTS.chunkTimeoutMs)
    const checkIntervalMs = Math.max(250, num(opts.checkIntervalMs, DEFAULTS.checkIntervalMs))
    const gracePeriodMs = num(opts.gracePeriodMs, DEFAULTS.gracePeriodMs)
    const restartDelayMs = Math.max(50, num(opts.restartDelayMs, DEFAULTS.restartDelayMs))
    const warmupMs = num(opts.warmupMs, DEFAULTS.warmupMs)
    const maxRetries = num(opts.maxRetries, DEFAULTS.maxRetries)
    const baseBackoffMs = num(opts.baseBackoffMs, DEFAULTS.baseBackoffMs)
    const maxBackoffMs = num(opts.maxBackoffMs, DEFAULTS.maxBackoffMs)
    const loopMaxContinues = num(opts.loopMaxContinues, DEFAULTS.loopMaxContinues)
    const loopWindowMs = num(opts.loopWindowMs, DEFAULTS.loopWindowMs)
    const continuePrompt =
        typeof opts.continuePrompt === 'string' ? opts.continuePrompt : DEFAULTS.continuePrompt

    const usageLimitEnabled = opts.usageLimitEnabled !== false
    const usageLimitProviders = Array.isArray(opts.usageLimitProviders)
        ? opts.usageLimitProviders.map((p) => String(p).toLowerCase())
        : DEFAULTS.usageLimitProviders
    const usageLimitGraceMs = num(opts.usageLimitGraceMs, DEFAULTS.usageLimitGraceMs)
    const usageLimitTimeoutMs = num(opts.usageLimitTimeoutMs, DEFAULTS.usageLimitTimeoutMs)
    const usageLimitRecheckMs = num(opts.usageLimitRecheckMs, DEFAULTS.usageLimitRecheckMs)
    const usageLimitMaxRechecks = num(opts.usageLimitMaxRechecks, DEFAULTS.usageLimitMaxRechecks)
    const usageLimitMaxWaitMs = num(opts.usageLimitMaxWaitMs, DEFAULTS.usageLimitMaxWaitMs)
    const usageLimitScript =
        typeof opts.usageLimitScript === 'string' && opts.usageLimitScript
            ? opts.usageLimitScript
            : defaultUsageLimitScript()
    const usageLimitMessagePatterns = Array.isArray(opts.usageLimitMessagePatterns)
        ? opts.usageLimitMessagePatterns
        : DEFAULTS.usageLimitMessagePatterns
    const resumeNoteEnabled = opts.resumeNoteEnabled !== false
    const resumeNoteText =
        typeof opts.resumeNoteText === 'string' ? opts.resumeNoteText : DEFAULTS.resumeNoteText
    const claimDir =
        typeof opts.claimDir === 'string' && opts.claimDir
            ? opts.claimDir
            : path.join(os.homedir(), '.local', 'state', 'opencode', 'auto-resume', 'claims')
    const claimTtlMs = num(opts.claimTtlMs, DEFAULTS.claimTtlMs)

    /** @type {Map<string, any>} */
    const sessions = new Map()
    const disposers = []
    let stopped = false

    function ensureWatch(sid) {
        let s = sessions.get(sid)
        if (!s) {
            s = {
                sid,
                providerID: null,
                modelID: null,
                agent: null,
                busy: false,
                executionStartedAt: 0,
                lastActivityAt: Date.now(),
                pendingTools: 0,
                promptBlocked: false,
                questionPending: false,
                userCancelled: false,
                continuing: false,
                resumeAttempts: 0,
                lastRetryAt: 0,
                gaveUp: false,
                continues: [],
                usageLimit: null,
                usageLimitPending: false,
                staleRetryScheduled: false,
                lastQuotaErrorId: null,
                claimPath: null,
            }
            sessions.set(sid, s)
        }
        return s
    }

    // Activity timestamp only: `busy` is owned by execution.* events so a stray
    // metadata event cannot resurrect a finished run. Only session.retry.scheduled
    // goes through progress(), which re-arms busy for the pending provider retry.
    const touch = (s) => {
        s.lastActivityAt = Date.now()
        releaseClaim(s)
    }
    const progress = (s) => {
        s.busy = true
        s.lastActivityAt = Date.now()
    }

    function recordContinue(s) {
        const now = Date.now()
        s.continues = s.continues.filter((at) => now - at < loopWindowMs)
        s.continues.push(now)
    }

    function loopBlocked(s) {
        const now = Date.now()
        s.continues = s.continues.filter((at) => now - at < loopWindowMs)
        return s.continues.length >= loopMaxContinues
    }

    const backoffMs = (attempts) =>
        Math.min(maxBackoffMs, baseBackoffMs * Math.pow(2, Math.max(0, attempts)))

    // ---------------------------------------------------------------- usage limit
    function isUsageLimitSignal(error) {
        if (!usageLimitEnabled || !error) return false
        const type = typeof error.type === 'string' ? error.type : ''
        if (type === 'provider.quota') return true
        const message = typeof error.message === 'string' ? error.message : ''
        const lower = message.toLowerCase()
        for (const pattern of usageLimitMessagePatterns) {
            if (!pattern) continue
            try {
                if (new RegExp(pattern, 'i').test(lower)) return true
            } catch {
                if (lower.includes(String(pattern).toLowerCase())) return true
            }
        }
        const status = error.status ?? error.statusCode
        if (status === 429 && /limit/i.test(message)) return true
        return lower.includes('usage limit')
    }

    function probeUsageLimits(modelID) {
        const script = usageLimitScript
        const fail = (reason, message) => ({
            ok: false,
            limitReached: false,
            resetAtMs: null,
            resumeAtMs: null,
            decidingWindow: null,
            graceMs: usageLimitGraceMs,
            reason,
            message,
        })
        if (!script) return Promise.resolve(fail('script-missing', 'no usage-limit script configured'))
        const args = ['--json']
        if (modelID) args.push('--model', modelID)
        args.push('--grace', String(Math.round(usageLimitGraceMs / 1000)))
        return new Promise((resolve) => {
            execFile(
                script,
                args,
                { timeout: usageLimitTimeoutMs + 5_000, maxBuffer: 1 << 20 },
                (error, stdout) => {
                    // codex-limits reports the quota state through its exit code:
                    // 0 = no limit, 3 = limit with a known resume_at, 4 = limit
                    // with the resume moment still unknown, 1 = real failure.
                    // Exits 3 and 4 still print the JSON snapshot on stdout, so
                    // they must be parsed exactly like a successful probe instead
                    // of being discarded as a script error.
                    const quotaExit = Boolean(error) && (error.code === 3 || error.code === 4)
                    if (error && !quotaExit) {
                        const detail = [error.code, error.signal, error.stderr]
                            .filter((v) => v !== undefined && v !== null && v !== '')
                            .map((v) => String(v).trim())
                            .join(' | ')
                        resolve(fail('script-error', `${error.message}${detail ? ` [${detail}]` : ''}`))
                        return
                    }
                    let parsed
                    try {
                        parsed = JSON.parse(String(stdout))
                    } catch (err) {
                        const suffix = quotaExit ? ` (exit ${error.code})` : ''
                        resolve(fail('script-output', `${String(err?.message ?? err)}${suffix}`))
                        return
                    }
                    if (parsed.ok === false) {
                        resolve(
                            fail(
                                typeof parsed.reason === 'string' ? parsed.reason : 'script-error',
                                typeof parsed.message === 'string' ? parsed.message : '',
                            ),
                        )
                        return
                    }
                    const secondsToMs = (value) =>
                        typeof value === 'number' && Number.isFinite(value)
                            ? Math.round(value * 1000)
                            : null
                    resolve({
                        ok: true,
                        limitReached: parsed.limit_reached === true,
                        resetAtMs: secondsToMs(parsed.reset_at),
                        resumeAtMs: secondsToMs(parsed.resume_at),
                        decidingWindow:
                            typeof parsed.deciding_window === 'string'
                                ? parsed.deciding_window
                                : null,
                        graceMs:
                            typeof parsed.grace_seconds === 'number'
                                ? parsed.grace_seconds * 1000
                                : usageLimitGraceMs,
                    })
                },
            )
        })
    }

    function clearUsageLimit(s, reason) {
        s.usageLimitPending = false
        if (!s.usageLimit) return
        if (s.usageLimit.timer) clearTimeout(s.usageLimit.timer)
        s.usageLimit = null
        log('info', `Usage-limit wait cleared on ${short(s.sid)}: ${reason}`)
    }

    function armUsageLimitResume(s, resumeAtMs, resetAtMs, decidingWindow, rechecks) {
        if (s.usageLimit?.timer) clearTimeout(s.usageLimit.timer)
        s.usageLimitPending = false
        const now = Date.now()
        const capped = Math.min(Math.max(resumeAtMs, now + 1_000), now + usageLimitMaxWaitMs)
        s.usageLimit = {
            resumeAtMs: capped,
            resetAtMs,
            decidingWindow,
            rechecks,
            timer: null,
        }
        s.resumeAttempts = 0
        s.gaveUp = false
        s.lastRetryAt = now
        const delay = Math.max(1_000, Math.min(capped - now, MAX_TIMER_DELAY_MS))
        const timer = setTimeout(() => {
            void onUsageLimitTimer(s.sid)
        }, delay)
        if (typeof timer.unref === 'function') timer.unref()
        s.usageLimit.timer = timer
        log(
            'info',
            `Usage limit on ${short(s.sid)} (${s.providerID ?? '?'}/${s.modelID ?? '?'}): ` +
                `resume scheduled at ${formatLocalTime(capped)} (in ${formatDuration(capped - now)})` +
                (resetAtMs ? `, window reset ${formatLocalTime(resetAtMs)}` : '') +
                (decidingWindow ? ` [${decidingWindow}]` : '') +
                `, no retries until then`,
        )
    }

    function applyUsageLimitProbe(s, probe, rechecks) {
        const now = Date.now()
        if (!probe.ok) {
            if (rechecks >= usageLimitMaxRechecks) {
                log(
                    'warn',
                    `Usage limit on ${short(s.sid)}: cannot determine reset ` +
                        `(${probe.reason}: ${probe.message}); giving up after ${rechecks} rechecks`,
                )
                clearUsageLimit(s, 'rechecks exhausted')
                return true
            }
            const nextCheck = now + usageLimitRecheckMs
            armUsageLimitResume(s, nextCheck, null, null, rechecks + 1)
            log(
                'warn',
                `Usage limit on ${short(s.sid)}: reset unknown (${probe.reason}: ${probe.message}); ` +
                    `recheck at ${formatLocalTime(nextCheck)} (${rechecks + 1}/${usageLimitMaxRechecks})`,
            )
            return true
        }
        if (!probe.limitReached) {
            log(
                'info',
                `Usage-limit signal on ${short(s.sid)} is stale: usage endpoint reports ` +
                    `${s.providerID ?? '?'}/${s.modelID ?? '?'} available; falling back to normal recovery`,
            )
            return false
        }
        if (probe.resumeAtMs === null) {
            if (rechecks >= usageLimitMaxRechecks) {
                log(
                    'warn',
                    `Usage limit on ${short(s.sid)}: reset moment still unknown after ${rechecks} rechecks; giving up`,
                )
                clearUsageLimit(s, 'rechecks exhausted')
                return true
            }
            const nextCheck = now + usageLimitRecheckMs
            armUsageLimitResume(s, nextCheck, probe.resetAtMs, probe.decidingWindow, rechecks + 1)
            log(
                'warn',
                `Usage limit on ${short(s.sid)}: reset moment unknown, recheck at ` +
                    `${formatLocalTime(nextCheck)} (${rechecks + 1}/${usageLimitMaxRechecks})`,
            )
            return true
        }
        armUsageLimitResume(s, probe.resumeAtMs, probe.resetAtMs, probe.decidingWindow, rechecks)
        return true
    }

    async function onUsageLimitTimer(sid) {
        const s = sessions.get(sid)
        if (!s || !s.usageLimit) return
        const wait = s.usageLimit
        wait.timer = null
        if (s.userCancelled) {
            clearUsageLimit(s, 'session closed by user')
            return
        }
        log('info', `Usage-limit wait elapsed on ${short(sid)}: re-checking provider usage`)
        const probe = await probeUsageLimits(wait.modelID)
        if (applyUsageLimitProbe(s, probe, wait.rechecks)) return
        clearUsageLimit(s, 'limit reset')
        log('info', `${short(sid)} - usage limit reset, resuming`)
        const text = resumeNoteEnabled
            ? `${continuePrompt}\n\n${resumeNoteText}`
            : continuePrompt
        try {
            await deliver(s, text, 'usage-limit-reset')
        } catch (err) {
            log('warn', `${short(sid)} - resume after usage limit failed: ${err?.message ?? err}`)
        }
    }

    async function handleQuotaSignal(sid, error, origin) {
        if (!usageLimitEnabled || !sid) return
        if (!isUsageLimitSignal(error)) return
        const s = ensureWatch(sid)
        const fingerprint = `${origin}:${error?.type ?? ''}:${error?.status ?? ''}:${error?.message ?? ''}`
        if (s.lastQuotaErrorId === fingerprint) {
            dbg(`Quota signal ${fingerprint} on ${short(sid)} already handled`)
            return
        }
        if (s.usageLimit && s.usageLimit.resumeAtMs > Date.now()) {
            s.lastQuotaErrorId = fingerprint
            dbg(`Quota signal on ${short(sid)} ignored: wait armed until ${formatLocalTime(s.usageLimit.resumeAtMs)}`)
            return
        }
        if (s.usageLimitPending) {
            dbg(`Quota signal on ${short(sid)} suppressed: probe already in flight`)
            return
        }
        // Sync marker before any await: watchdog paths consult it between
        // detection and arming and must not prompt into a limited API.
        s.usageLimitPending = true
        s.lastQuotaErrorId = fingerprint
        try {
            const providerID = (s.providerID ?? error?.providerID ?? '').toString()
            const modelID = s.modelID ?? error?.modelID ?? null
            if (!providerID) {
                log(
                    'info',
                    `Usage-limit signal on ${short(sid)} ignored: provider unknown ` +
                        `(${(error?.message ?? '').slice(0, 200)})`,
                )
                return
            }
            if (!usageLimitProviders.includes(providerID.toLowerCase())) {
                log(
                    'info',
                    `Usage-limit signal on ${short(sid)} ignored: provider ${providerID} is not in ` +
                        `usageLimitProviders (${usageLimitProviders.join(', ')})`,
                )
                return
            }
            log(
                'info',
                `Usage limit reported on ${short(sid)} (${providerID}/${modelID ?? '?'}) via ${origin}: ` +
                    `${(error?.message ?? '').slice(0, 200)}; querying provider usage endpoint`,
            )
            const probe = await probeUsageLimits(modelID)
            const waiting = applyUsageLimitProbe(s, probe, 0)
            if (!waiting && probe.limitReached === false) {
                s.usageLimitPending = false
                const resumed = await tryResume(s, 'usage-limit-stale')
                if (
                    !resumed &&
                    !s.staleRetryScheduled &&
                    !s.gaveUp &&
                    s.resumeAttempts < maxRetries
                ) {
                    s.staleRetryScheduled = true
                    const timer = setTimeout(() => {
                        s.staleRetryScheduled = false
                        void tryResume(s, 'usage-limit-stale-retry')
                    }, backoffMs(s.resumeAttempts) + 250)
                    if (typeof timer.unref === 'function') timer.unref()
                }
            }
        } finally {
            if (!s.usageLimit) s.usageLimitPending = false
        }
    }

    // ------------------------------------------------------------------- resume
    // Cross-instance claim: every live plugin copy (the host re-imports the
    // module on config reloads) and every process runs its own watchdog over
    // the same sessions. The 2026-11-21 incident had six phase-aligned
    // watchdogs send six "continue" prompts into one session within 0.9s.
    // A resume is claimed on disk first; a fresh claim from any other instance
    // blocks the nudge, a stale one (crashed instance) is taken over. The
    // claim is released on the next observed activity for the session.
    function releaseClaim(s) {
        if (!s.claimPath) return
        const file = s.claimPath
        s.claimPath = null
        try {
            fs.rmSync(file, { force: true })
        } catch {
            // TTL expiry is the fallback for a failed removal.
        }
    }

    function acquireClaim(s, reason) {
        if (!claimDir) return true
        if (s.claimPath) return true
        const file = path.join(claimDir, `${s.sid}.json`)
        try {
            fs.mkdirSync(claimDir, { recursive: true })
            fs.writeFileSync(file, JSON.stringify({ at: Date.now(), reason }), { flag: 'wx' })
        } catch (err) {
            if (err?.code !== 'EEXIST') {
                // A broken claim store must not wedge the recovery itself.
                return true
            }
            let at = 0
            try {
                at = JSON.parse(fs.readFileSync(file, 'utf8'))?.at ?? 0
            } catch {
                // Unreadable claim is treated as stale below.
            }
            if (Date.now() - at < claimTtlMs) return false
            try {
                fs.writeFileSync(file, JSON.stringify({ at: Date.now(), reason }))
            } catch {
                return false
            }
        }
        s.claimPath = file
        return true
    }

    async function deliver(s, text, reason) {
        if (s.usageLimit || s.usageLimitPending) {
            dbg(`Resume suppressed on ${short(s.sid)}: usage-limit wait active`)
            return false
        }
        if (s.userCancelled || s.gaveUp) return false
        if (s.questionPending) return false
        if (s.continuing) {
            dbg(`${short(s.sid)} - continue already in progress, skipping`)
            return false
        }
        if (s.pendingTools > 0 || s.promptBlocked) {
            dbg(`${short(s.sid)} - resume suppressed: ${s.pendingTools} tool(s) in flight, promptBlocked=${s.promptBlocked}`)
            return false
        }
        if (!acquireClaim(s, reason)) {
            dbg(`${short(s.sid)} - resume skipped: fresh claim by another auto-resume instance`)
            return false
        }
        s.continuing = true
        const metadata = { source: 'auto-resume', reason }
        try {
            try {
                await ctx.session.prompt({ sessionID: s.sid, text, delivery: 'steer', resume: true, metadata })
            } catch (err) {
                log('warn', `${short(s.sid)} - prompt failed (${err?.message ?? err}); trying synthetic input`)
                await ctx.session.synthetic({
                    sessionID: s.sid,
                    text,
                    description: `auto-resume: ${reason}`,
                    delivery: 'steer',
                    resume: true,
                    metadata,
                })
            }
            recordContinue(s)
            s.lastRetryAt = Date.now()
            s.lastActivityAt = Date.now()
            log('info', `${short(s.sid)} - resume prompt sent (reason: ${reason})`)
            return true
        } catch (err) {
            releaseClaim(s)
            log('error', `${short(s.sid)} - resume delivery failed: ${err?.message ?? err}`)
            return false
        } finally {
            s.continuing = false
        }
    }

    async function tryResume(s, reason) {
        if (!s || s.usageLimit || s.usageLimitPending) return false
        if (s.continuing || s.userCancelled || s.gaveUp) return false
        if (s.pendingTools > 0 || s.promptBlocked) return false
        if (s.questionPending) {
            dbg(`${short(s.sid)} - resume suppressed: question pending`)
            return false
        }
        const now = Date.now()
        if (s.lastRetryAt > 0 && now - s.lastRetryAt < backoffMs(s.resumeAttempts)) return false
        if (s.resumeAttempts >= maxRetries) {
            s.gaveUp = true
            log('warn', `${short(s.sid)} - giving up after ${s.resumeAttempts} resume attempts`)
            return false
        }
        if (loopBlocked(s)) {
            log(
                'warn',
                `${short(s.sid)} - nudge suppressed: ${s.continues.length} resumes within ` +
                    `${Math.round(loopWindowMs / 1000)}s`,
            )
            return false
        }
        s.resumeAttempts += 1
        return await deliver(s, continuePrompt, reason)
    }

    // ------------------------------------------------------------------ watchdog
    // Subscription liveness: the watchdog must not nudge on state derived
    // from a dead subscription. The 2026-11-21 incident: subscriptions went
    // silently deaf (the stream neither delivers nor ends), timers kept
    // ticking, and the watchdog sent "continue" into a session that was
    // actively streaming. If no event of any kind has been received for the
    // whole stall window, the subscription itself is suspect: resubscribe and
    // defer the nudge by one window so a still-alive stream can prove itself
    // with fresh events.
    let lastEventAt = Date.now()
    let deafEpisodeAt = 0
    let generation = 0

    function forceResubscribe() {
        generation += 1
        void startEventLoop()
    }

    const watchdog = setInterval(() => {
        if (stopped) return
        const now = Date.now()
        const windowMs = chunkTimeoutMs + gracePeriodMs
        for (const s of sessions.values()) {
            if (!s.busy || s.usageLimit || s.usageLimitPending) continue
            if (s.userCancelled || s.continuing || s.gaveUp) continue
            if (s.pendingTools > 0 || s.promptBlocked) continue
            if (s.questionPending) continue
            if (!s.executionStartedAt) continue
            if (now - s.executionStartedAt < warmupMs) continue
            const idle = now - s.lastActivityAt
            if (idle < windowMs) continue
            if (now - lastEventAt >= windowMs) {
                if (!deafEpisodeAt) {
                    deafEpisodeAt = now
                    log(
                        'info',
                        `${short(s.sid)} - no events received for ${formatDuration(now - lastEventAt)}; ` +
                            `subscription looks deaf: resubscribing and deferring the stall nudge`,
                    )
                    forceResubscribe()
                }
                if (now - deafEpisodeAt < windowMs) continue
            }
            dbg(`${short(s.sid)} - stall detected: idle ${formatDuration(idle)}`)
            void tryResume(s, 'stall')
        }
    }, checkIntervalMs)
    if (typeof watchdog.unref === 'function') watchdog.unref()

    // -------------------------------------------------------------------- events
    async function handleEvent(env) {
        // Any delivered envelope proves the subscription is alive.
        lastEventAt = Date.now()
        deafEpisodeAt = 0
        const type = env?.type
        const data = asObject(env?.data)
        const sid = typeof data.sessionID === 'string' ? data.sessionID : null
        if (!sid) return
        const s = ensureWatch(sid)
        if (type === 'session.created') {
            s.lastActivityAt = Date.now()
            return
        }
        if (type === 'session.deleted') {
            if (s.usageLimit?.timer) clearTimeout(s.usageLimit.timer)
            releaseClaim(s)
            sessions.delete(sid)
            return
        }
        if (type === 'session.inbox.enqueued') {
            const item = data.item ?? {}
            const kind = item?.type ?? 'unknown'
            const fromUs = item?.payload?.metadata?.source === 'auto-resume'
            if (kind === 'user' && !fromUs) {
                s.userCancelled = false
                s.staleRetryScheduled = false
                s.gaveUp = false
                s.resumeAttempts = 0
                s.continues = []
                s.lastActivityAt = Date.now()
            }
            return
        }
        if (type === 'permission.asked') {
            s.promptBlocked = true
            touch(s)
            dbg(`${short(sid)} - permission prompt pending, resume suppressed`)
            return
        }
        if (type === 'permission.replied') {
            s.promptBlocked = false
            touch(s)
            return
        }
        // A pending question tool keeps the execution "busy" while the run
        // silently waits for a human answer. Without this guard the stall
        // watchdog nudges the session with "continue" while the user is still
        // choosing (the v1 pending-question protection, lost in the port).
        if (type === 'form.created') {
            s.questionPending = true
            touch(s)
            dbg(`${short(sid)} - question pending, resume suppressed`)
            return
        }
        if (type === 'form.replied' || type === 'form.cancelled') {
            s.questionPending = false
            touch(s)
            dbg(`${short(sid)} - question ${type === 'form.replied' ? 'answered' : 'cancelled'}`)
            return
        }
        if (type === 'session.execution.started') {
            s.busy = true
            s.executionStartedAt = Date.now()
            s.lastActivityAt = Date.now()
            // A new run implies the previous question was answered or dropped.
            s.questionPending = false
            return
        }
        if (type === 'session.execution.interrupted') {
            s.busy = false
            s.userCancelled = true
            s.questionPending = false
            clearUsageLimit(s, 'session interrupted by user')
            log('info', `${short(sid)} - user interrupted the run; auto-resume disarmed until next input`)
            return
        }
        if (type === 'session.execution.succeeded' || type === 'session.idle') {
            s.busy = false
            s.resumeAttempts = 0
            s.lastActivityAt = Date.now()
            return
        }
        if (type === 'session.execution.failed') {
            s.busy = false
            await handleQuotaSignal(sid, data.error, 'execution.failed')
            return
        }
        if (type === 'session.step.failed') {
            await handleQuotaSignal(sid, data.error, 'step.failed')
            return
        }
        if (type === 'session.retry.scheduled') {
            progress(s)
            dbg(`${short(sid)} - provider retry scheduled; activity touched`)
            return
        }
        // Stray events (tool/bookkeeping noise) must only refresh activity.
        // `busy` is owned exclusively by session.execution.* events: letting a
        // stray event set it resurrects finished runs and later makes the
        // watchdog nudge sessions that are quietly waiting for user input.
        touch(s)
    }

    async function startEventLoop() {
        // The subscription is not guaranteed to live for the whole service
        // uptime: if the stream ends or errors out once, the loop below would
        // previously exit and leave every session's busy/lastActivity state
        // frozen forever (zombie state -> phantom stall nudges). Restart the
        // subscription with a small delay until the plugin is stopped.
        //
        // A generation bump (forceResubscribe, from the deaf-subscription
        // guard) supersedes the running loop: it exits without resubscribing
        // and a fresh loop takes over. The superseded coroutine stays
        // suspended on its pending next() until the host provides a way to
        // dispose a subscription (E12: none on opencode 2.3.2).
        while (!stopped) {
            const myGen = generation
            let sub = null
            try {
                sub = ctx.event.subscribe({ types: SUBSCRIBED_EVENTS })
            } catch (err) {
                log('error', `event.subscribe failed: ${err?.message ?? err}`)
            }
            if (sub && typeof sub[Symbol.asyncIterator] === 'function') {
                try {
                    for await (const env of sub) {
                        if (stopped) break
                        try {
                            await handleEvent(env)
                        } catch (err) {
                            log('error', `event handler failed on ${env?.type}: ${err?.message ?? err}`)
                        }
                    }
                } catch (err) {
                    log('error', `event stream failed: ${err?.message ?? err}`)
                }
            } else if (sub) {
                log('error', `event.subscribe returned a non-async-iterable (${typeof sub})`)
            }
            if (stopped) break
            if (generation !== myGen) break
            dbg(`event stream ended; resubscribing in ${restartDelayMs}ms`)
            await new Promise((resolve) => setTimeout(resolve, restartDelayMs))
        }
    }

    // --------------------------------------------------------------------- hooks
    function registerHook(label, factory) {
        try {
            const handle = factory()
            if (handle && typeof handle.then === 'function') {
                handle.then(
                    (h) => {
                        if (h && typeof h.dispose === 'function') disposers.push(h.dispose)
                    },
                    (err) => log('warn', `${label} hook failed: ${err?.message ?? err}`),
                )
            } else if (handle && typeof handle.dispose === 'function') {
                disposers.push(handle.dispose)
            }
            return true
        } catch (err) {
            log('warn', `${label} hook failed: ${err?.message ?? err}`)
            return false
        }
    }

    return {
        async start() {
            if (opts.__optionsError) log('warn', `options: ${opts.__optionsError}`)
            if (usageLimitEnabled && !usageLimitScript) {
                log('warn', 'usage-limit recovery enabled but no codex-limits script found; probe will recheck and give up')
            }

            // Provider/model tracker: fires per model request with a reliable
            // providerID/modelID (v2 replacement for getSessionProviderModel).
            registerHook('model.request', () =>
                ctx.session.hook('model.request', (event) => {
                    const sid = event?.sessionID
                    if (typeof sid !== 'string') return
                    const s = ensureWatch(sid)
                    const providerID = event?.model?.providerID
                    const modelID = event?.model?.id ?? event?.model?.modelID
                    if (typeof providerID === 'string') s.providerID = providerID
                    if (typeof modelID === 'string') s.modelID = modelID
                    if (typeof event?.agent === 'string') s.agent = event.agent
                }),
            )

            // Early quota signal; step.failed/execution.failed re-confirm it.
            registerHook('retry', () =>
                ctx.session.hook('retry', (event) => {
                    const sid = event?.sessionID
                    if (typeof sid !== 'string') return
                    const s = ensureWatch(sid)
                    if (typeof event?.model?.providerID === 'string') s.providerID = event.model.providerID
                    if (typeof event?.model?.id === 'string') s.modelID = event.model.id
                    void handleQuotaSignal(sid, event?.error, 'retry-hook')
                }),
            )

            // In-flight tool protection (v1 tool.execute.before/after). The
            // question tool is tracked by the dedicated questionPending flag
            // instead of pendingTools: on opencode 2.3.2 it surfaces as
            // execute.before and its answer arrives through form.* events, so
            // a stuck pendingTools counter would block resumes forever.
            registerHook('tool.execute.before', () =>
                ctx.tool.hook('execute.before', (event) => {
                    const sid = event?.sessionID
                    if (typeof sid !== 'string') return
                    const s = ensureWatch(sid)
                    if (event?.tool === 'question') {
                        s.questionPending = true
                        touch(s)
                        dbg(`${short(sid)} - question tool in flight, resume suppressed`)
                        return
                    }
                    s.pendingTools += 1
                    touch(s)
                }),
            )
            registerHook('tool.execute.after', () =>
                ctx.tool.hook('execute.after', (event) => {
                    const sid = event?.sessionID
                    if (typeof sid !== 'string') return
                    const s = ensureWatch(sid)
                    if (event?.tool === 'question') {
                        s.questionPending = false
                        touch(s)
                        return
                    }
                    s.pendingTools = Math.max(0, s.pendingTools - 1)
                    touch(s)
                }),
            )

            void startEventLoop()
            log(
                'info',
                'opencode-auto-resume (v2) ready. ' +
                    `timeout=${chunkTimeoutMs}ms, grace=${gracePeriodMs}ms, warmup=${warmupMs}ms, ` +
                    `loop=${loopMaxContinues}x/${Math.round(loopWindowMs / 1000)}s, ` +
                    `usageLimit=${usageLimitEnabled ? `on (${usageLimitProviders.join(',')})` : 'off'}, ` +
                    `script=${usageLimitScript ?? '(none)'}, log=${opts.logFile ?? '(app log only)'}`,
            )
        },
        stop() {
            stopped = true
            clearInterval(watchdog)
            for (const s of sessions.values()) {
                if (s.usageLimit?.timer) clearTimeout(s.usageLimit.timer)
                releaseClaim(s)
            }
            for (const dispose of disposers) {
                try {
                    dispose()
                } catch {
                    // ignore
                }
            }
        },
        sessions,
        log: logger.entries,
    }
}

// The host may call setup() more than once per service run (per project, or on
// config-watcher reloads) and it re-imports the plugin module on every reload
// (2026-11-21 incident: four auto-resume imports in the same server process in
// one second). Every live instance runs its own watchdog over the same global
// session bus, so stale or concurrent instances send duplicate "continue"
// nudges into the same session. Keep exactly one active instance. The slot
// lives on globalThis because a module-level variable is per module copy and
// re-imported copies do not see each other.
const ACTIVE_SLOT = '__opencodeAutoResumeActive'

export default {
    id: 'auto-resume',
    async setup(ctx) {
        if (globalThis[ACTIVE_SLOT]) {
            try {
                globalThis[ACTIVE_SLOT].stop()
            } catch {
                // ignore
            }
            globalThis[ACTIVE_SLOT] = null
        }
        const instance = createPlugin(ctx)
        globalThis[ACTIVE_SLOT] = instance
        await instance.start()
        return instance
    },
}
