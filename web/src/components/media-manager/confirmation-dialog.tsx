"use client";

import { useEffect, useState, type ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

type ConfirmationDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  context?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  variant?: "default" | "secondary" | "outline" | "destructive";
  onConfirm: () => Promise<void>;
};

export function ConfirmationDialog({
  open,
  onOpenChange,
  title,
  description,
  context,
  confirmLabel,
  cancelLabel = "Cancel",
  variant = "default",
  onConfirm,
}: ConfirmationDialogProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (open) setError("");
  }, [open]);

  async function confirm() {
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      onOpenChange(false);
    } catch (value: any) {
      setError(value?.message || "The action could not be completed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(value) => !busy && onOpenChange(value)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {context && <div className="rounded border bg-muted/30 p-3 text-sm">{context}</div>}
        {error && <p className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>{cancelLabel}</Button>
          <Button variant={variant} onClick={() => void confirm()} disabled={busy}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
