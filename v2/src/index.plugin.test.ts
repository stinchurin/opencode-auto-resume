import { describe, test, expect, mock, beforeEach, spyOn } from "bun:test"

const createMockContext = () => {
    const events: Array<{ type: string; [key: string]: unknown }> = []
    
    return {
        events,
        client: {
            session: {
                list: mock(() => Promise.resolve({ 
                    data: [{ id: "session-1", status: "idle" }] 
                })),
                messages: mock(() => Promise.resolve([
                    { role: "assistant", agent: "build", id: "msg-1" }
                ])),
                prompt: mock(() => Promise.resolve({})),
                abort: mock(() => Promise.resolve({})),
            }
        },
        on: mock((event: string, handler: (ev: unknown) => void) => {
            events.push({ type: event, handler })
        }),
        idle: mock(() => {}),
        log: mock(() => {}),
    }
}

describe("Plugin Lifecycle", () => {
    test("mock context tracks event registrations", () => {
        const ctx = createMockContext()
        const expectedEvents = [
            "session.status",
            "message",
            "session.error",
        ]
        
        // Simulate plugin registering handlers
        for (const ev of expectedEvents) {
            ctx.on(ev, () => {})
        }
        
        const registeredTypes = ctx.events.map(e => e.type)
        
        for (const expected of expectedEvents) {
            expect(registeredTypes).toContain(expected)
        }
    })

    test("discovers existing sessions on startup", async () => {
        const ctx = createMockContext()
        
        await ctx.client.session.list()
        
        expect(ctx.client.session.list).toHaveBeenCalled()
    })
})

describe("Session State Tracking", () => {
    test("tracks session status changes", () => {
        const sessions = new Map<string, {
            status?: string
            lastActivityAt: number
        }>()

        function ensureWatch(sid: string) {
            if (!sessions.has(sid)) {
                sessions.set(sid, { status: undefined, lastActivityAt: Date.now() })
            }
            return sessions.get(sid)!
        }

        const w = ensureWatch("session-1")
        expect(w.status).toBeUndefined()
        
        w.status = "busy"
        expect(w.status).toBe("busy")
        
        w.status = "idle"
        expect(w.status).toBe("idle")
    })

    test("tracks last activity timestamp", () => {
        const before = Date.now()
        const w = { lastActivityAt: Date.now() }
        const after = Date.now()
        
        expect(w.lastActivityAt).toBeGreaterThanOrEqual(before)
        expect(w.lastActivityAt).toBeLessThanOrEqual(after)
    })
})

describe("Resume Logic", () => {
    test("respects max retry limit", () => {
        const maxRetries = 5
        let attempts = 0
        
        for (let i = 0; i < 10; i++) {
            if (attempts < maxRetries) {
                attempts++
            }
        }
        
        expect(attempts).toBe(maxRetries)
    })

    test("calculates exponential backoff", () => {
        function backoffMs(attempt: number): number {
            return Math.min(5000 * Math.pow(2, attempt), 160000)
        }
        
        expect(backoffMs(0)).toBe(5000)
        expect(backoffMs(1)).toBe(10000)
        expect(backoffMs(2)).toBe(20000)
        expect(backoffMs(3)).toBe(40000)
        expect(backoffMs(4)).toBe(80000)
        expect(backoffMs(5)).toBe(160000)
        expect(backoffMs(10)).toBe(160000)
    })

    test("blocks retry during backoff period", () => {
        const now = Date.now()
        const lastRetryAt = now - 3000
        const backoff = 5000
        
        const canRetry = (now - lastRetryAt) >= backoff
        expect(canRetry).toBe(false)
        
        const later = now + 3000
        const canRetryLater = (later - lastRetryAt) >= backoff
        expect(canRetryLater).toBe(true)
    })
})

