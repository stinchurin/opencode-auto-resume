// Contract tests for the v2 auto-resume plugin.
//
// The plugin takes the host `ctx` as a parameter, so the whole event/hook/timer
// surface can be driven by a fake host: no server, no provider, no model calls.
// Run with: bun test test/plugin.test.mjs

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import plugin from '../plugin.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-resume-test-'))

function writeScript(name, body) {
    const file = path.join(TMP, `${name}-${Math.random().toString(36).slice(2)}.sh`)
    fs.writeFileSync(file, `#!/bin/sh\n${body}\n`)
    fs.chmodSync(file, 0o755)
    return file
}

function limitsScript({ firstResumeInSeconds = 1, alwaysLimited = false }) {
    const state = path.join(TMP, `state-${Math.random().toString(36).slice(2)}`)
    const cleared =
        '{"ok":true,"limit_reached":false,"reset_at":null,"resume_at":null,"grace_seconds":0}'
    const limited = (secs) =>
        `{"ok":true,"limit_reached":true,"reset_at":$((NOW + 3600)),"resume_at":$((NOW + ${secs})),"deciding_window":"5h","grace_seconds":0}`
    const body = [
        'NOW=$(date +%s)',
        `STATE="${state}"`,
        'N=0',
        '[ -f "$STATE" ] && N=$(cat "$STATE" 2>/dev/null || echo 0)',
        'N=$((N + 1))',
        'echo "$N" > "$STATE"',
        alwaysLimited
            ? `echo '${limited(firstResumeInSeconds)}'`
            : `if [ "$N" -le 1 ]; then echo '${limited(firstResumeInSeconds)}'; else echo '${cleared}'; fi`,
        'exit 0',
    ].join('\n')
    return writeScript('limits', body)
}

function createHost(overrides = {}) {
    const queue = []
    let wake = null
    const notify = () => {
        if (wake) {
            const resume = wake
            wake = null
            resume()
        }
    }

    const state = {
        prompts: [],
        synthetic: [],
        hooks: new Map(),
        toolHooks: new Map(),
        logs: [],
        subscribed: null,
        subscribeCount: 0,
        streamEnded: false,
        disposed: 0,
    }

    const ctx = {
        options: { usageLimitProviders: ['lanit'], logFile: null, ...overrides },
        app: {},
        location: { directory: TMP },
        session: {
            hook(name, handler) {
                if (!state.hooks.has(name)) state.hooks.set(name, [])
                state.hooks.get(name).push(handler)
                return { dispose: () => {} }
            },
            async prompt(payload) {
                state.prompts.push(payload)
                return { ok: true }
            },
            async synthetic(payload) {
                state.synthetic.push(payload)
                return { ok: true }
            },
        },
        tool: {
            hook(name, handler) {
                state.toolHooks.set(name, handler)
                return { dispose: () => {} }
            },
        },
        event: {
            subscribe({ types }) {
                state.subscribed = types
                state.subscribeCount += 1
                state.streamEnded = false
                const iterable = {
                    [Symbol.asyncIterator]() {
                        return {
                            async next() {
                                while (queue.length === 0) {
                                    if (state.streamEnded) return { done: true }
                                    await new Promise((resolve) => {
                                        wake = resolve
                                    })
                                }
                                return { value: queue.shift(), done: false }
                            },
                        }
                    },
                }
                return iterable
            },
        },
    }

    return {
        ctx,
        state,
        emit(type, data) {
            queue.push({ id: `evt_${type}`, created: Date.now(), type, data })
            notify()
        },
        endStream() {
            state.streamEnded = true
            notify()
        },
        fireHook(name, payload) {
            const handlers = state.hooks.get(name) ?? []
            for (const handler of handlers) handler(payload)
            return handlers.length
        },
        fireToolHook(name, payload) {
            const handler = state.toolHooks.get(name)
            if (handler) handler(payload)
            return Boolean(handler)
        },
    }
}

async function waitFor(predicate, { timeoutMs = 5000, stepMs = 20 } = {}) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        if (predicate()) return true
        await new Promise((resolve) => setTimeout(resolve, stepMs))
    }
    return predicate()
}

