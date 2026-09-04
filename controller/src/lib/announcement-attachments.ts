import type { MailAttachment } from "./mailer";
import {
  MAX_ANNOUNCEMENT_ATTACHMENTS,
  MAX_ANNOUNCEMENT_ATTACHMENT_BYTES,
  MAX_ANNOUNCEMENT_ATTACHMENTS_BYTES,
} from "./announcement-attachment-limits";

function megabytes(bytes: number): string {
  return `${bytes / (1024 * 1024)} MB`;
}

/** Strip submitted paths and control characters before using a client-supplied name in MIME. */
export function safeAttachmentFilename(name: string, index: number): string {
  const leaf = name.split(/[\\/]/).at(-1)?.replace(/[\u0000-\u001f\u007f]/g, "_").trim();
  return (leaf || `attachment-${index + 1}`).slice(0, 255);
}

function safeContentType(type: string): string | undefined {
  return /^[\w!#$&^.+-]+\/[\w!#$&^.+-]+$/.test(type) ? type : undefined;
}

function validateSizes(files: { name: string; size: number }[]): void {
  if (files.length > MAX_ANNOUNCEMENT_ATTACHMENTS) {
    throw new Error(`attach no more than ${MAX_ANNOUNCEMENT_ATTACHMENTS} files`);
  }

  let total = 0;
  for (const file of files) {
    if (file.size > MAX_ANNOUNCEMENT_ATTACHMENT_BYTES) {
      throw new Error(
        `${file.name} is larger than ${megabytes(MAX_ANNOUNCEMENT_ATTACHMENT_BYTES)}`,
      );
    }
    total += file.size;
  }
  if (total > MAX_ANNOUNCEMENT_ATTACHMENTS_BYTES) {
    throw new Error(
      `attachments total more than ${megabytes(MAX_ANNOUNCEMENT_ATTACHMENTS_BYTES)}`,
    );
  }
}

/** Validate and materialize uploaded files only after their declared sizes pass the limits. */
export async function announcementAttachmentsFromForm(formData: FormData): Promise<MailAttachment[]> {
  const files = formData
    .getAll("attachments")
    .filter((entry): entry is File => typeof entry !== "string" && !!(entry.name || entry.size));
  validateSizes(files.map((file) => ({ name: file.name, size: file.size })));

  return Promise.all(
    files.map(async (file, index) => ({
      filename: safeAttachmentFilename(file.name, index),
      content: Buffer.from(await file.arrayBuffer()),
      contentType: safeContentType(file.type),
    })),
  );
}

/** Apply the same limits to non-form callers before the mailer starts encoding MIME messages. */
export function validateAnnouncementAttachments(attachments: readonly MailAttachment[]): void {
  validateSizes(
    attachments.map((attachment) => ({
      name: attachment.filename,
      size: attachment.content.byteLength,
    })),
  );
}
