import { describe, test, expect, mock } from "bun:test"
import { AutoResumePlugin } from "./index"

/**
 * Regression tests for the pending-question guard.
 *
 * When the agent asks the user a question via the `question` tool, OpenCode
 * suspends the turn and the session goes idle while the tool call waits for
 * the user's answer. Open todos stay open because the work is merely paused.
 * Before the guard existed, every idle-boundary recovery path (todo nudge,
 * periodic recheck, busy-stall continue, abort escalation) sent its prompt
 * anyway — the model resumed work without ever seeing the user's answer.
 *
 * The fix: before sending any resume prompt (sendContinuePrompt) or aborting
 * (tryAbortAndResume), the plugin checks `client.question.list()` for a
 * pending question with a matching sessionID and backs off.
 */

type PromptCall = { sid: string; body: string }

interface PendingQuestion {
    id: string
    sessionID: string
}

function createQuestionPendingContext(opts: {
    sessions: Array<{ id: string; status: string }>
    messages: Record<string, Array<{ role: string; parts?: Array<{ type: string; text?: string }> }>>
    questionClientMissing?: boolean
    questionListThrows?: boolean
}) {
    const promptCalls: PromptCall[] = []
    const abortCalls: Array<{ sid: string }> = []
    const questionListCalls: number[] = []
    let pendingQuestions: PendingQuestion[] = []

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
                return { data: opts.messages[config.path.id] ?? [] }
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
    if (!opts.questionClientMissing) {
        client.question = {
            list: mock(async () => {
                questionListCalls.push(Date.now())
                if (opts.questionListThrows) {
                    throw new Error("simulated question.list failure")
                }
                return { data: pendingQuestions.map(q => ({ ...q, questions: [] })) }
            }),
        }
    }

    const ctx = { client, ui: { toast: mock(async () => {}) } } as any

    return {
        ctx,
        promptCalls,
        abortCalls,
        questionListCalls,
        setPendingQuestions: (qs: PendingQuestion[]) => { pendingQuestions = qs },
    }
}

const OPEN_TODOS = [
    { id: "t1", content: "task one", status: "pending", priority: "high" },
    { id: "t2", content: "task two", status: "in_progress", priority: "high" }
]

const BASE_MESSAGES = {
    role_user_do_work: [
        { role: "user", parts: [{ type: "text", text: "do the work" }] },
        { role: "assistant", parts: [{ type: "text", text: "step 1 done" }] }
    ]
}

function messagesFor(sid: string): Array<{ role: string; parts?: Array<{ type: string; text?: string }> }> {
    return BASE_MESSAGES.role_user_do_work
}

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

describe("Pending-question guard — idle todo nudge", () => {
    test("idle with open todos + pending question → NO nudge until the user answers", async () => {
        const { ctx, promptCalls, setPendingQuestions } = createQuestionPendingContext({
            sessions: [{ id: "ses_q", status: "idle" }],
            messages: { ses_q: messagesFor("ses_q") },
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            maxRetries: 1,
            loopMaxContinues: 10,
        })

        await hooks.event!(makeTodoUpdatedEvent("ses_q", OPEN_TODOS) as any)
        setPendingQuestions([{ id: "q1", sessionID: "ses_q" }])

        await hooks.event!(makeStatusEvent("ses_q", "idle") as any)
        await wait(200)
        expect(promptCalls.length).toBe(0)

        // Still unanswered after another busy→idle cycle
        await hooks.event!(makeStatusEvent("ses_q", "busy") as any)
        await hooks.event!(makeStatusEvent("ses_q", "idle") as any)
        await wait(200)
        expect(promptCalls.length).toBe(0)

        // User answers → the nudge goes out on the next idle boundary
        setPendingQuestions([])
        await hooks.event!(makeStatusEvent("ses_q", "busy") as any)
        await hooks.event!(makeStatusEvent("ses_q", "idle") as any)
        await wait(200)
        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0].sid).toBe("ses_q")
        expect(promptCalls[0].body).toContain("unfinished task")
    })

    test("suppressed nudges do not burn the nudge budget (periodic recheck)", async () => {
        const { ctx, promptCalls, setPendingQuestions } = createQuestionPendingContext({
            sessions: [{ id: "ses_budget", status: "idle" }],
            messages: { ses_budget: messagesFor("ses_budget") },
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            checkIntervalMs: 50,
            maxRetries: 2,
            // Keep the hallucination-loop detector out of the way: every
            // recheck tryResume records a continue timestamp.
            loopMaxContinues: 100,
        })

        await hooks.event!(makeTodoUpdatedEvent("ses_budget", OPEN_TODOS) as any)
        setPendingQuestions([{ id: "q1", sessionID: "ses_budget" }])

        await hooks.event!(makeStatusEvent("ses_budget", "idle") as any)
        await wait(20)
        expect(promptCalls.length).toBe(0)

        // Session stays idle; periodic rechecks keep firing but stay suppressed.
        await wait(400)
        expect(promptCalls.length).toBe(0)

        // Answer arrives → budget is intact, so the very next recheck nudges.
        setPendingQuestions([])
        const nudged = await waitFor(() => promptCalls.length >= 1, 1500)
        expect(nudged).toBe(true)
        expect(promptCalls[0].body).toContain("unfinished task")
    })

    test("pending question in ANOTHER session does not block this session's nudge", async () => {
        const { ctx, promptCalls, setPendingQuestions } = createQuestionPendingContext({
            sessions: [
                { id: "ses_a", status: "idle" },
                { id: "ses_b", status: "idle" },
            ],
            messages: { ses_a: messagesFor("ses_a"), ses_b: messagesFor("ses_b") },
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            maxRetries: 1,
            loopMaxContinues: 10,
        })

        await hooks.event!(makeTodoUpdatedEvent("ses_a", OPEN_TODOS) as any)
        // Question is pending in ses_b, not in ses_a
        setPendingQuestions([{ id: "q1", sessionID: "ses_b" }])

        await hooks.event!(makeStatusEvent("ses_a", "idle") as any)
        await wait(200)

        const aPrompts = promptCalls.filter(p => p.sid === "ses_a")
        expect(aPrompts.length).toBe(1)
        expect(aPrompts[0].body).toContain("unfinished task")
    })
})

