// Probe plugin for the OpenCode v2 plugin contract.
//
// Loading only — never mutates host state. Findings are appended as JSON lines
// to $OPENCODE_DIR/tmp/task12-probe.jsonl because console output from a
// plugin's setup() is not mirrored into the v2 server log.
//
// What it answers, for the auto-resume port:
//   1. the exact shape of setup(ctx) — which domains and methods exist;
//   2. which event types ctx.event.subscribe() accepts in 2.3.2;
//   3. whether ctx.session.hook('retry', ...) fires on a provider 429 and what
//      the payload looks like (the v2 replacement for v1 session.error);
//   4. whether the resolved subscription is consumable from a JS plugin.

import fs from 'node:fs';
import path from 'node:path';

const OUT =
  process.env.TASK12_PROBE_OUT ??
  path.join(process.env.OPENCODE_DIR ?? '/tmp', 'tmp', 'task12-probe.jsonl');

function record(kind, payload) {
  try {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.appendFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), kind, payload }) + '\n');
  } catch (err) {
    // Last resort: stderr of the server process.
    console.error('[ar-probe] record failed', err);
  }
}

function describe(value) {
  if (value === null) return { type: 'null' };
  if (value === undefined) return { type: 'undefined' };
  const t = typeof value;
  if (t !== 'object' && t !== 'function') return { type: t, value: String(value) };
  let keys = null;
  try {
    keys = Object.keys(value);
  } catch {
    keys = null;
  }
  let proto = null;
  try {
    proto = Object.getOwnPropertyNames(Object.getPrototypeOf(value));
  } catch {
    proto = null;
  }
  return { type: t, keys, proto };
}

function safeJson(value, limit = 1500) {
  try {
    const seen = new WeakSet();
    const text = JSON.stringify(value, (k, v) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v)) return '[circular]';
        seen.add(v);
      }
      if (typeof v === 'function') return `[fn:${v.name || 'anonymous'}]`;
      return v;
    });
    return text === undefined ? null : text.slice(0, limit);
  } catch (err) {
    return `[unserializable:${err?.message ?? err}]`;
  }
}

const EVENT_CANDIDATES = [
  'session.status',
  'session.idle',
  'session.error',
  'session.updated',
  'session.created',
  'session.deleted',
  'session.retry.scheduled',
  'session.text.ended',
  'session.text.started',
  'session.step.ended',
  'session.step.failed',
  'session.execution.failed',
  'session.execution.interrupted',
  'session.execution.started',
  'session.execution.succeeded',
  'session.tool.failed',
  'session.tool.success',
  'session.tool.called',
  'session.synthetic',
  'session.interrupted',
  'session.inbox.enqueued',
  'session.inbox.delivered',
  'session.inbox.cancelled',
  'session.usage.updated',
  'session.reasoning.ended',
  'session.compaction.ended',
  'message.updated',
  'message.part.updated',
  'message.removed',
  'tool.execute.before',
  'tool.execute.after',
  'command.executed',
  'permission.asked',
  'permission.replied',
];

export default {
  id: 'auto-resume-probe',
  async setup(ctx) {
    record('probe.version', { version: 2 });

    // 1. ctx surface
    record('ctx', {
      top: describe(ctx),
      options: safeJson(ctx.options),
      location: safeJson(ctx.location),
      domains: {
        session: describe(ctx.session),
        event: describe(ctx.event),
        tool: describe(ctx.tool),
        storage: describe(ctx.storage),
        shell: describe(ctx.shell),
        permission: describe(ctx.permission),
        app: describe(ctx.app),
        plugin: describe(ctx.plugin),
        rpc: describe(ctx.rpc),
      },
      sessionMethodTypes: Object.fromEntries(
        ['hook', 'list', 'create', 'get', 'prompt', 'synthetic', 'interrupt', 'wait', 'context', 'messages', 'status', 'generate', 'command', 'compact', 'update'].map(
          (n) => [n, typeof ctx.session?.[n]],
        ),
      ),
      storageMethodTypes: Object.fromEntries(
        ['get', 'set', 'remove', 'scan'].map((n) => [n, typeof ctx.storage?.[n]]),
      ),
      appMethodTypes: Object.fromEntries(
        ['log', 'info', 'warn', 'error', 'debug'].map((n) => [n, typeof ctx.app?.[n]]),
      ),
    });

    // 2. event.subscribe — candidate types; the host logs unknown ones as
    //    "ignoring unknown event types", so passing the full candidate list
    //    splits it into accepted/unknown in the server log.
    let sub = null;
    try {
      const pending = ctx.event.subscribe({ types: EVENT_CANDIDATES });
      record('event.subscribe.return', describe(pending));
      sub = await pending;
      record('event.subscribe.resolved', describe(sub));
      record('event.subscribe.resolved.details', {
        thenable: typeof pending?.then === 'function',
        asyncIterator: typeof sub?.[Symbol.asyncIterator],
        pipe: typeof sub?.pipe,
        run: typeof sub?.run,
        dispose: typeof sub?.dispose,
        subscribe: typeof sub?.subscribe,
      });
    } catch (err) {
      record('event.subscribe.error', { message: String(err?.message ?? err) });
    }

    // Consume the subscription if it is an async iterable.
    if (sub && typeof sub[Symbol.asyncIterator] === 'function') {
      (async () => {
        try {
          for await (const ev of sub) {
            record('event.observed', {
              envelope: describe(ev),
              type: ev?.type,
              data: safeJson(ev?.data ?? ev),
            });
          }
        } catch (err) {
          record('event.consume.error', { message: String(err?.message ?? err) });
        }
      })();
    }

    // 3. session hooks
    for (const hookName of ['retry', 'context', 'prompt', 'model.request']) {
      try {
        const handle = await ctx.session.hook(
          hookName,
          (event) => {
            record(`hook.${hookName}.fired`, {
              keys: describe(event).keys,
              payload: safeJson(event),
              errorKeys: describe(event?.error)?.keys ?? null,
              decision: safeJson(event?.decision ?? null),
            });
          },
          { providerID: 'lanit' },
        );
        record(`hook.${hookName}.return`, describe(handle));
      } catch (err) {
        record(`hook.${hookName}.error`, { message: String(err?.message ?? err) });
      }
    }

    // 4. tool hooks
    for (const hookName of ['execute.before', 'execute.after']) {
      try {
        const handle = await ctx.tool.hook(hookName, (event) => {
          record(`toolhook.${hookName}.fired`, { payload: safeJson(event, 600) });
        });
        record(`toolhook.${hookName}.return`, describe(handle));
      } catch (err) {
        record(`toolhook.${hookName}.error`, { message: String(err?.message ?? err) });
      }
    }
  },
};
