import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"
import { containsWorkDescription } from "./test-utils"

/**
 * Regression tests for the done-claim false positives.
 *
 * The plugin used to fire DONE_WITHOUT_DETAILS_PROMPT ("Your last response
 * claimed the task is complete but contained no work description...") when a
 * done-claim pattern matched ANY part of the last 3 messages — including
 * `reasoning` (thinking) parts, where phrases like "task done" are normal
 * internal monologue — and without checking whether the visible response
 * already contained a detailed report. Both gaps produced scolding prompts
 * after perfectly complete, detailed answers.
 *
 * Fixes pinned here:
 * 1. ready-to-continue / done-claim heuristics scan visible text parts only
 *    (`!isReasoning`).
 * 2. DONE_WITHOUT_DETAILS_PROMPT is skipped when the response already
 *    contains a work description (containsWorkDescription).
 * 3. `doneClaimNudge: false` disables the done-claim prompts entirely.
 */

type PromptCall = { sid: string; body: string }

function createDoneClaimContext(opts: {
    sessions: Array<{ id: string; status: string }>
    messages: Record<string, Array<{ role: string; parts?: Array<{ type: string; text?: string }> }>>
}) {
    const promptCalls: PromptCall[] = []
    const abortCalls: Array<{ sid: string }> = []
    const messages = opts.messages

    const client: Record<string, unknown> = {
        app: {
            log: mock(async (_o: { body: { level: string; message: string } }) => {}),
        },
        session: {
            list: mock(async () => ({
                data: opts.sessions.map(s => ({
                    id: s.id,
                    projectID: "proj-1",
                    directory: "/test",
                    title: s.id,
                    version: "1.0.0",
                    time: { created: Date.now(), updated: Date.now() }
                }))
            })),
            status: mock(async () => ({ data: {} })),
            todo: mock(async () => ({ data: [] })),
            messages: mock(async (config: { path: { id: string } }) => {
                return { data: messages[config.path.id] ?? [] }
            }),
            prompt: mock(async (config: {
                path: { id: string }
                body: { parts: Array<{ type: string; text: string }> }
            }) => {
                promptCalls.push({
                    sid: config.path.id,
                    body: config.body.parts.map(p => p.text).join("")
                })
                return {}
            }),
            abort: mock(async (config: { path: { id: string } }) => {
                abortCalls.push({ sid: config.path.id })
                return {}
            }),
        },
    }

    const ctx = { client, ui: { toast: mock(async () => {}) } } as any

    return { ctx, promptCalls, abortCalls, messages }
}

const COMPLETED_TODOS = [
    { id: "t1", content: "task one", status: "completed", priority: "high" },
    { id: "t2", content: "task two", status: "cancelled", priority: "high" }
]

function makeStatusEvent(sid: string, status: string) {
    return {
        event: {
            type: "session.status",
            sessionID: sid,
            properties: { status }
        }
    }
}

function makeTodoUpdatedEvent(sid: string, todos: unknown[]) {
    return {
        event: {
            type: "todo.updated",
            sessionID: sid,
            properties: { todos }
        }
    }
}

const wait = (ms: number) => new Promise(r => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeoutMs = 2000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
        if (cond()) return true
        await wait(10)
    }
    return cond()
}

const BASE_OPTIONS = {
    enabled: true,
    baseBackoffMs: 1,
    maxRetries: 3,
    minActivityGapMs: 1,
    toolTextCheckDelayMs: 50,
    loopMaxContinues: 10,
}

describe("containsWorkDescription()", () => {
    test("bare claims → false", () => {
        expect(containsWorkDescription("Готово!")).toBe(false)
        expect(containsWorkDescription("task done.")).toBe(false)
        expect(containsWorkDescription("Всё выполнено.")).toBe(false)
    })

    test("long text → true", () => {
        expect(containsWorkDescription("Отчёт. ".repeat(80))).toBe(true)
    })

    test("code spans / paths → true", () => {
        expect(containsWorkDescription("Обновил `src/index.ts` — добавлен guard.")).toBe(true)
        expect(containsWorkDescription("Правка в src/index.ts применена.")).toBe(true)
    })

    test("commands and test counts → true", () => {
        expect(containsWorkDescription("Прогнал bun test — зелёный.")).toBe(true)
        expect(containsWorkDescription("Тесты 12/12 зелёные.")).toBe(true)
    })
})

