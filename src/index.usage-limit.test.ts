import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin, type UsageLimitProbe } from "./index"

type LogCall = { level: string; message: string }

const OPENAI_MESSAGES = [
    {
        info: {
            role: "assistant",
            providerID: "openai",
            modelID: "gpt-6.1-sol",
        },
    },
]

function createContext(messages: unknown[] = OPENAI_MESSAGES) {
    const logCalls: LogCall[] = []
    const promptCalls: Array<{ sid: string; text: string }> = []
    const ctx = {
        client: {
            app: {
                log: mock(async (o: any) => {
                    logCalls.push({ level: o.body.level, message: o.body.message })
                }),
            },
            session: {
                list: mock(async () => ({ data: [] })),
                status: mock(async () => ({ data: {} })),
                messages: mock(async () => messages),
                prompt: mock(async (config: any) => {
                    promptCalls.push({
                        sid: config.path.id,
                        text: config.body?.parts?.[0]?.text ?? "",
                    })
                    return {}
                }),
                abort: mock(async () => ({})),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, logCalls, promptCalls }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

const USAGE_LIMIT_EVENT = (sid: string) => ({
    type: "session.error",
    sessionID: sid,
    properties: {
        error: {
            name: "APIError",
            data: { message: "The usage limit has been reached. Please try again later." },
        },
    },
})

function probeReturning(override: Partial<UsageLimitProbe>): () => Promise<UsageLimitProbe> {
    return async () => ({
        ok: true,
        limitReached: true,
        resetAtMs: Date.now() + 20_000,
        resumeAtMs: Date.now() + 2_000,
        decidingWindow: "primary",
        graceMs: 60_000,
        ...override,
    })
}

const BASE_OPTS = {
    checkIntervalMs: 100_000,
    usageLimitGraceMs: 0,
    usageLimitRecheckMs: 50,
}

function hasLog(logCalls: LogCall[], fragment: string): boolean {
    return logCalls.some((l) => l.message.includes(fragment))
}

describe("usage limit: arming a reset-aware wait", () => {
    test("openai usage-limit error schedules a resume instead of retrying", async () => {
        const { ctx, logCalls, promptCalls } = createContext()
        const hooks: any = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            usageLimitProbe: probeReturning({}),
        } as any)

        await hooks.event({ event: USAGE_LIMIT_EVENT("ses_ul01") })
        await wait(100)

        expect(promptCalls.length).toBe(0)
        expect(hasLog(logCalls, "Usage limit reported on")).toBe(true)
        expect(hasLog(logCalls, "resume scheduled at")).toBe(true)
        expect(hasLog(logCalls, "[primary]")).toBe(true)
    })

    test("non-openai provider is ignored and keeps the normal path", async () => {
        const { ctx, logCalls, promptCalls } = createContext([
            { info: { role: "assistant", providerID: "lanit", modelID: "DKS-Leo" } },
        ])
        const hooks: any = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            usageLimitProbe: probeReturning({}),
        } as any)

        await hooks.event({ event: USAGE_LIMIT_EVENT("ses_ul02") })
        await wait(100)

        expect(promptCalls.length).toBe(0)
        expect(hasLog(logCalls, "ignored: provider lanit is not in usageLimitProviders")).toBe(true)
        expect(hasLog(logCalls, "resume scheduled at")).toBe(false)
    })

    test("unknown provider is not treated as a usage limit", async () => {
        const { ctx, logCalls } = createContext([{ info: { role: "assistant" } }])
        const hooks: any = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            usageLimitProbe: probeReturning({}),
        } as any)

        await hooks.event({ event: USAGE_LIMIT_EVENT("ses_ul03") })
        await wait(100)

        expect(hasLog(logCalls, "ignored: provider unknown")).toBe(true)
        expect(hasLog(logCalls, "resume scheduled at")).toBe(false)
    })

    test("a stale signal falls back to normal recovery", async () => {
        const { ctx, logCalls, promptCalls } = createContext()
        const hooks: any = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            usageLimitProbe: probeReturning({ limitReached: false, resumeAtMs: null, resetAtMs: null }),
        } as any)

        await hooks.event({ event: USAGE_LIMIT_EVENT("ses_ul04") })
        await wait(100)

        expect(hasLog(logCalls, "is stale: usage endpoint reports openai/gpt-6.1-sol available")).toBe(true)
        expect(promptCalls.length).toBe(0)
    })
})

