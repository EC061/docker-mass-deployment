import { describe, expect, it } from "vitest";
import {
  announcementAttachmentsFromForm,
  safeAttachmentFilename,
} from "../src/lib/announcement-attachments";
import {
  MAX_ANNOUNCEMENT_ATTACHMENTS,
  MAX_ANNOUNCEMENT_ATTACHMENT_BYTES,
  MAX_ANNOUNCEMENT_ATTACHMENTS_BYTES,
} from "../src/lib/announcement-attachment-limits";

describe("announcement attachment uploads", () => {
  it("accepts any file type and preserves its bytes and MIME type", async () => {
    const formData = new FormData();
    formData.append(
      "attachments",
      new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "results.zip", {
        type: "application/zip",
      }),
    );

    const attachments = await announcementAttachmentsFromForm(formData);

    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      filename: "results.zip",
      contentType: "application/zip",
    });
    expect([...attachments[0].content]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("ignores an empty browser file field and cleans untrusted filenames", async () => {
    const formData = new FormData();
    formData.append("attachments", new File([], ""));
    expect(await announcementAttachmentsFromForm(formData)).toEqual([]);
    expect(safeAttachmentFilename("C:\\fakepath\\notes\n.pdf", 0)).toBe("notes_.pdf");
  });

  it("rejects too many files, an oversized file, and an oversized combined upload", async () => {
    const tooMany = new FormData();
    for (let i = 0; i <= MAX_ANNOUNCEMENT_ATTACHMENTS; i += 1) {
      tooMany.append("attachments", new File(["x"], `${i}.txt`));
    }
    await expect(announcementAttachmentsFromForm(tooMany)).rejects.toThrow(/no more than/);

    const tooLarge = new FormData();
    tooLarge.append(
      "attachments",
      new File([new Uint8Array(MAX_ANNOUNCEMENT_ATTACHMENT_BYTES + 1)], "large.bin"),
    );
    await expect(announcementAttachmentsFromForm(tooLarge)).rejects.toThrow(/large\.bin/);

    const combined = new FormData();
    combined.append(
      "attachments",
      new File([new Uint8Array(MAX_ANNOUNCEMENT_ATTACHMENTS_BYTES / 2 + 1)], "one.bin"),
    );
    combined.append(
      "attachments",
      new File([new Uint8Array(MAX_ANNOUNCEMENT_ATTACHMENTS_BYTES / 2 + 1)], "two.bin"),
    );
    await expect(announcementAttachmentsFromForm(combined)).rejects.toThrow(/total more than/);
  });
});