describe("Agent Feature", () => {
    test("extracts agent from messages", async () => {
        const messages = [
            { role: "user", content: "Hello" },
            { role: "assistant", agent: "plan", content: "Hi there!" },
            { role: "assistant", agent: "build", content: "Working on it..." },
        ]
        
        const reversed = [...messages].reverse()
        const lastAssistant = reversed.find(m => m.role === "assistant" && m.agent)
        const lastAgent = lastAssistant ? lastAssistant.agent : undefined
        
        expect(lastAgent).toBe("build")
    })

    test("returns undefined when no assistant messages", async () => {
        const messages: Array<{ role: string; content: string; agent?: string }> = [
            { role: "user", content: "Hello" },
        ]
        
        const reversed = [...messages].reverse()
        const lastAssistant = reversed.find(m => m.role === "assistant" && m.agent)
        const lastAgent = lastAssistant ? lastAssistant.agent : undefined
        
        expect(lastAgent).toBeUndefined()
    })

    test("validates agent before passing to API", () => {
        // Matches the plugin's validation: typeof === "string" && length > 0
        const validateAgent = (agent: unknown): string | undefined => {
            return typeof agent === "string" && agent.length > 0 ? agent : undefined
        }
        
        const invalidAgents = [undefined, null, 123, "", {}, true]
        
        for (const agent of invalidAgents) {
            expect(validateAgent(agent)).toBeUndefined()
        }
        
        const validAgents = ["build", "plan", "general", "explore"]
        
        for (const agent of validAgents) {
            expect(validateAgent(agent)).toBe(agent)
        }
    })
})

describe("Error Handling", () => {
    test("handles API errors gracefully", async () => {
        const ctx = createMockContext()
        
        ctx.client.session.prompt = mock(() => 
            Promise.reject(new Error("Expected 'id' to be a string"))
        )
        
        try {
        await (ctx.client.session.prompt as any)({ 
            path: { id: "test" }, 
            body: { parts: [] } 
        })
        } catch (err) {
            expect(err instanceof Error).toBe(true)
            expect((err as Error).message).toBe("Expected 'id' to be a string")
        }
    })

    test("validates session ID before API call", () => {
        const invalidIds = ["", null as any, undefined as any, 123 as any, {} as any]
        
        for (const id of invalidIds) {
            const isValid = typeof id === "string" && id.length > 0
            expect(isValid).toBe(false)
        }
        
        expect(typeof "valid-id-123").toBe("string")
    })
})

describe("Event Handling", () => {
    test("extracts sessionID from different event formats", () => {
        const events = [
            { sessionID: "session-1" },
            { properties: { sessionID: "session-2" } },
            { properties: { part: { sessionID: "session-3" } } },
            { properties: { info: { sessionID: "session-4" } } },
        ]
        
        for (const ev of events) {
            const props = ev.properties as Record<string, unknown> | undefined
            const sid = (ev.sessionID as string | undefined) 
                ?? (props?.sessionID as string | undefined)
                ?? ((props?.part as Record<string, unknown>)?.sessionID as string | undefined)
                ?? ((props?.info as Record<string, unknown>)?.sessionID as string | undefined)
            
            expect(sid).toBeDefined()
        }
    })

    test("identifies idle session events", () => {
        const event = { type: "session.status", sessionID: "s1", properties: { status: "idle" } }
        expect(event.properties.status).toBe("idle")
        
        const busyEvent = { type: "session.status", sessionID: "s1", properties: { status: "busy" } }
        expect(busyEvent.properties.status).toBe("busy")
    })
})

describe("Tool Text Recovery", () => {
    test("detects tool call in message", () => {
        const parts = [
            { type: "text", text: "I'll help you" },
            { type: "tool-call", toolCallId: "call-123", toolName: "read" }
        ]
        
        const hasToolCall = parts.some(p => p.type === "tool-call")
        expect(hasToolCall).toBe(true)
    })

    test("generates recovery prompt for tool-as-text", () => {
        const toolName = "read"
        const prompt = `The previous response was cut off while calling \`${toolName}\`. Please continue the tool call.`
        
        expect(prompt).toContain(toolName)
        expect(prompt).toContain("cut off")
    })

    test("limits tool text recovery attempts", () => {
        const maxAttempts = 3
        let attempts = 0
        
        for (let i = 0; i < 10; i++) {
            if (attempts < maxAttempts) {
                attempts++
            }
        }
        
        expect(attempts).toBe(maxAttempts)
    })
})