describe("Done-claim guard — reasoning parts excluded", () => {
    test("done-claim pattern inside reasoning only → NO details prompt", async () => {
        const { ctx, promptCalls } = createDoneClaimContext({
            sessions: [{ id: "ses_reason", status: "idle" }],
            messages: {
                ses_reason: [
                    { role: "user", parts: [{ type: "text", text: "работай" }] },
                    {
                        role: "assistant",
                        parts: [
                            { type: "reasoning", text: "All checks pass. The implementation is finished.\ntask done." },
                        ],
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, BASE_OPTIONS)

        await hooks.event!(makeTodoUpdatedEvent("ses_reason", COMPLETED_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_reason", "idle") as any)
        await wait(250)
        await hooks.event!(makeStatusEvent("ses_reason", "busy") as any)
        await hooks.event!(makeStatusEvent("ses_reason", "idle") as any)
        await wait(250)
        expect(promptCalls.length).toBe(0)
    })

    test("ready-to-continue pattern inside reasoning only → NO continue", async () => {
        const { ctx, promptCalls } = createDoneClaimContext({
            sessions: [{ id: "ses_r2c", status: "idle" }],
            messages: {
                ses_r2c: [
                    { role: "user", parts: [{ type: "text", text: "работай" }] },
                    {
                        role: "assistant",
                        parts: [
                            { type: "reasoning", text: "Next step is clear now.\nReady to continue with task 2." },
                        ],
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, BASE_OPTIONS)

        await hooks.event!(makeTodoUpdatedEvent("ses_r2c", COMPLETED_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_r2c", "idle") as any)
        await wait(250)
        await hooks.event!(makeStatusEvent("ses_r2c", "busy") as any)
        await hooks.event!(makeStatusEvent("ses_r2c", "idle") as any)
        await wait(250)
        expect(promptCalls.length).toBe(0)
    })
})

describe("Done-claim details prompt", () => {
    test("bare visible claim still demands details (no over-suppression)", async () => {
        const { ctx, promptCalls } = createDoneClaimContext({
            sessions: [{ id: "ses_bare", status: "idle" }],
            messages: {
                ses_bare: [
                    { role: "user", parts: [{ type: "text", text: "работай" }] },
                    { role: "assistant", parts: [{ type: "text", text: "Готово." }] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, BASE_OPTIONS)

        await hooks.event!(makeTodoUpdatedEvent("ses_bare", COMPLETED_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_bare", "idle") as any)
        const prompted = await waitFor(() => promptCalls.length >= 1, 1500)
        expect(prompted).toBe(true)
        expect(promptCalls[0].body).toContain("detailed report")
    })

    test("detailed report with a done-claim tail → NO details prompt", async () => {
        const report =
            "Обновил `src/index.ts`: добавлен guard textWaitsForUserInput и опция openTodosNudge. " +
            "Guard встроен в три точки нуджа: idle-чек, периодический recheck и session.idle-обработчик. " +
            "Прогнал полный набор тестов — 579/579, пересобрал dist через bun run build. " +
            "README дополнен разделом про plain-text waiting-for-input guard. " +
            "Задача полностью выполнена."
        expect(containsWorkDescription(report)).toBe(true)

        const { ctx, promptCalls } = createDoneClaimContext({
            sessions: [{ id: "ses_report", status: "idle" }],
            messages: {
                ses_report: [
                    { role: "user", parts: [{ type: "text", text: "работай" }] },
                    { role: "assistant", parts: [{ type: "text", text: report }] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, BASE_OPTIONS)

        await hooks.event!(makeTodoUpdatedEvent("ses_report", COMPLETED_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_report", "idle") as any)
        await wait(250)
        await hooks.event!(makeStatusEvent("ses_report", "busy") as any)
        await hooks.event!(makeStatusEvent("ses_report", "idle") as any)
        await wait(250)
        expect(promptCalls.length).toBe(0)
    })
})

describe("doneClaimNudge option", () => {
    test("doneClaimNudge: false disables done-claim prompts entirely", async () => {
        const { ctx, promptCalls } = createDoneClaimContext({
            sessions: [{ id: "ses_off", status: "idle" }],
            messages: {
                ses_off: [
                    { role: "user", parts: [{ type: "text", text: "работай" }] },
                    { role: "assistant", parts: [{ type: "text", text: "Готово." }] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, { ...BASE_OPTIONS, doneClaimNudge: false })

        await hooks.event!(makeTodoUpdatedEvent("ses_off", COMPLETED_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_off", "idle") as any)
        await wait(250)
        await hooks.event!(makeStatusEvent("ses_off", "busy") as any)
        await hooks.event!(makeStatusEvent("ses_off", "idle") as any)
        await wait(250)
        expect(promptCalls.length).toBe(0)
    })
})
