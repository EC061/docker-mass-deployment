import { fillBracketTokens, renderTemplate, stripLegacyEmailSignature } from "./template";

export interface AnnouncementPreviewRecipient {
  email: string;
  name: string;
  firstName?: string | null;
  lastName?: string | null;
  degree?: string | null;
}

export interface AnnouncementPreviewSender {
  name: string;
  email: string;
}

export interface AnnouncementPreview {
  subject: string;
  body: string;
  recipient: AnnouncementPreviewRecipient | null;
}

/**
 * Render the compose form exactly as an announcement email will be rendered. The first selected
 * recipient supplies recipient-specific values. Missing values are deliberately omitted from the
 * substitution map so their {placeholders} remain visible in the preview.
 */
export function renderAnnouncementPreview(input: {
  subject: string;
  body: string;
  recipients: AnnouncementPreviewRecipient[];
  sender: AnnouncementPreviewSender;
  placeholders: Record<string, string>;
  signatureText: string;
}): AnnouncementPreview {
  const recipient = input.recipients[0] ?? null;
  const vars: Record<string, string> = {};
  const set = (key: string, value: string | null | undefined) => {
    const clean = (value ?? "").trim();
    if (clean) vars[key] = clean;
  };

  if (recipient) {
    set("name", recipient.name);
    set("first_name", recipient.firstName);
    set("last_name", recipient.lastName);
    set("degree", recipient.degree);
    set("email", recipient.email);
  }
  set("sender", input.sender.name);
  set("sender_email", input.sender.email);

  // Empty bracket fields have not been filled yet, so keep [TOKEN] visible until the admin types a
  // value. This mirrors the send-time order: brackets first, then per-recipient {variables}.
  const filledPlaceholders = Object.fromEntries(
    Object.entries(input.placeholders).filter(([, value]) => value.trim() !== ""),
  );
  const subject = renderTemplate(fillBracketTokens(input.subject, filledPlaceholders), vars);
  const renderedBody = renderTemplate(fillBracketTokens(input.body, filledPlaceholders), vars);
  const cleanBody = stripLegacyEmailSignature(renderedBody).trimEnd();
  const signature = input.signatureText.trim();

  return {
    subject,
    body: [cleanBody, signature].filter(Boolean).join("\n\n"),
    recipient,
  };
}
