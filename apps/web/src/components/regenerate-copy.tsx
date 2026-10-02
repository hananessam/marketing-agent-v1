"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, errorDetails } from "@/lib/api";
import type { GenerationProgress as Progress } from "@/lib/types";
import { GenerationProgress } from "@/components/generation-progress";
import { Button, ErrorBox, inputClass } from "@/components/ui";

/** Asks the AI to write all the copy of a draft again. The new copy follows the same brand rules; if it can't, the current copy stays. */
export function RegenerateCopy({ campaignId }: { campaignId: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState("");

  // The panel names its own request so it can watch it while it runs.
  const [progressKey, setProgressKey] = useState<string | null>(null);

  const rewrite = useMutation({
    mutationFn: (key: string) => api(`/campaigns/${campaignId}/regenerate-content`, {
      method: "POST", headers: { "x-progress-key": key }, body: note.trim() ? { guidance: note.trim() } : {},
    }),
    onSuccess: () => {
      setOpen(false);
      setNote("");
      qc.invalidateQueries({ queryKey: ["campaign", campaignId] });
      qc.invalidateQueries({ queryKey: ["campaigns"] });
    },
  });

  const progress = useQuery({
    queryKey: ["campaign-progress", progressKey],
    queryFn: () => api<Progress>(`/campaigns/progress/${progressKey}`),
    enabled: rewrite.isPending && progressKey !== null,
    refetchInterval: 700,
    refetchIntervalInBackground: true,
  });
  const start = () => { const key = crypto.randomUUID(); setProgressKey(key); rewrite.mutate(key); };

  if (!open) {
    return (
      <div className="flex items-center gap-3">
        <Button variant="secondary" onClick={() => setOpen(true)}>Rewrite all the copy with AI</Button>
        <span className="text-xs text-zinc-500">Not happy with the wording? Get a fresh version.</span>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-lg border border-zinc-200 p-4 dark:border-zinc-800">
      <div>
        <p className="text-sm font-medium">Rewrite all the copy with AI</p>
        <p className="text-xs text-zinc-500">
          The plan stays the same; every headline, description and button is written again, with different wording and the same brand rules.
          <strong> This replaces all the copy below, including any changes you made.</strong>
        </p>
      </div>
      <label className="block text-sm">
        <span className="mb-1 block font-medium">What should change? <span className="font-normal text-zinc-500">(optional)</span></span>
        <textarea className={inputClass} rows={2} maxLength={300} value={note} onChange={(e) => setNote(e.target.value)} disabled={rewrite.isPending}
          placeholder="For example: more playful, focus on saving time, shorter" />
      </label>
      {rewrite.isPending && <GenerationProgress events={progress.data?.events ?? []} />}
      {rewrite.error && <ErrorBox error={rewrite.error.message} details={errorDetails(rewrite.error)} />}
      <div className="flex items-center gap-3">
        <Button onClick={start} disabled={rewrite.isPending}>{rewrite.isPending ? "Rewriting…" : "Rewrite the copy"}</Button>
        <Button variant="secondary" onClick={() => { setOpen(false); rewrite.reset(); }} disabled={rewrite.isPending}>Cancel</Button>
      </div>
    </div>
  );
}