const quotaError = {
    type: 'provider.quota',
    message: 'You have hit your ChatGPT usage limit (plus plan). Try again in 3 hours.',
    status: 429,
    response: {
        body: '{"error": {"message": "You have hit your ChatGPT usage limit", "code": "usage_limit_reached"}}',
    },
    retryAfterMs: 60000,
}

let host
let instance

beforeEach(() => {
    process.env.AUTO_RESUME_OPTIONS_FILE = path.join(TMP, 'no-sidecar.json')
    delete process.env.OPENCODE_DIR
})

afterEach(() => {
    if (instance?.stop) instance.stop()
    instance = null
    host = null
})

async function start(overrides) {
    host = createHost(overrides)
    instance = await plugin.setup(host.ctx)
    await waitFor(() => host.state.subscribed !== null, { timeoutMs: 2000 })
    return host
}

const primeModel = () =>
    host.fireHook('model.request', {
        sessionID: 'ses_test',
        agent: 'build',
        kind: 'primary',
        model: { providerID: 'lanit', id: 'DKS-Leo' },
    })

describe('event subscription', () => {
    test('subscribes only to event types the host accepts', async () => {
        await start({})
        expect(host.state.subscribed).toContain('session.step.failed')
        expect(host.state.subscribed).toContain('session.execution.interrupted')
        expect(host.state.subscribed).toContain('permission.asked')
        expect(host.state.subscribed).toContain('form.created')
        expect(host.state.subscribed).toContain('form.replied')
        expect(host.state.subscribed).toContain('form.cancelled')
        for (const rejected of ['session.error', 'session.updated', 'session.interrupted']) {
            expect(host.state.subscribed).not.toContain(rejected)
        }
    })

    // Probe evidence (2026-11-21, opencode 2.3.2): session.status is a v1
    // concept — the v2 bus never delivers it and handleEvent has no case for
    // it; it only weighed down the subscription filter.
    test('does not subscribe to event types the v2 bus never delivers', async () => {
        await start({})
        expect(host.state.subscribed).not.toContain('session.status')
    })
})

describe('usage limit', () => {
    test('waits for the reset window and resumes exactly once', async () => {
        await start({
            usageLimitScript: limitsScript({ firstResumeInSeconds: 1 }),
            usageLimitRecheckMs: 500,
            usageLimitMaxRechecks: 3,
            chunkTimeoutMs: 600000,
            checkIntervalMs: 50,
            debug: true,
        })
        primeModel()
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        host.emit('session.step.failed', { sessionID: 'ses_test', error: quotaError })
        host.emit('session.execution.failed', { sessionID: 'ses_test', error: quotaError })

        const resumed = await waitFor(() => host.state.prompts.length > 0, { timeoutMs: 6000 })
        expect(resumed).toBe(true)
        expect(host.state.prompts.length).toBe(1)
        expect(host.state.prompts[0].metadata.reason).toBe('usage-limit-reset')
        expect(host.state.prompts[0].text).toContain('continue')
        expect(host.state.prompts[0].text).toContain('resumed automatically')
    })

    test('ignores a provider outside usageLimitProviders', async () => {
        await start({
            usageLimitProviders: ['openai'],
            usageLimitScript: limitsScript({ firstResumeInSeconds: 1 }),
            chunkTimeoutMs: 600000,
            checkIntervalMs: 50,
        })
        primeModel()
        host.emit('session.step.failed', { sessionID: 'ses_test', error: quotaError })
        await new Promise((resolve) => setTimeout(resolve, 600))
        expect(host.state.prompts.length).toBe(0)
    })

    test('rechecks without prompting when the reset moment is unknown', async () => {
        const unknown = writeScript(
            'unknown',
            'echo \'{"ok":false,"reason":"fake-no-window","message":"reset unknown"}\'\nexit 0',
        )
        await start({
            usageLimitScript: unknown,
            usageLimitRecheckMs: 200,
            usageLimitMaxRechecks: 1,
            chunkTimeoutMs: 600000,
            checkIntervalMs: 50,
        })
        primeModel()
        host.emit('session.step.failed', { sessionID: 'ses_test', error: quotaError })
        await new Promise((resolve) => setTimeout(resolve, 1200))
        expect(host.state.prompts.length).toBe(0)
    })
})