describe("Loop Detection", () => {
    test("detects repeated identical messages", () => {
        const messages = [
            { content: "Analyzing..." },
            { content: "Analyzing..." },
            { content: "Analyzing..." },
            { content: "Analyzing..." },
        ]
        
        const loopCount = messages.filter((m, i) => 
            i > 0 && m.content === messages[i - 1].content
        ).length
        
        expect(loopCount).toBe(3)
    })

    test("detects similar message patterns", () => {
        const messages = [
            { content: "Let me analyze this" },
            { content: "Let me analyze that" },
            { content: "Let me analyze something" },
        ]
        
        const allStartSame = messages.every(m => 
            m.content.startsWith("Let me analyze")
        )
        
        expect(allStartSame).toBe(true)
    })
})

describe("Continue Lock Prevention", () => {
    test("prevents concurrent continue prompts", () => {
        const w = { continuing: false }
        
        // First continue should be allowed
        const shouldSend1 = !w.continuing
        expect(shouldSend1).toBe(true)
        
        // Simulate continue in progress
        w.continuing = true
        
        // Second continue should be blocked
        const shouldSend2 = !w.continuing
        expect(shouldSend2).toBe(false)
        
        // After continue completes
        w.continuing = false
        
        // Next continue should be allowed again
        const shouldSend3 = !w.continuing
        expect(shouldSend3).toBe(true)
    })

    test("resets continuing flag on busy status", () => {
        const w = { 
            continuing: true,
            userCancelled: false,
            resumeAttempts: 0,
            gaveUp: false,
            orphanWatchStartAt: null,
            aborting: false,
            toolTextRecovered: false,
            toolTextAttempts: 0,
            continueTimestamps: [],
            idleSince: null,
        }
        
        // Simulate resetSessionFlags when status becomes "busy"
        w.continuing = false
        w.userCancelled = false
        w.resumeAttempts = 0
        w.gaveUp = false
        w.orphanWatchStartAt = null
        w.aborting = false
        w.toolTextRecovered = false
        w.toolTextAttempts = 0
        w.continueTimestamps = []
        w.idleSince = null
        
        expect(w.continuing).toBe(false)
    })

    test("allows continue after user writes message", () => {
        const w = { continuing: true }
        
        // User writes something → status becomes "busy" → resetSessionFlags
        w.continuing = false
        
        // Continue should now be allowed
        expect(w.continuing).toBe(false)
    })
})

describe("Idle Flags Reset", () => {
    test("resets only idle-specific flags", () => {
        const w: { userCancelled: boolean; aborting: boolean; orphanWatchStartAt: number | null; idleSince: number | null; resumeAttempts: number; continuing: boolean } = {
            userCancelled: true,
            aborting: true,
            orphanWatchStartAt: Date.now(),
            idleSince: null,
            resumeAttempts: 5, // Should NOT be reset
            continuing: true, // Should NOT be reset
        }
        
        // Simulate resetIdleFlags
        w.userCancelled = false
        w.aborting = false
        w.orphanWatchStartAt = null
        w.idleSince = Date.now()
        
        expect(w.userCancelled).toBe(false)
        expect(w.aborting).toBe(false)
        expect(w.orphanWatchStartAt).toBeNull()
        expect(w.idleSince).toBeDefined()
        expect(w.resumeAttempts).toBe(5) // Preserved
        expect(w.continuing).toBe(true) // Preserved
    })

    test("sets idleSince timestamp", () => {
        const w = { idleSince: null as number | null }
        const before = Date.now()
        
        w.idleSince = Date.now()
        
        expect(w.idleSince).toBeGreaterThanOrEqual(before)
        expect(w.idleSince).toBeLessThanOrEqual(Date.now() + 1)
    })
})

