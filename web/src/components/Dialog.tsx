import { useEffect, useId, useRef, type ReactNode } from 'react';

export interface DialogProps {
  title: string;
  children?: ReactNode;
  /** Cancelar, Escape o clic fuera del diálogo. */
  onClose(): void;
  /** Con `onConfirm`, el diálogo muestra el botón de confirmar con este texto. */
  confirmLabel?: string;
  onConfirm?(): void;
  /** Acción destructiva: el botón de confirmar va en rojo. */
  danger?: boolean;
  /** Mientras se hace la acción: botones deshabilitados y no se puede cerrar. */
  busy?: boolean;
  /** Error de la acción, junto a los botones. */
  error?: string | null;
  /** Deshabilita solo el botón de confirmar (por ejemplo, mientras no se elige un destino). */
  confirmDisabled?: boolean;
}

/**
 * Diálogo modal propio (no `window.confirm`), con el `<dialog>` nativo: `showModal()` atrapa el foco,
 * deja inerte el resto de la página y cierra con Escape. El que lo usa lo monta para abrirlo y lo
 * desmonta en `onClose` para cerrarlo.
 */
export function Dialog({ title, children, onClose, confirmLabel = 'Aceptar', onConfirm, danger, busy, error, confirmDisabled }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const mounted = useRef(false);
  const titleId = useId();

  useEffect(() => {
    const d = ref.current;
    mounted.current = true;
    if (d && !d.open) d.showModal();
    return () => {
      mounted.current = false;
      if (d?.open) d.close();
    };
  }, []);

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby={titleId}
      onCancel={(e) => {
        // Escape: lo cierra el que monta el diálogo (o no, si está ocupado)
        e.preventDefault();
        close();
      }}
      onClose={() => {
        // Cerrado por el navegador sin pasar por `onCancel`: avisar para desmontarlo. El evento llega
        // después del `close()`; si para entonces el diálogo ya se volvió a abrir (el efecto corre dos
        // veces en StrictMode) o se desmontó, no es un cierre de verdad.
        if (mounted.current && !ref.current?.open) onClose();
      }}
      onClick={(e) => {
        // Clic en el fondo (fuera del contenido)
        if (e.target === e.currentTarget) close();
      }}
    >
      <form
        className="dialog-body"
        onSubmit={(e) => {
          e.preventDefault();
          if (onConfirm && !busy && !confirmDisabled) onConfirm();
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <div className="dialog-content">{children}</div>
        {error && (
          <p role="alert" className="error small">
            {error}
          </p>
        )}
        <div className="dialog-actions">
          <button type="button" onClick={close} disabled={busy}>
            {onConfirm ? 'Cancelar' : 'Cerrar'}
          </button>
          {onConfirm && (
            <button type="submit" className={danger ? 'primary danger' : 'primary'} disabled={busy || confirmDisabled} aria-busy={busy || undefined}>
              {confirmLabel}
            </button>
          )}
        </div>
      </form>
    </dialog>
  );
}