describe('suppression', () => {
    test('user interrupt disarms the wait and stops the resume', async () => {
        await start({
            usageLimitScript: limitsScript({ firstResumeInSeconds: 1, alwaysLimited: true }),
            usageLimitRecheckMs: 500,
            chunkTimeoutMs: 600000,
            checkIntervalMs: 50,
        })
        primeModel()
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        host.emit('session.step.failed', { sessionID: 'ses_test', error: quotaError })
        await new Promise((resolve) => setTimeout(resolve, 200))
        host.emit('session.execution.interrupted', { sessionID: 'ses_test' })
        await new Promise((resolve) => setTimeout(resolve, 1800))
        expect(host.state.prompts.length).toBe(0)
    })

    test('in-flight tool blocks the stall resume until it finishes', async () => {
        await start({
            usageLimitEnabled: false,
            chunkTimeoutMs: 80,
            checkIntervalMs: 20,
            gracePeriodMs: 0,
            warmupMs: 0,
            baseBackoffMs: 10,
            maxRetries: 3,
        })
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        host.fireToolHook('execute.before', { sessionID: 'ses_test', tool: 'bash' })
        await new Promise((resolve) => setTimeout(resolve, 400))
        expect(host.state.prompts.length).toBe(0)
        host.fireToolHook('execute.after', { sessionID: 'ses_test', tool: 'bash' })
        const resumed = await waitFor(() => host.state.prompts.length === 1, { timeoutMs: 1500 })
        expect(resumed).toBe(true)
    })

    test('pending permission blocks the stall resume until answered', async () => {
        await start({
            usageLimitEnabled: false,
            chunkTimeoutMs: 80,
            checkIntervalMs: 20,
            gracePeriodMs: 0,
            warmupMs: 0,
            baseBackoffMs: 10,
        })
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        host.emit('permission.asked', { sessionID: 'ses_test', permissionID: 'p1' })
        await new Promise((resolve) => setTimeout(resolve, 400))
        expect(host.state.prompts.length).toBe(0)
        host.emit('permission.replied', { sessionID: 'ses_test', permissionID: 'p1' })
        const resumed = await waitFor(() => host.state.prompts.length === 1, { timeoutMs: 1500 })
        expect(resumed).toBe(true)
    })
})

describe('pending question guard', () => {
    const stallOptions = {
        usageLimitEnabled: false,
        chunkTimeoutMs: 80,
        checkIntervalMs: 20,
        gracePeriodMs: 0,
        warmupMs: 0,
        baseBackoffMs: 10,
    }

    test('a pending question blocks the stall resume until the user answers', async () => {
        await start({ ...stallOptions })
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        host.emit('form.created', { sessionID: 'ses_test' })
        await new Promise((resolve) => setTimeout(resolve, 400))
        expect(host.state.prompts.length).toBe(0)
        host.emit('form.replied', { sessionID: 'ses_test' })
        const resumed = await waitFor(() => host.state.prompts.length === 1, { timeoutMs: 1500 })
        expect(resumed).toBe(true)
        expect(host.state.prompts[0].metadata.reason).toBe('stall')
    })

    test('a cancelled question also releases the stall resume', async () => {
        await start({ ...stallOptions })
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        host.emit('form.created', { sessionID: 'ses_test' })
        await new Promise((resolve) => setTimeout(resolve, 400))
        expect(host.state.prompts.length).toBe(0)
        host.emit('form.cancelled', { sessionID: 'ses_test' })
        const resumed = await waitFor(() => host.state.prompts.length === 1, { timeoutMs: 1500 })
        expect(resumed).toBe(true)
    })

    test('a question tool left in flight is released by the form reply', async () => {
        await start({ ...stallOptions })
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        await waitFor(() => instance.sessions.get('ses_test')?.busy === true, { timeoutMs: 1500 })
        // In real runs the question tool fires execute.before but never
        // execute.after (the answer arrives through the form channel).
        host.fireToolHook('execute.before', { sessionID: 'ses_test', tool: 'question' })
        await new Promise((resolve) => setTimeout(resolve, 400))
        expect(host.state.prompts.length).toBe(0)
        host.emit('form.replied', { sessionID: 'ses_test' })
        const resumed = await waitFor(() => host.state.prompts.length === 1, { timeoutMs: 1500 })
        expect(resumed).toBe(true)
    })

    test('regression 2026-11-21: real form.created envelope (sessionID nested in data.form) blocks the stall resume', async () => {
        // opencode 2.3.2 emits `data: { form: { sessionID, ... } }` for
        // form.created — there is no top-level data.sessionID. An instance
        // that only sees the event bus (any opencode process except the one
        // executing the session) must still raise questionPending, or its
        // stall watchdog sends "continue" while the user is choosing.
        await start({ ...stallOptions })
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        host.emit('form.created', {
            form: {
                id: 'frm_test',
                sessionID: 'ses_test',
                title: 'Questions',
                metadata: { kind: 'question' },
            },
        })
        await waitFor(() => instance.sessions.get('ses_test')?.questionPending === true, {
            timeoutMs: 1500,
        })
        await new Promise((resolve) => setTimeout(resolve, 400))
        expect(host.state.prompts.length).toBe(0)
        host.emit('form.replied', { id: 'frm_test', sessionID: 'ses_test' })
        const resumed = await waitFor(() => host.state.prompts.length === 1, { timeoutMs: 1500 })
        expect(resumed).toBe(true)
        expect(host.state.prompts[0].metadata.reason).toBe('stall')
    })

    test('a fresh execution clears a stale pending question', async () => {
        await start({ ...stallOptions })
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        host.emit('form.created', { sessionID: 'ses_test' })
        await waitFor(() => instance.sessions.get('ses_test')?.questionPending === true, {
            timeoutMs: 1500,
        })
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        await waitFor(() => instance.sessions.get('ses_test')?.questionPending === false, {
            timeoutMs: 1500,
        })
        const resumed = await waitFor(() => host.state.prompts.length === 1, { timeoutMs: 1500 })
        expect(resumed).toBe(true)
    })
})

