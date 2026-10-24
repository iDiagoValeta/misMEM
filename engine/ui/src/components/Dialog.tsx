import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";

interface Props {
  title: string;
  /** El texto del botón: dice lo que pasa al pulsarlo ("Olvidar", no "Aceptar"). */
  action: string;
  danger?: boolean;
  children: ReactNode;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

/**
 * Confirmación modal con <dialog>: el navegador ya da el foco atrapado, Escape para cerrar
 * y la vuelta del foco al botón que lo abrió.
 */
export function Dialog({ title, action, danger, children, onConfirm, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    ref.current?.showModal();
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      await onConfirm();
      ref.current?.close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setBusy(false);
    }
  };

  return (
    <dialog ref={ref} className="dialog" onClose={onClose} aria-labelledby="dialog-title">
      <form onSubmit={submit}>
        <h2 id="dialog-title">{title}</h2>
        <div className="dialog-body">{children}</div>
        {error && (
          <p className="error" role="alert">
            No se pudo: {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" className="button" onClick={() => ref.current?.close()}>
            Cancelar
          </button>
          <button type="submit" className={danger ? "button danger" : "button primary"} disabled={busy}>
            {busy ? "Un momento…" : action}
          </button>
        </div>
      </form>
    </dialog>
  );
}
