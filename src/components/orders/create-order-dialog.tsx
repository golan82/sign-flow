"use client";

import { useRef, useState, type FormEvent } from "react";
import { Plus } from "lucide-react";

import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createOrderRequest } from "@/lib/orders/api-client";
import {
  createOrderSchema,
  DESCRIPTION_MAX_LENGTH,
  TITLE_MAX_LENGTH,
} from "@/lib/orders/schemas";
import type { OrderDto } from "@/lib/orders/types";

type FieldErrors = { title?: string; description?: string };

function toFieldErrors(issues: { path: string; message: string }[]): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of issues) {
    if (issue.path === "title" || issue.path === "description") {
      errors[issue.path] ??= issue.message;
    }
  }
  return errors;
}

export function CreateOrderDialog({ onCreated }: { onCreated: (order: OrderDto) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);

  function handleOpenChange(next: boolean) {
    // Keep the dialog open while the request is in flight.
    if (pendingRef.current) return;
    setOpen(next);
    if (next) {
      setFieldErrors({});
      setFormError(null);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pendingRef.current) return;

    const parsed = createOrderSchema.safeParse({ title, description });
    if (!parsed.success) {
      setFieldErrors(
        toFieldErrors(
          parsed.error.issues.map((issue) => ({
            path: issue.path.join("."),
            message: issue.message,
          })),
        ),
      );
      setFormError(null);
      return;
    }

    pendingRef.current = true;
    setPending(true);
    setFieldErrors({});
    setFormError(null);
    try {
      const result = await createOrderRequest(parsed.data);
      if (result.ok) {
        setTitle("");
        setDescription("");
        setOpen(false);
        onCreated(result.data.order);
        return;
      }
      if (result.error.issues?.length) {
        setFieldErrors(toFieldErrors(result.error.issues));
      }
      setFormError(result.error.message);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus aria-hidden="true" />
          New order
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit} noValidate className="grid gap-4">
          <DialogHeader>
            <DialogTitle>New order</DialogTitle>
            <DialogDescription>
              New orders start as drafts. You can submit them afterwards.
            </DialogDescription>
          </DialogHeader>

          {formError && (
            <Alert variant="destructive">
              <AlertDescription>{formError}</AlertDescription>
            </Alert>
          )}

          <div className="grid gap-2">
            <Label htmlFor="order-title">Title</Label>
            <Input
              id="order-title"
              name="title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={TITLE_MAX_LENGTH}
              required
              disabled={pending}
              aria-invalid={fieldErrors.title ? true : undefined}
              aria-describedby={fieldErrors.title ? "order-title-error" : undefined}
            />
            {fieldErrors.title && (
              <p id="order-title-error" className="text-sm text-destructive">
                {fieldErrors.title}
              </p>
            )}
          </div>

          <div className="grid gap-2">
            <div className="flex items-baseline justify-between gap-2">
              <Label htmlFor="order-description">
                Description <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <span id="order-description-count" className="text-xs text-muted-foreground">
                {description.length}/{DESCRIPTION_MAX_LENGTH}
              </span>
            </div>
            <Textarea
              id="order-description"
              name="description"
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={DESCRIPTION_MAX_LENGTH}
              rows={4}
              disabled={pending}
              aria-invalid={fieldErrors.description ? true : undefined}
              aria-describedby={
                fieldErrors.description
                  ? "order-description-error order-description-count"
                  : "order-description-count"
              }
            />
            {fieldErrors.description && (
              <p id="order-description-error" className="text-sm text-destructive">
                {fieldErrors.description}
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Creating…" : "Create order"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