describe('cross-instance claim', () => {
    // Regression: on 2026-11-21 six phase-aligned watchdogs from re-imported
    // plugin copies sent six "continue" prompts into one session within 0.9s.
    // A resume must be claimed on disk so instances in the same process (and
    // in other processes) do not nudge the same session simultaneously.
    const claimOptions = (claimDir) => ({
        usageLimitEnabled: false,
        chunkTimeoutMs: 60,
        checkIntervalMs: 20,
        gracePeriodMs: 0,
        warmupMs: 0,
        baseBackoffMs: 10,
        claimDir,
    })

    const writeClaim = (claimDir, sid, ageMs) => {
        fs.mkdirSync(claimDir, { recursive: true })
        fs.writeFileSync(
            path.join(claimDir, `${sid}.json`),
            JSON.stringify({ at: Date.now() - ageMs, reason: 'stall' }),
        )
    }

    test('a fresh claim from another instance blocks the stall resume', async () => {
        const claimDir = path.join(TMP, `claims-${Math.random().toString(36).slice(2)}`)
        writeClaim(claimDir, 'ses_test', 0)
        await start(claimOptions(claimDir))
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        await new Promise((resolve) => setTimeout(resolve, 400))
        expect(host.state.prompts.length).toBe(0)
    })

    test('a stale claim is taken over', async () => {
        const claimDir = path.join(TMP, `claims-${Math.random().toString(36).slice(2)}`)
        writeClaim(claimDir, 'ses_test', 10 * 60_000)
        await start(claimOptions(claimDir))
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        const resumed = await waitFor(() => host.state.prompts.length === 1, { timeoutMs: 2000 })
        expect(resumed).toBe(true)
    })

    test('two live instances produce a single stall resume', async () => {
        // Two plugin instances cannot coexist in one process since the
        // globalThis singleton (see single active instance); the cross-process
        // case is covered compositionally: a sent resume leaves a fresh claim
        // on disk, and a fresh claim blocks another instance's resume.
        const claimDir = path.join(TMP, `claims-${Math.random().toString(36).slice(2)}`)
        await start(claimOptions(claimDir))
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        const resumed = await waitFor(() => host.state.prompts.length === 1, { timeoutMs: 2000 })
        expect(resumed).toBe(true)
        const claimFile = path.join(claimDir, 'ses_test.json')
        expect(fs.existsSync(claimFile)).toBe(true)
        const claim = JSON.parse(fs.readFileSync(claimFile, 'utf8'))
        expect(Date.now() - claim.at).toBeLessThan(5000)
    })

    test('regression 2026-11-21: a holder of an aged claim re-claims atomically instead of bypassing freshness', async () => {
        // The first delivery leaves claimPath set. With no activity (e.g. a
        // pending question suspends the turn), the claim file ages past the
        // TTL. On the next stall pass the holder must not blindly return
        // true: a second instance takes over the stale claim at the same
        // moment, and both delivered "continue" within the same millisecond.
        const claimDir = path.join(TMP, `claims-${Math.random().toString(36).slice(2)}`)
        await start(claimOptions(claimDir))
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        const first = await waitFor(() => host.state.prompts.length === 1, { timeoutMs: 2000 })
        expect(first).toBe(true)
        // Simulate the claim aging out with no activity in between.
        const claimFile = path.join(claimDir, 'ses_test.json')
        const aged = JSON.parse(fs.readFileSync(claimFile, 'utf8'))
        aged.at -= 10 * 60_000
        fs.writeFileSync(claimFile, JSON.stringify(aged))
        const claim = JSON.parse(fs.readFileSync(claimFile, 'utf8'))
        expect(Date.now() - claim.at).toBeGreaterThan(60_000)
        // A second stall pass (backoff clears in ~20ms) must re-claim: the
        // holder may not bypass the freshness check, so the on-disk claim is
        // either refreshed or the delivery blocked by a fresher claim — the
        // stale file must not survive either way.
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        const reclaimed = await waitFor(() => {
            try {
                return Date.now() - JSON.parse(fs.readFileSync(claimFile, 'utf8')).at < 60_000
            } catch {
                return false
            }
        }, { timeoutMs: 2000 })
        expect(reclaimed).toBe(true)
    })
})