describe("usage limit: resolving the reset moment", () => {
    test("resumes once the endpoint reports the limit lifted", async () => {
        const { ctx, logCalls, promptCalls } = createContext()
        let calls = 0
        const hooks: any = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            usageLimitProbe: async () => {
                calls++
                return {
                    ok: true,
                    limitReached: calls === 1,
                    resetAtMs: Date.now() + 1_000,
                    resumeAtMs: Date.now() + 1_100,
                    decidingWindow: "primary",
                    graceMs: 0,
                }
            },
        } as any)

        await hooks.event({ event: USAGE_LIMIT_EVENT("ses_ul05") })
        const resumed = await (async () => {
            for (let i = 0; i < 40; i++) {
                if (promptCalls.length > 0) return true
                await wait(100)
            }
            return false
        })()

        expect(resumed).toBe(true)
        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0].text).toBe("continue")
        expect(calls).toBeGreaterThanOrEqual(2)
        expect(hasLog(logCalls, "usage limit reset, resuming")).toBe(true)
    })

    test("probe failure schedules a recheck instead of touching the model", async () => {
        const { ctx, logCalls, promptCalls } = createContext()
        const hooks: any = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            usageLimitProbe: async () => ({
                ok: false,
                limitReached: false,
                resetAtMs: null,
                resumeAtMs: null,
                decidingWindow: null,
                graceMs: 0,
                reason: "auth-invalid",
                message: "usage endpoint returned 401",
            }),
        } as any)

        await hooks.event({ event: USAGE_LIMIT_EVENT("ses_ul06") })
        await wait(100)

        expect(promptCalls.length).toBe(0)
        expect(hasLog(logCalls, "reset unknown (auth-invalid")).toBe(true)
        expect(hasLog(logCalls, "recheck at")).toBe(true)
    })

    test("user abort cancels the scheduled wait", async () => {
        const { ctx, logCalls, promptCalls } = createContext()
        const hooks: any = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            usageLimitProbe: probeReturning({ resumeAtMs: Date.now() + 1_100 }),
        } as any)
        const sid = "ses_ul07"

        await hooks.event({ event: USAGE_LIMIT_EVENT(sid) })
        await wait(50)
        await hooks.event({
            event: { type: "session.error", sessionID: sid, properties: { error: { name: "MessageAbortedError" } } },
        })
        await wait(1_400)

        expect(promptCalls.length).toBe(0)
        expect(logCalls.some((l) => l.message.includes("User abort (ESC)"))).toBe(true)
    })

    test("usage-limit wait suppresses the idle recovery path", async () => {
        const { ctx, promptCalls } = createContext()
        const hooks: any = await AutoResumePlugin(ctx, {
            ...BASE_OPTS,
            usageLimitProbe: probeReturning({ resumeAtMs: Date.now() + 60_000 }),
        } as any)
        const sid = "ses_ul08"

        await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } })
        await hooks.event({ event: USAGE_LIMIT_EVENT(sid) })
        await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "idle" } } })
        await wait(150)

        expect(promptCalls.length).toBe(0)
    })
})

