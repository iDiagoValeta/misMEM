// Owns the trait view of the detail panel and its forget confirmation.
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { actions, api, isMissing, type ForgetChallenge } from "../api";
import type { Selection } from "../App";
import { ago, exact } from "../format";
import { errorMessage } from "../lib/errors";
import { DetailFailure, DetailLoading, SectionTitle, tint, truncate } from "./DetailParts";

export function TraitView({
  id,
  onSelect,
  onChanged,
  onAnnounce,
}: {
  id: string;
  onSelect: (selection: Selection) => void;
  onChanged: (next?: Selection | null) => void;
  onAnnounce: (text: string) => void;
}) {
  const query = useQuery({ queryKey: ["trait", id], queryFn: ({ signal }) => api.trait(id, signal) });
  const [confirm, setConfirm] = useState(false);
  const [challenge, setChallenge] = useState<ForgetChallenge>();
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const data = query.data;
  useEffect(() => {
    if (data) onAnnounce(`Rasgo abierto: ${truncate(data.trait.text, 120)}`);
  }, [data, onAnnounce]);

  if (!data) {
    return query.isError ? <DetailFailure what="el rasgo" error={query.error} /> : <DetailLoading label="Cargando el rasgo…" />;
  }
  const { trait, evidence } = data;

  // Como la memoria: primero el servidor da el token que confirma, y sólo con él borra.
  const askForget = async () => {
    setConfirm(true);
    setChallenge(undefined);
    setActionError(undefined);
    try {
      setChallenge(await actions.forgetTraitChallenge(trait.id));
    } catch (err) {
      setActionError(errorMessage(err));
    }
  };

  const forget = async () => {
    if (!challenge) return;
    setBusy(true);
    setActionError(undefined);
    try {
      await actions.forgetTrait(trait.id, challenge.confirm_token);
      setConfirm(false);
      toast.success("Rasgo olvidado.");
      onChanged(null);
    } catch (err) {
      const message = errorMessage(err);
      setActionError(message);
      toast.error(`No se pudo: ${message}`);
      setChallenge(undefined);
      actions.forgetTraitChallenge(trait.id).then(setChallenge, () => undefined);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <p className="mb-1 text-[11px] uppercase tracking-wider text-brand-text">Rasgo</p>
      <p className="text-sm leading-relaxed text-ink">{trait.text}</p>

      {query.isError && (
        <p role="status" className="mt-2 rounded-md bg-field px-2 py-1.5 text-xs text-ink-muted">
          No se pudo actualizar el rasgo: {errorMessage(query.error)}. Se muestra lo último que llegó.
        </p>
      )}

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-ink-muted">Ámbito</dt>
        <dd className="text-ink-soft">{trait.scope}</dd>
        <dt className="text-ink-muted">Fuerza</dt>
        <dd className="tabular-nums text-ink-soft">{trait.strength}</dd>
        <dt className="text-ink-muted">Polaridad</dt>
        <dd className="text-ink-soft">{trait.polarity}</dd>
        <dt className="text-ink-muted">Actualizado</dt>
        <dd className="text-ink-soft" title={exact(trait.updated_at)}>
          {ago(trait.updated_at)}
        </dd>
      </dl>

      <div className="mt-4">
        <Button type="button" variant="outline" size="sm" className="text-danger" onClick={() => void askForget()}>
          Olvidar rasgo
        </Button>
      </div>

      <section className="mt-5">
        <SectionTitle>Memorias que lo sostienen</SectionTitle>
        {evidence.length === 0 ? (
          <p className="text-sm text-ink-muted">Ninguna memoria lo sostiene.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {evidence.map((memory) =>
              isMissing(memory) ? (
                <li key={memory.id} className="rounded-md bg-field px-2.5 py-2 text-sm text-ink-muted">
                  Memoria olvidada
                </li>
              ) : (
                <li key={memory.id}>
                  <button
                    type="button"
                    className="rounded-md text-left text-sm hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                    style={{ color: tint(memory.salience) }}
                    onClick={() => onSelect({ layer: "memory", id: memory.id })}
                  >
                    {memory.text}
                  </button>
                </li>
              ),
            )}
          </ul>
        )}
      </section>

      <AlertDialog
        open={confirm}
        onOpenChange={(open) => {
          if (!open) {
            setConfirm(false);
            setChallenge(undefined);
            setActionError(undefined);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Olvidar este rasgo</AlertDialogTitle>
            <AlertDialogDescription>
              {challenge
                ? "Se borra el rasgo. Las memorias que lo sostienen no se tocan. No se puede deshacer."
                : actionError
                  ? "No se puede olvidar este rasgo ahora."
                  : "Mirando qué se perdería…"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {actionError && (
            <p role="alert" className="text-sm text-danger">
              No se pudo: {actionError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancelar</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busy || !challenge}
              onClick={(event) => {
                event.preventDefault();
                void forget();
              }}
            >
              {busy ? "Un momento…" : "Olvidar rasgo"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
