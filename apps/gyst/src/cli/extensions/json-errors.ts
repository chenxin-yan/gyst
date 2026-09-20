import { CrustError, defineExtension, defineExtensionId } from "@crustjs/core";
import { BadArgs, DaemonError, ErrorPayloadSchema, InternalError } from "@gyst/core";
import { Schema } from "effect";

const encodeError = Schema.encodeSync(ErrorPayloadSchema);

/** crust's own verdicts on the invocation; anything else that is not a domain error is a defect. */
const isInvalidInvocation = (cause: unknown): cause is CrustError =>
  cause instanceof CrustError &&
  (cause.is("PARSE") || cause.is("VALIDATION") || cause.is("COMMAND_NOT_FOUND"));

/** Every failure leaves on stderr as one JSON `{code, message, detail?}` line so agents can parse it. */
export const jsonErrors = defineExtension(defineExtensionId("gyst-json-errors"), {
  hooks: {
    onError(cause, { stderr }) {
      // Ctrl-C: crust aborts the invocation and exits 130; a cancellation is not an error to report.
      if (cause instanceof Error && cause.name === "AbortError") return false;
      const error = Schema.is(DaemonError)(cause)
        ? cause
        : isInvalidInvocation(cause)
          ? new BadArgs({ message: cause.message })
          : new InternalError({ message: cause instanceof Error ? cause.message : String(cause) });
      stderr(JSON.stringify(encodeError(error)));
      return true;
    },
  },
});
