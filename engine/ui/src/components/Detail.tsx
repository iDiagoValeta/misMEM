import { useEffect, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
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
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { actions, api, isMissing, type MemoryDetail } from "../api";
import type { Selection } from "../App";
import { ago, exact, percent } from "../format";
import { errorMessage } from "../lib/errors";
import { inkPercent } from "../lib/ink";

interface DetailProps {
  selected: Selection | undefined;
  onSelect: (selection: Selection) => void;
  onClose: () => void;
  /** Refresca lo que dependa de la escritura y, si viene, cambia o cierra la selección. */
  onChanged: (next?: Selection | null) => void;
}

const tint = (salience: number): string =>
  `color-mix(in oklab, var(--color-ink) ${inkPercent(salience)}%, var(--color-ink-muted))`;

const truncate = (text: string, max: number): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * En escritorio el detalle vive en la tercera columna; en móvil, en un Sheet de Radix,
 * que aporta foco atrapado y lo devuelve al cerrar. Sólo se monta una de las dos.
 */
export function DetailPanel(props: DetailProps) {
  const isDesktop = useMediaQuery("(min-width: 768px)");

  if (isDesktop) {
    return (
      <aside aria-label="Detalle" className="min-h-0 overflow-y-auto border-l border-edge bg-surface-raised">
        {props.selected ? (
          <Detail {...props} selected={props.selected} />
        ) : (
          <p className="p-4 text-sm text-ink-muted">Elige un recuerdo para ver de dónde sale y qué lo cita.</p>
        )}
      </aside>
    );
  }

  return (
    <Sheet open={props.selected !== undefined} onOpenChange={(open) => !open && props.onClose()}>
      <SheetContent side="right" showCloseButton={false} className="w-full gap-0 p-0 sm:max-w-md">
        <SheetHeader className="sr-only">
          <SheetTitle>Detalle del recuerdo</SheetTitle>
          <SheetDescription>Contenido del elemento seleccionado.</SheetDescription>
        </SheetHeader>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {props.selected && <Detail {...props} selected={props.selected} />}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Detail({ selected, onSelect, onClose, onChanged }: DetailProps & { selected: Selection }) {
  return (
    <article className="p-4" data-layer={selected.layer}>
      <div className="mb-3 flex items-center justify-between gap-2">
        <span className="text-[11px] uppercase tracking-wider text-ink-muted">Detalle</span>
        <Button type="button" variant="ghost" size="xs" onClick={onClose}>
          Cerrar
        </Button>
      </div>
      {selected.layer === "memory" && (
        <MemoryView key={selected.id} id={selected.id} onSelect={onSelect} onChanged={onChanged} />
      )}
      {selected.layer === "trait" && (
        <TraitView key={selected.id} id={selected.id} onSelect={onSelect} onChanged={onChanged} />
      )}
      {selected.layer === "episode" && <EpisodeView selection={selected} />}
    </article>
  );
}

/** El título del detalle se anuncia al cambiar de selección (D14). */
function LiveTitle({ children }: { children: string }) {
  return (
    <p className="sr-only" aria-live="polite">
      {children}
    </p>
  );
}

function SectionTitle({ children }: { children: string }) {
  return <h3 className="mb-1.5 text-[11px] uppercase tracking-wider text-ink-muted">{children}</h3>;
}

function DetailLoading({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="flex flex-col gap-2">
      <span role="status" className="sr-only">
        {label}
      </span>
      <Skeleton className="h-5 w-24 bg-field" />
      <Skeleton className="h-20 w-full bg-field" />
      <Skeleton className="h-28 w-full bg-field" />
    </div>
  );
}

function DetailFailure({ what, error }: { what: string; error: unknown }) {
  return (
    <p role="alert" className="rounded-md bg-field px-2 py-2 text-sm text-danger">
      No se pudo cargar {what}: {errorMessage(error)}
    </p>
  );
}

function MemoryView({
  id,
  onSelect,
  onChanged,
}: {
  id: string;
  onSelect: (selection: Selection) => void;
  onChanged: (next?: Selection | null) => void;
}) {
  const queryClient = useQueryClient();
  const query = useQuery({ queryKey: ["memory", id], queryFn: ({ signal }) => api.memory(id, signal) });
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"unconsolidate" | "forget" | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const data = query.data;
  if (!data) {
    return query.isError ? <DetailFailure what="la memoria" error={query.error} /> : <DetailLoading label="Cargando la memoria…" />;
  }
  const { memory, episodes, traits } = data;
  const linked = episodes.filter((episode) => !isMissing(episode) && episode.linked_here).length;

  const save = async (gist: string, details: string | null) => {
    await actions.editMemory(memory.id, gist, details);
    // D6: el detalle pinta el texto nuevo antes de que termine la recarga.
    queryClient.setQueryData<MemoryDetail>(["memory", memory.id], (previous) =>
      previous ? { ...previous, memory: { ...previous.memory, text: gist, details } } : previous,
    );
    setEditing(false);
    toast.success("Memoria corregida.");
    void queryClient.invalidateQueries();
  };

  const runAction = async (kind: "unconsolidate" | "forget") => {
    setBusy(true);
    setActionError(undefined);
    try {
      if (kind === "unconsolidate") {
        const out = await actions.unconsolidate(memory.id);
        setConfirm(null);
        toast.success(
          out.episodes_released === 1
            ? "Consolidación deshecha: el episodio vuelve a estar pendiente."
            : `Consolidación deshecha: ${out.episodes_released} episodios vuelven a estar pendientes.`,
        );
      } else {
        const out = await actions.forgetMemory(memory.id);
        setConfirm(null);
        toast.success(
          out.episodes_deleted === 1
            ? "Memoria olvidada con su episodio."
            : `Memoria olvidada con ${out.episodes_deleted} episodios.`,
        );
      }
      onChanged(null);
    } catch (err) {
      const message = errorMessage(err);
      setActionError(message);
      toast.error(`No se pudo: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <LiveTitle>{`Memoria abierta: ${truncate(memory.text, 120)}`}</LiveTitle>
      <p className="mb-1 text-[11px] uppercase tracking-wider text-brand-text">Memoria</p>

      {editing ? (
        <EditForm
          gist={memory.text}
          details={memory.details}
          onCancel={() => setEditing(false)}
          onSave={save}
        />
      ) : (
        <>
          <p className="text-sm leading-relaxed" style={{ color: tint(memory.salience) }}>
            {memory.text}
          </p>
          {memory.details && memory.details !== memory.text && (
            <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-ink-soft">{memory.details}</p>
          )}
        </>
      )}

      {query.isError && (
        <p role="status" className="mt-2 rounded-md bg-field px-2 py-1.5 text-xs text-ink-muted">
          No se pudo actualizar la memoria: {errorMessage(query.error)}. Se muestra lo último que llegó.
        </p>
      )}

      <div
        role="meter"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={memory.salience}
        aria-valuetext={`Saliencia ${percent(memory.salience)}`}
        className="mt-4"
      >
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="text-ink-muted">Saliencia hoy</span>
          <span className="tabular-nums text-ink-soft">{percent(memory.salience)}</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-field">
          <div className="h-full rounded-full bg-brand" style={{ width: `${inkPercent(memory.salience)}%` }} />
        </div>
        {memory.stored_salience !== memory.salience && (
          <p className="mt-1 text-[11px] text-ink-muted">
            guardada {percent(memory.stored_salience)}; se reduce a la mitad cada 90 días sin uso
          </p>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-ink-muted">Ámbito</dt>
        <dd className="text-ink-soft">{memory.scope}</dd>
        <dt className="text-ink-muted">Consolidada</dt>
        <dd className="text-ink-soft" title={exact(memory.created_at)}>
          {ago(memory.created_at)}
        </dd>
        <dt className="text-ink-muted">Último uso</dt>
        <dd className="text-ink-soft">{ago(memory.last_accessed_at)}</dd>
      </dl>

      {!editing && (
        <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="Acciones sobre la memoria">
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            Corregir
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => setConfirm("unconsolidate")}>
            Deshacer consolidación
          </Button>
          <Button type="button" variant="outline" size="sm" className="text-danger" onClick={() => setConfirm("forget")}>
            Olvidar
          </Button>
        </div>
      )}

      <section className="mt-5">
        <SectionTitle>De dónde sale</SectionTitle>
        {episodes.length === 0 ? (
          <p className="text-sm text-ink-muted">No consta ningún episodio de origen.</p>
        ) : (
          <ol className="flex flex-col gap-1.5">
            {episodes.map((episode) =>
              isMissing(episode) ? (
                <li key={episode.id} className="rounded-md bg-field px-2.5 py-2 text-sm text-ink-muted">
                  Episodio borrado por <code className="text-ink-soft">forget</code>: queda el resumen, no el original.
                </li>
              ) : (
                <li key={episode.id} className="rounded-md bg-field px-2.5 py-2">
                  <p className="text-sm leading-relaxed text-ink-soft">{episode.text}</p>
                  <p className="mt-1 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-muted">
                    <span title={exact(episode.created_at)}>{ago(episode.created_at)}</span>
                    {episode.linked_here === false && <span>ahora consolidado en otra memoria</span>}
                  </p>
                </li>
              ),
            )}
          </ol>
        )}
      </section>

      <section className="mt-5">
        <SectionTitle>Rasgos que la citan</SectionTitle>
        {traits.length === 0 ? (
          <p className="text-sm text-ink-muted">Ningún rasgo la cita todavía.</p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {traits.map((trait) => (
              <li key={trait.id}>
                <button
                  type="button"
                  className="rounded-md text-left text-sm text-brand-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
                  onClick={() => onSelect({ layer: "trait", id: trait.id })}
                >
                  {trait.text}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <AlertDialog
        open={confirm !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirm(null);
            setActionError(undefined);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "forget" ? "Olvidar esta memoria" : "Deshacer la consolidación"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirm === "forget" ? forgetText(linked, traits.length) : unconsolidateText(linked)}
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
              variant={confirm === "forget" ? "destructive" : "default"}
              disabled={busy}
              onClick={(event) => {
                // La confirmación no se cierra sola: si la escritura falla, se lee el error aquí.
                event.preventDefault();
                void runAction(confirm ?? "forget");
              }}
            >
              {busy ? "Un momento…" : confirm === "forget" ? "Olvidar" : "Deshacer consolidación"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function unconsolidateText(linked: number): string {
  return linked === 0
    ? "La memoria desaparece; no tenía episodios atados."
    : `La memoria desaparece y ${linked === 1 ? "su episodio vuelve" : `sus ${linked} episodios vuelven`} a estar sin consolidar. La próxima consolidación ${linked === 1 ? "lo" : "los"} leerá de nuevo.`;
}

function forgetText(linked: number, traits: number): string {
  const base =
    linked === 0
      ? "Se borra la memoria."
      : `Se borran la memoria y ${linked === 1 ? "su episodio" : `sus ${linked} episodios`}.`;
  const citing =
    traits === 0
      ? ""
      : traits === 1
        ? " Un rasgo la cita y seguirá existiendo sin ella."
        : ` ${traits} rasgos la citan y seguirán existiendo sin ella.`;
  return `${base} No se puede deshacer.${citing}`;
}

function EditForm({
  gist,
  details,
  onSave,
  onCancel,
}: {
  gist: string;
  details: string | null;
  onSave: (gist: string, details: string | null) => Promise<void>;
  onCancel: () => void;
}) {
  const [draftGist, setDraftGist] = useState(gist);
  const [draftDetails, setDraftDetails] = useState(details ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onSave(draftGist, draftDetails.trim() || null);
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        <span>Lo que recuerda</span>
        <textarea
          className="min-h-20 w-full rounded-md border border-edge bg-field px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
          value={draftGist}
          onChange={(event) => setDraftGist(event.target.value)}
          rows={3}
          required
          autoFocus
        />
      </label>
      <label className="flex flex-col gap-1 text-xs text-ink-muted">
        <span>Detalles</span>
        <textarea
          className="min-h-28 w-full rounded-md border border-edge bg-field px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/60"
          value={draftDetails}
          onChange={(event) => setDraftDetails(event.target.value)}
          rows={6}
        />
      </label>
      {error && (
        <p role="alert" className="text-sm text-danger">
          No se pudo guardar: {error}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || !draftGist.trim()}>
          {busy ? "Guardando…" : "Guardar cambios"}
        </Button>
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

function TraitView({
  id,
  onSelect,
  onChanged,
}: {
  id: string;
  onSelect: (selection: Selection) => void;
  onChanged: (next?: Selection | null) => void;
}) {
  const query = useQuery({ queryKey: ["trait", id], queryFn: ({ signal }) => api.trait(id, signal) });
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const data = query.data;
  if (!data) {
    return query.isError ? <DetailFailure what="el rasgo" error={query.error} /> : <DetailLoading label="Cargando el rasgo…" />;
  }
  const { trait, evidence } = data;

  const forget = async () => {
    setBusy(true);
    setActionError(undefined);
    try {
      await actions.forgetTrait(trait.id);
      setConfirm(false);
      toast.success("Rasgo olvidado.");
      onChanged(null);
    } catch (err) {
      const message = errorMessage(err);
      setActionError(message);
      toast.error(`No se pudo: ${message}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <LiveTitle>{`Rasgo abierto: ${truncate(trait.text, 120)}`}</LiveTitle>
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
        <Button type="button" variant="outline" size="sm" className="text-danger" onClick={() => setConfirm(true)}>
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
            setActionError(undefined);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Olvidar este rasgo</AlertDialogTitle>
            <AlertDialogDescription>
              Se borra el rasgo. Las memorias que lo sostienen no se tocan. No se puede deshacer.
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
              disabled={busy}
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

function EpisodeView({ selection }: { selection: Selection }) {
  const episode = selection.episode;
  if (!episode) {
    return (
      <p className="text-sm text-ink-muted">
        Este episodio no trae su texto en la selección. Ábrelo desde «Sin consolidar» o desde los resultados.
      </p>
    );
  }
  return (
    <>
      <LiveTitle>{`Episodio abierto: ${truncate(episode.text, 120)}`}</LiveTitle>
      <p className="mb-1 text-[11px] uppercase tracking-wider text-ink-muted">Episodio sin consolidar</p>
      <p className="whitespace-pre-wrap text-sm leading-relaxed text-ink">{episode.text}</p>
      <dl className="mt-4 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        <dt className="text-ink-muted">Ámbito</dt>
        <dd className="text-ink-soft">{episode.scope}</dd>
        <dt className="text-ink-muted">Capturado</dt>
        <dd className="text-ink-soft" title={exact(episode.created_at)}>
          {ago(episode.created_at)}
        </dd>
      </dl>
      <p className="mt-4 text-sm text-ink-muted">La próxima consolidación lo leerá junto con el resto de su ámbito.</p>
    </>
  );
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const media = window.matchMedia(query);
    setMatches(media.matches);
    const onChange = (event: MediaQueryListEvent) => setMatches(event.matches);
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}
