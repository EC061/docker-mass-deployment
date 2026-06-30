import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface Props {
  text: string;
  action: (formData: FormData) => void | Promise<void>;
}

/** Plain-text signature shared by every outbound email. */
export function SignatureEditor({ text, action }: Props) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Universal email signature</CardTitle>
        <CardDescription>
          Appended to every email exactly as entered. Leave it blank to send emails without a signature.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form action={action} className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="signature-text">Plain-text signature</Label>
            <Textarea
              id="signature-text"
              name="signatureText"
              rows={6}
              defaultValue={text}
              className="font-mono text-xs"
            />
          </div>
          <div>
            <Button type="submit">Save signature</Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