describe("Pending-question guard — busy-stall continue", () => {
    test("stall continue is NOT sent into a session waiting for a user answer", async () => {
        const { ctx, promptCalls, setPendingQuestions } = createQuestionPendingContext({
            sessions: [{ id: "ses_stall", status: "busy" }],
            messages: { ses_stall: messagesFor("ses_stall") },
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            chunkTimeoutMs: 60,
            gracePeriodMs: 5,
            checkIntervalMs: 20,
            loopMaxContinues: 50,
        } as any)

        await hooks.event!(makeStatusEvent("ses_stall", "busy") as any)
        setPendingQuestions([{ id: "q1", sessionID: "ses_stall" }])

        // Silence far beyond chunkTimeoutMs + gracePeriodMs → stall path fires,
        // but the prompt must be suppressed while the question is pending.
        await wait(300)
        expect(promptCalls.length).toBe(0)

        // Question answered → the stall path may continue the session.
        setPendingQuestions([])
        const resumed = await waitFor(() => promptCalls.length >= 1, 1000)
        expect(resumed).toBe(true)
        expect(promptCalls[0].body).toBe("continue")
    })
})

describe("Pending-question guard — abort escalation", () => {
    test("abort+resume is suppressed while a question is pending, fires after the answer", async () => {
        const { ctx, promptCalls, abortCalls, setPendingQuestions } = createQuestionPendingContext({
            sessions: [{ id: "ses_abort", status: "idle" }],
            messages: { ses_abort: messagesFor("ses_abort") },
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            minActivityGapMs: 1,
            checkIntervalMs: 50,
            maxRetries: 5,
            // Default loopMaxContinues (3): the periodic recheck trips the
            // hallucination-loop detector quickly, escalating to abort+resume.
        })

        await hooks.event!(makeTodoUpdatedEvent("ses_abort", OPEN_TODOS) as any)
        // Arm the question BEFORE the idle event: with the default
        // loopMaxContinues (3) the periodic recheck escalates to abort+resume
        // within ~100ms, and the escalation must land while the question is
        // pending.
        setPendingQuestions([{ id: "q1", sessionID: "ses_abort" }])
        await hooks.event!(makeStatusEvent("ses_abort", "idle") as any)

        // The recheck escalates (hallucination loop) but must not abort the
        // session — an abort would kill the pending question UI.
        await wait(300)
        expect(abortCalls.length).toBe(0)
        expect(promptCalls.length).toBe(0)

        // Answer arrives → the loop escalation aborts as designed.
        setPendingQuestions([])
        const aborted = await waitFor(() => abortCalls.length >= 1, 2500)
        expect(aborted).toBe(true)
        expect(abortCalls[0].sid).toBe("ses_abort")
    })
})

describe("Pending-question guard — fail-open paths", () => {
    test("question.list() throwing does not block recovery", async () => {
        const { ctx, promptCalls } = createQuestionPendingContext({
            sessions: [{ id: "ses_err", status: "idle" }],
            messages: { ses_err: messagesFor("ses_err") },
            questionListThrows: true,
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            maxRetries: 1,
            loopMaxContinues: 10,
        })

        await hooks.event!(makeTodoUpdatedEvent("ses_err", OPEN_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_err", "idle") as any)
        await wait(200)
        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0].body).toContain("unfinished task")
    })

    test("missing question client (older opencode SDK) does not block recovery", async () => {
        const { ctx, promptCalls } = createQuestionPendingContext({
            sessions: [{ id: "ses_old", status: "idle" }],
            messages: { ses_old: messagesFor("ses_old") },
            questionClientMissing: true,
        })
        const hooks = await AutoResumePlugin(ctx, {
            enabled: true,
            baseBackoffMs: 1,
            maxRetries: 1,
            loopMaxContinues: 10,
        })

        await hooks.event!(makeTodoUpdatedEvent("ses_old", OPEN_TODOS) as any)
        await hooks.event!(makeStatusEvent("ses_old", "idle") as any)
        await wait(200)
        expect(promptCalls.length).toBe(1)
        expect(promptCalls[0].body).toContain("unfinished task")
    })
})
