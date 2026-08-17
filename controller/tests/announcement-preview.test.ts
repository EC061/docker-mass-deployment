import { describe, expect, it } from "vitest";
import { renderAnnouncementPreview } from "../src/lib/announcement-preview";

const sender = { name: "Research Computing", email: "support@uga.edu" };

describe("renderAnnouncementPreview", () => {
  it("leaves recipient and empty bracket placeholders visible when no recipient is selected", () => {
    const preview = renderAnnouncementPreview({
      subject: "Hello {name} — [DATE]",
      body: "Email {email}; first {first_name}; from {sender} ({sender_email}) at [TIME].",
      recipients: [],
      sender,
      placeholders: { DATE: "", TIME: "" },
      signatureText: "Lab Manager",
    });

    expect(preview.recipient).toBeNull();
    expect(preview.subject).toBe("Hello {name} — [DATE]");
    expect(preview.body).toBe(
      "Email {email}; first {first_name}; from Research Computing (support@uga.edu) at [TIME].\n\nLab Manager",
    );
  });

  it("uses the first selected recipient and fills every available value in send order", () => {
    const preview = renderAnnouncementPreview({
      subject: "For {name}: [EVENT]",
      body: "{first_name} {last_name} / {degree} / {email} / {sender}",
      recipients: [
        {
          name: "Alice Adams",
          firstName: "Alice",
          lastName: "Adams",
          degree: "PhD",
          email: "alice@uga.edu",
        },
        { name: "Bob Brown", email: "bob@uga.edu" },
      ],
      sender,
      placeholders: { EVENT: "Maintenance" },
      signatureText: "",
    });

    expect(preview.recipient?.email).toBe("alice@uga.edu");
    expect(preview.subject).toBe("For Alice Adams: Maintenance");
    expect(preview.body).toBe("Alice Adams / PhD / alice@uga.edu / Research Computing");
  });

  it("keeps unavailable fields visible for a selected recipient", () => {
    const preview = renderAnnouncementPreview({
      subject: "Hi {name}",
      body: "Standing: {degree}; surname: {last_name}",
      recipients: [{ name: "alice", email: "alice@uga.edu" }],
      sender,
      placeholders: {},
      signatureText: "",
    });

    expect(preview.body).toBe("Standing: {degree}; surname: {last_name}");
  });
});