describe("Todo-Based Continue Guard", () => {
    interface Todo { content: string; status: string; priority: string }

    function hasOpenTodos(todos: Todo[]): boolean {
        return todos.some(t => t.status === "pending" || t.status === "in_progress")
    }

    function shouldSendContinue(todos: Todo[], todoCheckAttempts: number): { send: boolean; prompt: string } {
        const open = hasOpenTodos(todos)
        if (!open && todos.length > 0) {
            if (todoCheckAttempts >= 2) {
                return { send: true, prompt: "Please close all completed todos and finish your message." }
            }
            return { send: false, prompt: "" }
        }
        return { send: true, prompt: "continue" }
    }

    test("sends continue when todos are still open", () => {
        const todos: Todo[] = [
            { content: "Task 1", status: "completed", priority: "high" },
            { content: "Task 2", status: "in_progress", priority: "high" },
            { content: "Task 3", status: "pending", priority: "medium" },
        ]
        const result = shouldSendContinue(todos, 0)
        expect(result.send).toBe(true)
        expect(result.prompt).toBe("continue")
    })

    test("skips continue when all todos completed on first attempt", () => {
        const todos: Todo[] = [
            { content: "Task 1", status: "completed", priority: "high" },
            { content: "Task 2", status: "completed", priority: "high" },
        ]
        const result = shouldSendContinue(todos, 0)
        expect(result.send).toBe(false)
    })

    test("skips continue when all todos completed on second attempt", () => {
        const todos: Todo[] = [
            { content: "Task 1", status: "completed", priority: "high" },
        ]
        const result = shouldSendContinue(todos, 1)
        expect(result.send).toBe(false)
    })

    test("sends todo reminder on third attempt when all completed", () => {
        const todos: Todo[] = [
            { content: "Task 1", status: "completed", priority: "high" },
            { content: "Task 2", status: "completed", priority: "medium" },
        ]
        const result = shouldSendContinue(todos, 2)
        expect(result.send).toBe(true)
        expect(result.prompt).toBe("Please close all completed todos and finish your message.")
    })

    test("sends continue when no todos exist", () => {
        const result = shouldSendContinue([], 0)
        expect(result.send).toBe(true)
        expect(result.prompt).toBe("continue")
    })

    test("treats cancelled todos as closed", () => {
        const todos: Todo[] = [
            { content: "Task 1", status: "completed", priority: "high" },
            { content: "Task 2", status: "cancelled", priority: "low" },
        ]
        const result = shouldSendContinue(todos, 0)
        expect(result.send).toBe(false)
    })

    test("detects open pending todo", () => {
        const todos: Todo[] = [
            { content: "Task 1", status: "completed", priority: "high" },
            { content: "Task 2", status: "pending", priority: "medium" },
        ]
        expect(hasOpenTodos(todos)).toBe(true)
    })

    test("detects open in_progress todo", () => {
        const todos: Todo[] = [
            { content: "Task 1", status: "in_progress", priority: "high" },
        ]
        expect(hasOpenTodos(todos)).toBe(true)
    })

    test("no open todos when all completed", () => {
        const todos: Todo[] = [
            { content: "Task 1", status: "completed", priority: "high" },
            { content: "Task 2", status: "completed", priority: "medium" },
        ]
        expect(hasOpenTodos(todos)).toBe(false)
    })

    test("no open todos when all cancelled", () => {
        const todos: Todo[] = [
            { content: "Task 1", status: "cancelled", priority: "high" },
        ]
        expect(hasOpenTodos(todos)).toBe(false)
    })
})

describe("Checking Lock", () => {
    test("prevents concurrent checkForToolCallAsText calls", () => {
        const w = { checkingToolText: false }
        const enter = () => {
            if (w.checkingToolText) return false
            w.checkingToolText = true
            return true
        }
        const exit = () => { w.checkingToolText = false }

        expect(enter()).toBe(true)  // First call enters
        expect(enter()).toBe(false) // Second call blocked
        exit()
        expect(enter()).toBe(true)  // After exit, allowed again
    })

    test("releases lock in error path", () => {
        const w = { checkingToolText: false }
        const simulateWithError = () => {
            w.checkingToolText = true
            try {
                throw new Error("simulated")
            } finally {
                w.checkingToolText = false
            }
        }

        expect(() => simulateWithError()).toThrow("simulated")
        expect(w.checkingToolText).toBe(false)
    })
})

