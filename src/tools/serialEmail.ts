/** Mail-merge transport selection and responses, isolated from server startup. */
import type { AppleMailManager } from "@/services/appleMailManager.js";
import { shouldUseSmtp, type SmtpConfig, type sendSerialViaSmtp } from "@/services/smtpMailer.js";
import type { SerialEmailRecipient } from "@/types.js";
import { errorResponse, successResponse, withErrorHandling } from "@/tools/respond.js";

export interface SerialEmailDeps {
  smtpConfigured: () => boolean;
  smtpConfig: () => SmtpConfig;
  smtpSend: typeof sendSerialViaSmtp;
  appleScriptSend: AppleMailManager["sendSerialEmail"];
}

type SerialEmailArgs = {
  recipients: SerialEmailRecipient[];
  subject: string;
  body: string;
  account?: string;
  delayMs?: number;
};

export function createSerialEmailHandler(deps: SerialEmailDeps) {
  return withErrorHandling(
    async ({ recipients, subject, body, account, delayMs }: SerialEmailArgs) => {
      const useSmtp = shouldUseSmtp(undefined, account, deps.smtpConfigured());
      // Selecting SMTP commits this batch to that transport. A credential/config
      // error must reach the tool's error response before any message is submitted;
      // switching to Mail.app could change both the sender and delivery format.
      const results = useSmtp
        ? await deps.smtpSend(recipients, subject, body, deps.smtpConfig(), { delayMs })
        : deps.appleScriptSend(recipients, subject, body, account, delayMs);
      const successCount = results.filter((r) => r.success).length;
      const failCount = results.length - successCount;

      const details = results
        .map((r) => `  - ${r.email}: ${r.success ? "sent" : `FAILED (${r.error})`}`)
        .join("\n");
      const structured = {
        ok: failCount === 0,
        sent: successCount,
        failed: failCount,
        transport: useSmtp ? "smtp" : "applescript",
        results: results.map((r) => ({ email: r.email, success: r.success, error: r.error })),
      };

      if (failCount === 0) {
        return successResponse(
          `Successfully sent ${successCount} email(s):\n${details}`,
          structured
        );
      } else if (successCount === 0) {
        return errorResponse(`Failed to send all ${failCount} email(s):\n${details}`, structured);
      } else {
        return successResponse(
          `Sent ${successCount} of ${results.length} email(s), ${failCount} failed:\n${details}`,
          structured
        );
      }
    },
    "Error sending serial emails"
  );
}
