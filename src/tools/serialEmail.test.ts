import { describe, expect, it, vi } from "vitest";
import { createSerialEmailHandler, type SerialEmailDeps } from "./serialEmail.js";
import type { SmtpConfig } from "@/services/smtpMailer.js";

const config: SmtpConfig = {
  host: "smtp.example.test",
  port: 587,
  secure: false,
  user: "sender@example.test",
  pass: "fixture-only",
  from: "sender@example.test",
};
const recipients = [{ email: "recipient@example.test", variables: { Name: "Recipient" } }];
const args = { recipients, subject: "Hello {{Name}}", body: "Test body", delayMs: 0 };
const results = [{ email: recipients[0].email, success: true }];

function fixture() {
  return {
    smtpConfigured: vi.fn(() => true),
    smtpConfig: vi.fn(() => config),
    smtpSend: vi.fn(async () => results),
    appleScriptSend: vi.fn(() => results),
  } satisfies SerialEmailDeps;
}

describe("mail-merge transport selection", () => {
  it("returns an error without sending when selected SMTP credentials cannot be resolved", async () => {
    const deps = fixture();
    deps.smtpConfig.mockImplementation(() => {
      throw new Error("No SMTP password found");
    });

    const response = await createSerialEmailHandler(deps)(args);

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("No SMTP password found");
    expect(deps.smtpSend).not.toHaveBeenCalled();
    expect(deps.appleScriptSend).not.toHaveBeenCalled();
  });

  it("uses configured SMTP and preserves the batch result", async () => {
    const deps = fixture();

    const response = await createSerialEmailHandler(deps)(args);

    expect(deps.smtpSend).toHaveBeenCalledWith(recipients, args.subject, args.body, config, {
      delayMs: 0,
    });
    expect(deps.appleScriptSend).not.toHaveBeenCalled();
    expect(response.structuredContent).toMatchObject({
      ok: true,
      sent: 1,
      failed: 0,
      transport: "smtp",
      results,
    });
  });

  it("keeps the native route available when SMTP is not configured", async () => {
    const deps = fixture();
    deps.smtpConfigured.mockReturnValue(false);

    const response = await createSerialEmailHandler(deps)(args);

    expect(deps.appleScriptSend).toHaveBeenCalledWith(
      recipients,
      args.subject,
      args.body,
      undefined,
      0
    );
    expect(deps.smtpConfig).not.toHaveBeenCalled();
    expect(deps.smtpSend).not.toHaveBeenCalled();
    expect(response.structuredContent).toMatchObject({
      ok: true,
      sent: 1,
      transport: "applescript",
    });
  });

  it("preserves explicit Mail.app account selection", async () => {
    const deps = fixture();

    await createSerialEmailHandler(deps)({ ...args, account: "Work" });

    expect(deps.appleScriptSend).toHaveBeenCalledWith(
      recipients,
      args.subject,
      args.body,
      "Work",
      0
    );
    expect(deps.smtpConfig).not.toHaveBeenCalled();
    expect(deps.smtpSend).not.toHaveBeenCalled();
  });

  it("does not switch transports after an SMTP submission failure", async () => {
    const deps = fixture();
    deps.smtpSend.mockRejectedValue(new Error("SMTP submission failed"));

    const response = await createSerialEmailHandler(deps)(args);

    expect(response.isError).toBe(true);
    expect(response.content[0].text).toContain("SMTP submission failed");
    expect(deps.appleScriptSend).not.toHaveBeenCalled();
  });

  it("reports the selected transport and failures when no recipient succeeds", async () => {
    const deps = fixture();
    deps.smtpSend.mockResolvedValue([{ email: recipients[0].email, success: false }]);

    const response = await createSerialEmailHandler(deps)(args);

    expect(response.isError).toBe(true);
    expect(response.structuredContent).toMatchObject({
      ok: false,
      sent: 0,
      failed: 1,
      transport: "smtp",
    });
    expect(deps.appleScriptSend).not.toHaveBeenCalled();
  });

  it("reports partial SMTP results without retrying failed recipients through Mail.app", async () => {
    const deps = fixture();
    const batch = [...recipients, { email: "second@example.test", variables: {} }];
    deps.smtpSend.mockResolvedValue([
      { email: batch[0].email, success: true },
      { email: batch[1].email, success: false },
    ]);

    const response = await createSerialEmailHandler(deps)({ ...args, recipients: batch });

    expect(response.structuredContent).toMatchObject({
      ok: false,
      sent: 1,
      failed: 1,
      transport: "smtp",
    });
    expect(deps.appleScriptSend).not.toHaveBeenCalled();
  });
});