describe("usage limit: wait survives idle eviction", () => {
    test("armed wait is not dropped by cleanupIdleSessions", async () => {
        const { ctx, logCalls, promptCalls } = createContext()
        let probeCalls = 0
        const hooks: any = await AutoResumePlugin(ctx, {
            checkIntervalMs: 50,
            idleCleanupMs: 100,
            usageLimitRecheckMs: 50,
            usageLimitProbe: async () => {
                probeCalls++
                return {
                    ok: true,
                    limitReached: probeCalls === 1,
                    resetAtMs: Date.now() + 1_000,
                    resumeAtMs: Date.now() + 1_100,
                    decidingWindow: "primary",
                    graceMs: 0,
                }
            },
        } as any)
        const sid = "ses_ul09"

        await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } })
        await hooks.event({ event: USAGE_LIMIT_EVENT(sid) })
        await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "idle" } } })

        const resumed = await (async () => {
            for (let i = 0; i < 40; i++) {
                if (promptCalls.length > 0) return true
                await wait(100)
            }
            return false
        })()

        expect(resumed).toBe(true)
        expect(promptCalls.length).toBe(1)
        expect(hasLog(logCalls, "usage limit reset, resuming")).toBe(true)
    })
})

describe("usage limit: no recovery loop after the limit lifts", () => {
    const limitError = {
        id: "msg_err",
        info: { role: "assistant", providerID: "openai", modelID: "gpt-6.1-sol" },
        error: { name: "APIError", data: { message: "The usage limit has been reached" } },
    }

    test("a normal reply after the wait stops further continues", async () => {
        const { ctx, logCalls, promptCalls } = createContext()
        const messages: any[] = [limitError]
        ctx.client.session.messages = mock(async () => messages)

        let probes = 0
        const hooks: any = await AutoResumePlugin(ctx, {
            checkIntervalMs: 100_000,
            usageLimitGraceMs: 0,
            usageLimitProbe: async () => {
                probes++
                return {
                    ok: true,
                    limitReached: probes === 1,
                    resetAtMs: Date.now() + 1_000,
                    resumeAtMs: Date.now() + 1_100,
                    decidingWindow: "primary",
                    graceMs: 0,
                }
            },
        } as any)
        const sid = "ses_loop1"

        await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } })
        await hooks.event({ event: USAGE_LIMIT_EVENT(sid) })
        await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "idle" } } })

        for (let i = 0; i < 40 && promptCalls.length === 0; i++) await wait(100)
        expect(promptCalls.length).toBe(1)

        messages.push(
            { role: "user", parts: [{ type: "text", text: "continue" }] },
            { id: "msg_ok", info: { role: "assistant", providerID: "openai", modelID: "gpt-6.1-sol" }, parts: [{ type: "text", text: "Что сделать?" }] },
        )

        for (let i = 0; i < 3; i++) {
            await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } })
            await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "idle" } } })
            await wait(120)
        }

        expect(promptCalls.length).toBe(1)
        expect(hasLog(logCalls, "streaming failure detected on idle")).toBe(false)
    })

    test("a stale limit error keeps its id and is not re-probed", async () => {
        const { ctx, logCalls, promptCalls } = createContext()
        const messages: any[] = [limitError]
        ctx.client.session.messages = mock(async () => messages)

        let probes = 0
        const hooks: any = await AutoResumePlugin(ctx, {
            checkIntervalMs: 100_000,
            usageLimitGraceMs: 0,
            usageLimitProbe: async () => {
                probes++
                return {
                    ok: true,
                    limitReached: probes === 1,
                    resetAtMs: Date.now() + 1_000,
                    resumeAtMs: Date.now() + 1_100,
                    decidingWindow: "primary",
                    graceMs: 0,
                }
            },
        } as any)
        const sid = "ses_loop2"

        await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } })
        await hooks.event({ event: USAGE_LIMIT_EVENT(sid) })
        await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "idle" } } })
        for (let i = 0; i < 40 && promptCalls.length === 0; i++) await wait(100)

        const probesAfterFirstIdle = probes
        for (let i = 0; i < 3; i++) {
            await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "busy" } } })
            await hooks.event({ event: { type: "session.status", sessionID: sid, properties: { status: "idle" } } })
            await wait(120)
        }

        expect(probes).toBeLessThanOrEqual(probesAfterFirstIdle + 1)
        expect(promptCalls.length).toBeLessThanOrEqual(1)
        expect(hasLog(logCalls, "already handled; suppressing repeat recovery")).toBe(false)
    })
})
