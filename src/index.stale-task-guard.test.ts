import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

type LogCall = { level: string; message: string }

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

function hasLog(logCalls: LogCall[], fragment: string): boolean {
    return logCalls.some((l) => l.message.includes(fragment))
}

function createContext(
    liveSessions: string[] = [],
    getImpl?: (sid: string) => Promise<unknown>,
) {
    const logCalls: LogCall[] = []
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
                messages: mock(async () => []),
                prompt: mock(async () => ({})),
                abort: mock(async () => ({})),
                get: getImpl
                    ? mock(getImpl)
                    : mock(async (config: any) => {
                          const id = config?.path?.id
                          if (liveSessions.includes(id)) {
                              return { data: { id, parentID: "ses_parent" } }
                          }
                          return {
                              error: { message: "Session not found" },
                              response: { status: 404 },
                          }
                      }),
            },
        },
        ui: { toast: mock(async () => {}) },
    } as any
    return { ctx, logCalls }
}

describe("stale task guard (tool.execute.before)", () => {
    test("drops task_id of a vanished session and annotates the prompt", async () => {
        const { ctx, logCalls } = createContext()
        const hooks: any = await AutoResumePlugin(ctx, {} as any)

        const args: any = {
            task_id: "ses_gone01",
            subagent_type: "oracle",
            prompt: "Recover the gate-review verdict.",
        }
        await hooks["tool.execute.before"](
            { tool: "task", sessionID: "ses_live_parent", callID: "call_1" },
            { args },
        )
        await wait(50)

        expect(args.task_id).toBeUndefined()
        expect(args.prompt).toContain("Recover the gate-review verdict.")
        expect(args.prompt).toContain("no longer available in storage")
        expect(hasLog(logCalls, "Stale task_id")).toBe(true)
    })

    test("leaves args untouched when the referenced session still exists", async () => {
        const { ctx } = createContext(["ses_alive01"])
        const hooks: any = await AutoResumePlugin(ctx, {} as any)

        const args: any = {
            task_id: "ses_alive01",
            subagent_type: "oracle",
            prompt: "Continue the review.",
        }
        await hooks["tool.execute.before"](
            { tool: "task", sessionID: "ses_live_parent", callID: "call_2" },
            { args },
        )
        await wait(50)

        expect(args.task_id).toBe("ses_alive01")
        expect(args.prompt).toBe("Continue the review.")
    })

    test("fails open when the session lookup throws a network error", async () => {
        const { ctx } = createContext([], async () => {
            throw new Error("ECONNRESET")
        })
        const hooks: any = await AutoResumePlugin(ctx, {} as any)

        const args: any = { task_id: "ses_maybe01", prompt: "Keep going." }
        await hooks["tool.execute.before"](
            { tool: "task", sessionID: "ses_live_parent", callID: "call_3" },
            { args },
        )
        await wait(50)

        expect(args.task_id).toBe("ses_maybe01")
        expect(args.prompt).toBe("Keep going.")
    })

    test("fails open when the session lookup times out", async () => {
        const { ctx } = createContext([], () => new Promise(() => {}))
        const hooks: any = await AutoResumePlugin(ctx, {
            staleTaskGuardTimeoutMs: 50,
        } as any)

        const args: any = { task_id: "ses_slow01", prompt: "Keep going." }
        await hooks["tool.execute.before"](
            { tool: "task", sessionID: "ses_live_parent", callID: "call_4" },
            { args },
        )
        await wait(150)

        expect(args.task_id).toBe("ses_slow01")
        expect(args.prompt).toBe("Keep going.")
    })

    test("task tool calls without task_id are not checked", async () => {
        const { ctx } = createContext()
        const hooks: any = await AutoResumePlugin(ctx, {} as any)

        const args: any = { subagent_type: "oracle", prompt: "Start fresh." }
        await hooks["tool.execute.before"](
            { tool: "task", sessionID: "ses_live_parent", callID: "call_5" },
            { args },
        )
        await wait(50)

        expect(args.prompt).toBe("Start fresh.")
        expect((ctx.client.session.get as any).mock.calls.length).toBe(0)
    })

    test("non-task tools are not checked", async () => {
        const { ctx } = createContext()
        const hooks: any = await AutoResumePlugin(ctx, {} as any)

        const args: any = { command: "rg -n foo" }
        await hooks["tool.execute.before"](
            { tool: "bash", sessionID: "ses_live_parent", callID: "call_6" },
            { args },
        )
        await wait(50)

        expect((ctx.client.session.get as any).mock.calls.length).toBe(0)
    })
})