describe('busy ownership', () => {
    test('a stray event after session.idle does not resurrect a finished run', async () => {
        await start({
            usageLimitEnabled: false,
            chunkTimeoutMs: 60,
            checkIntervalMs: 20,
            gracePeriodMs: 0,
            warmupMs: 0,
            baseBackoffMs: 10,
        })
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        host.emit('session.idle', { sessionID: 'ses_test' })
        host.emit('session.tool.called', { sessionID: 'ses_test', tool: 'read' })
        await new Promise((resolve) => setTimeout(resolve, 500))
        expect(host.state.prompts.length).toBe(0)
    })
})

describe('single active instance', () => {
    test('a new setup stops the previous instance', async () => {
        await start({ usageLimitEnabled: false })
        let stoppedCalls = 0
        const origStop = instance.stop.bind(instance)
        instance.stop = () => {
            stoppedCalls += 1
            origStop()
        }
        const second = await plugin.setup(host.ctx)
        expect(stoppedCalls).toBe(1)
        second.stop()
    })

    // Regression: on every config reload the host re-imports the plugin module
    // (four auto-resume imports in the same second were observed on
    // 2026-11-21). A module-level activeInstance guard is per module copy and
    // lets parallel watchdogs accumulate; the slot must live on globalThis,
    // which all copies of the module in one process share.
    test('a setup from a re-imported module copy stops the previous instance', async () => {
        await start({ usageLimitEnabled: false })
        let stoppedCalls = 0
        const origStop = instance.stop.bind(instance)
        instance.stop = () => {
            stoppedCalls += 1
            origStop()
        }
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-resume-copy-'))
        fs.copyFileSync(
            path.resolve(import.meta.dir, '..', 'plugin.js'),
            path.join(dir, 'plugin.js'),
        )
        try {
            const copy = await import(path.join(dir, 'plugin.js'))
            const host2 = createHost()
            const second = await copy.default.setup(host2.ctx)
            expect(stoppedCalls).toBe(1)
            second.stop()
        } finally {
            fs.rmSync(dir, { recursive: true, force: true })
        }
    })
})

describe('plugin directory config', () => {
    test('reads config.json from the plugin directory when no env override is set', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-resume-pdir-'))
        const logFile = path.join(dir, 'logs', 'auto-resume.log')
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ logFile }))
        fs.copyFileSync(
            path.resolve(import.meta.dir, '..', 'plugin.js'),
            path.join(dir, 'plugin.js'),
        )
        const prevEnv = process.env.AUTO_RESUME_OPTIONS_FILE
        delete process.env.AUTO_RESUME_OPTIONS_FILE
        try {
            const copied = await import(path.join(dir, 'plugin.js'))
            const host2 = createHost()
            instance = await copied.default.setup(host2.ctx)
            expect(fs.existsSync(logFile)).toBe(true)
        } finally {
            if (prevEnv !== undefined) process.env.AUTO_RESUME_OPTIONS_FILE = prevEnv
            if (instance?.stop) instance.stop()
            instance = null
        }
    })
})

