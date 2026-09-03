import { MAX_SCHEDULABLE_DELAY_MS } from "./process/deadlines.mjs";

export class RequestDeadlineError extends Error {
  constructor(message, { code, phase } = {}) {
    super(message);
    this.name = "RequestDeadlineError";
    this.code = code || "delegate_request_deadline_exceeded";
    this.phase = phase;
    this.processStarted = false;
  }
}

function finiteFutureDeadline(deadlineAt, now) {
  const current = now();
  return Number.isSafeInteger(deadlineAt) && deadlineAt >= current &&
    deadlineAt - current <= MAX_SCHEDULABLE_DELAY_MS;
}

/**
 * One delegation receives one absolute envelope. Individual phases may carve
 * work from it, but no phase is allowed to create a competing clock that can
 * extend the request after this context has expired.
 */
export function createRequestDeadlineContext({
  deadlineAt,
  abortSignal: clientAbortSignal,
  now = Date.now,
  schedule = setTimeout,
  cancelSchedule = clearTimeout
} = {}) {
  if (typeof now !== "function" || typeof schedule !== "function" || typeof cancelSchedule !== "function") {
    throw new RequestDeadlineError("Request deadline clock is invalid.", {
      code: "delegate_request_clock_invalid"
    });
  }
  if (!finiteFutureDeadline(deadlineAt, now)) {
    throw new RequestDeadlineError("Request deadline is invalid or unsupported.", {
      code: "delegate_request_deadline_invalid"
    });
  }

  const controller = new AbortController();
  let abortKind;
  let deadlineTimer;
  let resolveAborted;
  const aborted = new Promise((resolve) => {
    resolveAborted = resolve;
  });
  const trigger = (kind) => {
    if (controller.signal.aborted) return;
    abortKind = kind;
    controller.abort();
    resolveAborted(kind);
  };
  const onClientAbort = () => trigger("client");
  if (clientAbortSignal?.aborted) {
    trigger("client");
  } else {
    clientAbortSignal?.addEventListener?.("abort", onClientAbort, { once: true });
  }
  deadlineTimer = schedule(() => trigger("deadline"), Math.max(0, deadlineAt - now()));

  const errorFor = (phase) => new RequestDeadlineError(
    abortKind === "client"
      ? "Client cancelled delegation" + (phase ? " during " + phase : "") + "."
      : "Delegation request deadline expired" + (phase ? " during " + phase : "") + ".",
    {
      code: abortKind === "client" ? "claude_cancelled" : "delegate_request_deadline_exceeded",
      phase
    }
  );
  const isActive = () => {
    if (!controller.signal.aborted && now() >= deadlineAt) trigger("deadline");
    return !controller.signal.aborted;
  };
  const assertActive = (phase) => {
    if (!isActive()) throw errorFor(phase);
  };
  const observe = async (phase, operation) => {
    assertActive(phase);
    const pending = Promise.resolve()
      .then(() => {
        assertActive(phase);
        return operation();
      })
      .then((value) => ({ kind: "value", value }), (error) => ({ kind: "error", error }));
    const observed = await Promise.race([
      pending,
      aborted.then(() => ({ kind: "aborted" }))
    ]);
    if (observed.kind === "aborted") throw errorFor(phase);
    if (observed.kind === "error") {
      if (!isActive()) throw errorFor(phase);
      throw observed.error;
    }
    assertActive(phase);
    return observed.value;
  };
  const clipUsefulWorkTimeout = (configuredTimeoutMs, reserveMs) => {
    assertActive("useful-work-budget");
    if (!Number.isSafeInteger(configuredTimeoutMs) || configuredTimeoutMs <= 0) {
      throw new RequestDeadlineError("Configured useful-work timeout is invalid.", {
        code: "delegate_request_timeout_invalid"
      });
    }
    const reserve = Number.isSafeInteger(reserveMs) && reserveMs >= 0 ? reserveMs : 0;
    const available = deadlineAt - now() - reserve;
    if (available <= 0) throw errorFor("useful-work-budget");
    return Math.max(1, Math.min(configuredTimeoutMs, available));
  };

  return Object.freeze({
    deadlineAt,
    abortSignal: controller.signal,
    now,
    schedule,
    cancelSchedule,
    remainingMs: () => Math.max(0, deadlineAt - now()),
    isActive,
    assertActive,
    observe,
    clipUsefulWorkTimeout,
    dispose: () => {
      cancelSchedule(deadlineTimer);
      clientAbortSignal?.removeEventListener?.("abort", onClientAbort);
    }
  });
}
