import { describe, test, expect, mock } from "bun:test"
import { mkdtempSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { AutoResumePlugin } from "./index"

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function createContext(opts: {
    parentID?: string | null
    finalText?: string
    getThrows?: boolean
} = {}) {
    const logCalls: Array<{ level: string; message: string }> = []
    let messageCalls = 0
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
                prompt: mock(async () => ({})),
                abort: mock(async () => ({})),
                get: mock(async (config: any) => {
                    if (opts.getThrows) throw new Error("storage exploded")
                    return {
                        data: {
                            id: config?.path?.id,
                            parentID: opts.parentID ?? null,
                        },
                    }
                }),
                messages: mock(async () => {
                    messageCalls++
                    if (opts.finalText === undefined) return []
                    return [
                        {
                            info: { role: "assistant" },
                            parts: [{ type: "text", text: opts.finalText }],
                        },
                    ]
                }),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, logCalls, getMessageCalls: () => messageCalls }
}

describe("bg result snapshot (session.idle)", () => {
    test("writes the final assistant text of a child session to bgSnapshotDir", async () => {
        const dir = mkdtempSync(join(tmpdir(), "bg-snap-"))
        const { ctx } = createContext({
            parentID: "ses_parent",
            finalText: "VERDICT: APPROVE. All 94 tests green.",
        })
        const hooks: any = await AutoResumePlugin(ctx, { bgSnapshotDir: dir } as any)

        await hooks.event({ event: { type: "session.idle", sessionID: "ses_child1", properties: {} } })
        await wait(200)

        const file = join(dir, "ses_child1.txt")
        expect(existsSync(file)).toBe(true)
        expect(readFileSync(file, "utf8")).toContain("VERDICT: APPROVE. All 94 tests green.")
    })

    test("does not snapshot main sessions (no parent)", async () => {
        const dir = mkdtempSync(join(tmpdir(), "bg-snap-"))
        const { ctx } = createContext({ parentID: null, finalText: "Main session text." })
        const hooks: any = await AutoResumePlugin(ctx, { bgSnapshotDir: dir } as any)

        await hooks.event({ event: { type: "session.idle", sessionID: "ses_main1", properties: {} } })
        await wait(200)

        expect(existsSync(join(dir, "ses_main1.txt"))).toBe(false)
    })

    test("writes nothing when the child has no assistant text", async () => {
        const dir = mkdtempSync(join(tmpdir(), "bg-snap-"))
        const { ctx } = createContext({ parentID: "ses_parent", finalText: undefined })
        const hooks: any = await AutoResumePlugin(ctx, { bgSnapshotDir: dir } as any)

        await hooks.event({ event: { type: "session.idle", sessionID: "ses_child2", properties: {} } })
        await wait(200)

        expect(existsSync(join(dir, "ses_child2.txt"))).toBe(false)
    })

    test("writes only once per session even if idle fires repeatedly", async () => {
        const dir = mkdtempSync(join(tmpdir(), "bg-snap-"))
        const { ctx, getMessageCalls } = createContext({
            parentID: "ses_parent",
            finalText: "Snapshot me once.",
        })
        const hooks: any = await AutoResumePlugin(ctx, { bgSnapshotDir: dir } as any)

        await hooks.event({ event: { type: "session.idle", sessionID: "ses_child3", properties: {} } })
        await wait(200)
        await hooks.event({ event: { type: "session.idle", sessionID: "ses_child3", properties: {} } })
        await wait(200)

        expect(existsSync(join(dir, "ses_child3.txt"))).toBe(true)
        expect(getMessageCalls()).toBe(1)
    })

    test("storage errors never break the event flow", async () => {
        const dir = mkdtempSync(join(tmpdir(), "bg-snap-"))
        const { ctx } = createContext({
            parentID: "ses_parent",
            finalText: "Boom.",
            getThrows: true,
        })
        const hooks: any = await AutoResumePlugin(ctx, { bgSnapshotDir: dir } as any)

        await hooks.event({ event: { type: "session.idle", sessionID: "ses_child4", properties: {} } })
        await wait(200)

        expect(existsSync(join(dir, "ses_child4.txt"))).toBe(false)
    })

    test("can be disabled with bgSnapshotEnabled: false", async () => {
        const dir = mkdtempSync(join(tmpdir(), "bg-snap-"))
        const { ctx } = createContext({ parentID: "ses_parent", finalText: "No snapshot." })
        const hooks: any = await AutoResumePlugin(ctx, {
            bgSnapshotEnabled: false,
            bgSnapshotDir: dir,
        } as any)

        await hooks.event({ event: { type: "session.idle", sessionID: "ses_child5", properties: {} } })
        await wait(200)

        expect(existsSync(join(dir, "ses_child5.txt"))).toBe(false)
    })
})