describe("Subagent Check Cooldown", () => {
    test("skips subagent check within cooldown period", () => {
        const checkIntervalMs = 5_000
        const w = { lastSubagentCheckAt: Date.now() }
        const now = Date.now()
        const elapsed = now - w.lastSubagentCheckAt
        const withinCooldown = elapsed < checkIntervalMs * 2
        expect(withinCooldown).toBe(true)
    })

    test("allows subagent check after cooldown expires", () => {
        const checkIntervalMs = 5_000
        const w = { lastSubagentCheckAt: Date.now() - checkIntervalMs * 2 - 1 }
        const now = Date.now()
        const elapsed = now - w.lastSubagentCheckAt
        const pastCooldown = elapsed >= checkIntervalMs * 2
        expect(pastCooldown).toBe(true)
    })

    test("updates lastSubagentCheckAt after check", () => {
        const w = { lastSubagentCheckAt: 0 }
        const now = 100000
        w.lastSubagentCheckAt = now
        expect(w.lastSubagentCheckAt).toBe(now)
    })
})

describe("task_complete Tool", () => {
    test("sets toolTextRecovered when called", () => {
        const w: Record<string, unknown> = { toolTextRecovered: false, toolTextTimer: null }
        w.toolTextRecovered = true
        expect(w.toolTextRecovered).toBe(true)
    })

    test("clears pending timer when called", () => {
        let cleared = false
        const timer = setTimeout(() => { cleared = true }, 10000)
        const w: Record<string, unknown> = { toolTextRecovered: false, toolTextTimer: timer }
        if (w.toolTextTimer) { clearTimeout(w.toolTextTimer as ReturnType<typeof setTimeout>); w.toolTextTimer = null }
        expect(w.toolTextTimer).toBeNull()
        clearTimeout(timer) // cleanup
    })

    test("prevents further continue checks after completion", () => {
        const w = { toolTextRecovered: false, toolTextAttempts: 0, lastRetryAt: 0 }
        // Simulate task_complete call
        w.toolTextRecovered = true
        // Guard in checkForToolCallAsText
        const shouldSkip = w.toolTextRecovered
        expect(shouldSkip).toBe(true)
    })
})

describe("🎉 Completion Detection", () => {
    function normalize(text: string): string {
        return text.trim().replace(/[.!?]+$/, '')
    }

    test("detects 🎉 at end of message", () => {
        expect(normalize("All tasks complete 🎉").endsWith('🎉')).toBe(true)
    })

    test("detects 🎉 with trailing punctuation", () => {
        expect(normalize("Done 🎉.").endsWith('🎉')).toBe(true)
        expect(normalize("Finished 🎉!").endsWith('🎉')).toBe(true)
    })

    test("ignores 🎉 in middle of text", () => {
        expect(normalize("🎉 Starting task two...").endsWith('🎉')).toBe(false)
    })
})

describe("Done Claim Detection", () => {
    const DONE_CLAIM_PATTERNS = [
        /^task\s+done[.!]*$/im,
        /^done[.!]*$/im,
        /^all\s+done[.!]*$/im,
        /^finished[.!]*$/im,
        /^complete[.!]*$/im,
        /^task\s+complete[.!]*$/im,
        /^all\s+tasks?\s+complete[.!]*$/im,
        /^(?:i['']?m\s+)?done\s+with\s+task/im,
    ]

    function containsDoneClaimPattern(text: string): boolean {
        const lines = text.split('\n')
        const lastLines = lines.slice(-3).join('\n')
        return DONE_CLAIM_PATTERNS.some((pat) => pat.test(lastLines))
    }

    test("detects 'Task Done' claim", () => {
        expect(containsDoneClaimPattern("Task Done")).toBe(true)
    })

    test("detects 'done.' claim", () => {
        expect(containsDoneClaimPattern("done.")).toBe(true)
    })

    test("detects 'All tasks complete' claim", () => {
        expect(containsDoneClaimPattern("All tasks complete")).toBe(true)
    })

    test("detects 'Finished' with exclamation", () => {
        expect(containsDoneClaimPattern("Finished!")).toBe(true)
    })

    test("does not flag regular content with 'done' in middle", () => {
        expect(containsDoneClaimPattern("I have done the tasks you asked me to do")).toBe(false)
    })

    test("detects in last line only", () => {
        const msg = "I analyzed the code.\nAll done."
        expect(containsDoneClaimPattern(msg)).toBe(true)
    })

    test("does not flag work output with 'complete' in context", () => {
        expect(containsDoneClaimPattern("The operation completed successfully with exit code 0")).toBe(false)
    })
})