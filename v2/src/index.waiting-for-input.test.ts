import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"
import { textWaitsForUserInput, buildOpenTodosReminder } from "./test-utils"

/**
 * Regression tests for the plain-text waiting-for-input guard on the
 * idle-with-open-todos reminder (openTodosNudge).
 *
 * The pending-question guard only covers questions asked via the `question`
 * tool. When the agent ends its turn with plain-text questions (or a
 * confirmation request) and open todos, the idle nudge
 * "You have N unfinished tasks... Please continue working on these tasks"
 * fired anyway — the model resumed work without the user's answers,
 * re-derived candidates and burned whole turns. These tests pin the fix:
 * the reminder is suppressed while the newest assistant message ends with a
 * question mark or contains a waiting-for-input marker, and the
 * `openTodosNudge: false` option disables the reminder entirely.
 */

type PromptCall = { sid: string; body: string }

function createWaitingForInputContext(opts: {
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
        // No `question` client on purpose: the question-tool guard fails open,
        // so these tests prove the plain-text guard on its own.
    }

    const ctx = { client, ui: { toast: mock(async () => {}) } } as any

    return { ctx, promptCalls, abortCalls, messages }
}

const OPEN_TODOS = [
    { id: "t1", content: "00-overview.md: подсистемы за фасадами", status: "in_progress", priority: "high" },
    { id: "t2", content: "01-technologies.md: Spring AI версия", status: "pending", priority: "high" }
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

describe("textWaitsForUserInput()", () => {
    test("last line ending with a question mark → true", () => {
        expect(textWaitsForUserInput("Проанализировал документы.\nКакой вариант предпочитаете: A или B?")).toBe(true)
    })

    test("question mark with trailing markdown decorations → true", () => {
        expect(textWaitsForUserInput("Продолжаем?**")).toBe(true)
        expect(textWaitsForUserInput("Какой вариант? **")).toBe(true)
    })

    test("Russian confirmation-request markers → true", () => {
        expect(textWaitsForUserInput("Ответьте в любом формате: «всё подтверждаю» или правки по номерам.")).toBe(true)
        expect(textWaitsForUserInput("Пункты 14 и 23 ждут подтверждения владельца.")).toBe(true)
        expect(textWaitsForUserInput("Пункт 3 ждёт вашего подтверждения.")).toBe(true)
        expect(textWaitsForUserInput("Жду ваших ответов.")).toBe(true)
        expect(textWaitsForUserInput("Схема требует уточнения, подтвердите формулировку.")).toBe(true)
    })

    test("English waiting markers → true", () => {
        expect(textWaitsForUserInput("Waiting for your confirmation before applying changes.")).toBe(true)
        expect(textWaitsForUserInput("The plan awaits your approval.")).toBe(true)
        expect(textWaitsForUserInput("Please confirm the approach.")).toBe(true)
    })

    test("plain statements → false", () => {
        expect(textWaitsForUserInput("Всё готово, диф приложил.")).toBe(false)
        expect(textWaitsForUserInput("Шаг 1 выполнен, перехожу к шагу 2.")).toBe(false)
        expect(textWaitsForUserInput("Собрал проект, тесты зелёные.")).toBe(false)
    })

    test("question mark inside a code fence → false", () => {
        expect(textWaitsForUserInput("Проверю условие:\n```ts\nif (isReady(x)) return\n```\n")).toBe(false)
    })

    test("the todo reminder itself does not look like waiting-for-input", () => {
        expect(textWaitsForUserInput(buildOpenTodosReminder(OPEN_TODOS as any))).toBe(false)
    })

    test("empty text → false", () => {
        expect(textWaitsForUserInput("")).toBe(false)
        expect(textWaitsForUserInput("   \n  ")).toBe(false)
    })
})

describe("Waiting-for-input guard — idle todo nudge", () => {
    test("idle + open todos + assistant ended with a question → NO nudge until the turn resumes", async () => {
        const { ctx, promptCalls, messages } = createWaitingForInputContext({
            sessions: [{ id: "ses_q", status: "idle" }],
            messages: {
                ses_q: [
                    { role: "user", parts: [{ type: "text", text: "продолжай" }] },
                    { role: "assistant", parts: [{ type: "text", text: "Какой вариант предпочитаете: A или B?" }] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            maxRetries: 3,
            minActivityGapMs: 1,
            loopMaxContinues: 10,
        })

        await hooks.event!(makeTodoUpdatedEvent("ses_q", OPEN_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_q", "idle") as any)
        await wait(300)
        expect(promptCalls.length).toBe(0)

        // A second unanswered idle cycle stays silent too.
        await hooks.event!(makeStatusEvent("ses_q", "busy") as any)
        await hooks.event!(makeStatusEvent("ses_q", "idle") as any)
        await wait(300)
        expect(promptCalls.length).toBe(0)

        // The turn resumes with a plain statement → the nudge goes out again.
        messages.ses_q.push({ role: "assistant", parts: [{ type: "text", text: "Продолжаю с вариантом A." }] })
        await hooks.event!(makeStatusEvent("ses_q", "busy") as any)
        await hooks.event!(makeStatusEvent("ses_q", "idle") as any)
        const nudged = await waitFor(() => promptCalls.length >= 1, 1500)
        expect(nudged).toBe(true)
        expect(promptCalls[0].body).toContain("unfinished task")
    })

    test("real fragment: confirmation request in plain text → NO nudge across idle cycles", async () => {
        const { ctx, promptCalls, messages } = createWaitingForInputContext({
            sessions: [{ id: "ses_docs", status: "idle" }],
            messages: {
                ses_docs: [
                    { role: "user", parts: [{ type: "text", text: "собери открытые вопросы" }] },
                    {
                        role: "assistant",
                        parts: [{
                            type: "text",
                            text: "Ответьте в любом формате: «всё подтверждаю», «всё, кроме 14, 23 — там так: …», или правки по номерам. " +
                                "После подтверждения применяю правки во все документы одним проходом и показываю diff-сводку.",
                        }],
                    },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            maxRetries: 3,
            minActivityGapMs: 1,
            loopMaxContinues: 10,
        })

        await hooks.event!(makeTodoUpdatedEvent("ses_docs", OPEN_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_docs", "idle") as any)
        await wait(300)
        await hooks.event!(makeStatusEvent("ses_docs", "busy") as any)
        await hooks.event!(makeStatusEvent("ses_docs", "idle") as any)
        await wait(300)
        expect(promptCalls.length).toBe(0)

        // Answers arrive → the model reports back with a statement → nudge lifts.
        messages.ses_docs.push(
            { role: "user", parts: [{ type: "text", text: "всё подтверждаю" }] },
            { role: "assistant", parts: [{ type: "text", text: "Применяю правки во все документы." }] },
        )
        await hooks.event!(makeStatusEvent("ses_docs", "busy") as any)
        await hooks.event!(makeStatusEvent("ses_docs", "idle") as any)
        const nudged = await waitFor(() => promptCalls.length >= 1, 1500)
        expect(nudged).toBe(true)
    })
})

describe("openTodosNudge option", () => {
    test("openTodosNudge: false disables the reminder entirely", async () => {
        const { ctx, promptCalls } = createWaitingForInputContext({
            sessions: [{ id: "ses_off", status: "idle" }],
            messages: {
                ses_off: [
                    { role: "user", parts: [{ type: "text", text: "работай" }] },
                    { role: "assistant", parts: [{ type: "text", text: "Приступаю к шагу 1." }] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            openTodosNudge: false,
            baseBackoffMs: 1,
            maxRetries: 3,
            minActivityGapMs: 1,
            checkIntervalMs: 50,
            loopMaxContinues: 10,
        })

        await hooks.event!(makeTodoUpdatedEvent("ses_off", OPEN_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_off", "idle") as any)
        await wait(300)
        // Periodic rechecks keep running but must never nudge.
        await wait(300)
        expect(promptCalls.length).toBe(0)
    })

    test("default (option absent) keeps the reminder enabled", async () => {
        const { ctx, promptCalls } = createWaitingForInputContext({
            sessions: [{ id: "ses_def", status: "idle" }],
            messages: {
                ses_def: [
                    { role: "user", parts: [{ type: "text", text: "работай" }] },
                    { role: "assistant", parts: [{ type: "text", text: "Приступаю к шагу 1." }] },
                ],
            },
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            maxRetries: 3,
            minActivityGapMs: 1,
            loopMaxContinues: 10,
        })

        await hooks.event!(makeTodoUpdatedEvent("ses_def", OPEN_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_def", "idle") as any)
        const nudged = await waitFor(() => promptCalls.length >= 1, 1500)
        expect(nudged).toBe(true)
        expect(promptCalls[0].body).toContain("unfinished task")
    })
})