describe('event loop resilience', () => {
    test('resubscribes after the event stream ends', async () => {
        await start({
            usageLimitEnabled: false,
            restartDelayMs: 10,
        })
        expect(host.state.subscribeCount).toBe(1)
        host.endStream()
        const resubscribed = await waitFor(() => host.state.subscribeCount >= 2, {
            timeoutMs: 2000,
        })
        expect(resubscribed).toBe(true)
    })
})

describe('deaf subscription guard', () => {
    // Regression: on 2026-11-21 the watchdogs fired a stall nudge into a
    // session that was actively streaming, because their event subscriptions
    // had gone silent (no events of any kind for the whole stall window)
    // while the timers kept ticking. A totally event-silent window means the
    // subscription itself is suspect: force a resubscribe and defer the nudge
    // by one window so a still-alive stream can prove itself with deltas.
    const deafOptions = {
        usageLimitEnabled: false,
        chunkTimeoutMs: 60,
        checkIntervalMs: 20,
        gracePeriodMs: 0,
        warmupMs: 0,
        baseBackoffMs: 10,
        loopMaxContinues: 50,
    }

    test('event-silent window defers the nudge and resubscribes', async () => {
        await start({ ...deafOptions })
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        // Normal stall point is ~60ms after the last event; the deferred
        // nudge must not fire before the window has elapsed twice.
        await new Promise((resolve) => setTimeout(resolve, 90))
        expect(host.state.prompts.length).toBe(0)
        const resubscribed = await waitFor(() => host.state.subscribeCount >= 2, {
            timeoutMs: 2000,
        })
        expect(resubscribed).toBe(true)
        const nudged = await waitFor(() => host.state.prompts.length === 1, { timeoutMs: 2000 })
        expect(nudged).toBe(true)
    })

    test('a live subscription on other sessions nudges without deferring', async () => {
        await start({ ...deafOptions })
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        const heartbeat = setInterval(
            () => host.emit('session.tool.called', { sessionID: 'ses_other', tool: 'read' }),
            15,
        )
        try {
            const nudged = await waitFor(() => host.state.prompts.length === 1, {
                timeoutMs: 2000,
            })
            expect(nudged).toBe(true)
            expect(host.state.subscribeCount).toBe(1)
        } finally {
            clearInterval(heartbeat)
        }
    })
})

describe('stall watchdog', () => {
    test('resumes a stalled run and gives up after maxRetries', async () => {
        await start({
            usageLimitEnabled: false,
            chunkTimeoutMs: 60,
            checkIntervalMs: 20,
            gracePeriodMs: 0,
            warmupMs: 0,
            baseBackoffMs: 10,
            maxBackoffMs: 20,
            maxRetries: 2,
            loopMaxContinues: 50,
        })
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        await waitFor(() => host.state.prompts.length >= 1, { timeoutMs: 2000 })
        await new Promise((resolve) => setTimeout(resolve, 700))
        expect(host.state.prompts.length).toBe(2)
        expect(host.state.prompts.every((p) => p.metadata.reason === 'stall')).toBe(true)
    })

    test('a fresh user input rearms a session that gave up', async () => {
        await start({
            usageLimitEnabled: false,
            chunkTimeoutMs: 60,
            checkIntervalMs: 20,
            gracePeriodMs: 0,
            warmupMs: 0,
            baseBackoffMs: 10,
            maxRetries: 1,
            loopMaxContinues: 50,
        })
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        await waitFor(() => host.state.prompts.length === 1, { timeoutMs: 2000 })
        await new Promise((resolve) => setTimeout(resolve, 400))
        expect(host.state.prompts.length).toBe(1)
        host.emit('session.inbox.enqueued', {
            sessionID: 'ses_test',
            item: { type: 'user', payload: { text: 'continue please', files: [] } },
        })
        host.emit('session.execution.started', { sessionID: 'ses_test' })
        const resumed = await waitFor(() => host.state.prompts.length === 2, { timeoutMs: 2000 })
        expect(resumed).toBe(true)
    })
})
