"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  html: string;
  action: (formData: FormData) => void | Promise<void>;
}

/** Copy/paste HTML editor and isolated preview for the signature shared by every outbound email. */
export function SignatureEditor({ html: initialHtml, action }: Props) {
  const [html, setHtml] = useState(initialHtml);
  const [clipboardStatus, setClipboardStatus] = useState("");

  async function pasteFromClipboard() {
    try {
      if (navigator.clipboard.read) {
        const items = await navigator.clipboard.read();
        for (const item of items) {
          if (item.types.includes("text/html")) {
            setHtml(await (await item.getType("text/html")).text());
            setClipboardStatus("Pasted the formatted HTML from your clipboard.");
            return;
          }
        }
      }
      setHtml(await navigator.clipboard.readText());
      setClipboardStatus("Pasted the HTML source from your clipboard.");
    } catch {
      setClipboardStatus("Clipboard access was blocked. Paste directly into the HTML field instead.");
    }
  }

  async function copySignature() {
    try {
      const wrapper = document.createElement("div");
      wrapper.innerHTML = html;
      const plain = wrapper.innerText.trim();
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/html": new Blob([html], { type: "text/html" }),
          "text/plain": new Blob([plain], { type: "text/plain" }),
        }),
      ]);
      setClipboardStatus("Copied the formatted signature. You can paste it into an email client.");
    } catch {
      try {
        await navigator.clipboard.writeText(html);
        setClipboardStatus("Copied the signature HTML source.");
      } catch {
        setClipboardStatus("Clipboard access was blocked. Select and copy the HTML field manually.");
      }
    }
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="text-base font-semibold">Universal email signature</h2>
          <p className="text-sm text-muted-foreground">
            Appended to every email sent by the controller. Paste HTML from the UGA signature builder,
            review it below, then save.
          </p>
        </div>

        <form action={action} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="signature-html">Signature HTML</Label>
            <Textarea
              id="signature-html"
              name="signatureHtml"
              rows={14}
              value={html}
              onChange={(event) => setHtml(event.target.value)}
              className="font-mono text-xs"
              spellCheck={false}
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit">Save signature</Button>
            <Button type="button" variant="outline" onClick={pasteFromClipboard}>
              Paste from clipboard
            </Button>
            <Button type="button" variant="outline" onClick={copySignature}>
              Copy signature
            </Button>
          </div>
          {clipboardStatus ? (
            <p className="text-xs text-muted-foreground" role="status">
              {clipboardStatus}
            </p>
          ) : null}
        </form>

        <div className="flex flex-col gap-1.5">
          <Label>Preview</Label>
          <iframe
            key={html}
            title="Universal email signature preview"
            sandbox=""
            srcDoc={`<!doctype html><html><body>${html}</body></html>`}
            className="h-44 w-full rounded-md border border-input bg-white p-3"
          />
        </div>
      </CardContent>
    </Card>
  );
}
