import { defineExtension, defineExtensionId } from "@crustjs/core";
import { BadArgs, DaemonError, ErrorPayloadSchema } from "@gyst/core";
import { Schema } from "effect";

const encodeError = Schema.encodeSync(ErrorPayloadSchema);

/** Every failure leaves on stderr as one JSON `{code, message, detail?}` line so agents can parse it. */
export const jsonErrors = defineExtension(defineExtensionId("gyst-json-errors"), {
  hooks: {
    onError(cause, { stderr }) {
      // Ctrl-C: crust aborts the invocation and exits 130; a cancellation is not an error to report.
      if (cause instanceof Error && cause.name === "AbortError") return false;
      const error = Schema.is(DaemonError)(cause)
        ? cause
        : new BadArgs({ message: cause instanceof Error ? cause.message : "invalid command" });
      stderr(JSON.stringify(encodeError(error)));
      return true;
    },
  },
});
