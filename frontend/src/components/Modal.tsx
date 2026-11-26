/**
 * Modal: the one dialog shell. Every overlay in the dashboard should render
 * through this instead of its own overlay/panel/header CSS.
 *
 * What it does for you:
 * - Portals to <body>, labels itself with the title (`aria-labelledby`) and
 *   sets `aria-modal`.
 * - Moves focus in on open (`initialFocusRef`, else the first field or
 *   button in the body, else the panel), traps Tab inside, and gives focus
 *   back to whatever had it on close.
 * - Escape closes only the topmost modal, and doesn't reach window-level
 *   Escape handlers underneath (a ConfirmDialog over a legacy panel closes
 *   just the dialog).
 * - A backdrop click closes only if the press started on the backdrop too
 *   (dragging a text selection out of a field doesn't close it).
 * - Locks body scroll while open, and becomes a full-screen sheet at ≤768px
 *   (`size="sm"` becomes a bottom sheet).
 *
 * Closing rules:
 * - `busy`: nothing closes it, and × is disabled (a request is in flight).
 * - `dismissible={false}`: the backdrop doesn't close it; Escape and × still
 *   call `onClose`, so the owner can ask "Discard changes?" there. Use it
 *   while a form is dirty or on a view that is shown only once.
 */
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

export interface ModalProps {
  open: boolean;
  title: ReactNode;
  /** Called on Escape, ×, and (when dismissible) a backdrop click. */
  onClose: () => void;
  /** Default true. False: the backdrop no longer closes it. */
  dismissible?: boolean;
  /** Default "md" (560px). "sm" is 440px, "lg" 760px. */
  size?: "sm" | "md" | "lg";
  /** Rendered in the footer bar, right-aligned. Omit for no footer. */
  footer?: ReactNode;
  /** Element to focus on open. Defaults to the first field or button. */
  initialFocusRef?: RefObject<HTMLElement>;
  children?: ReactNode;
  /** Small line under the title (caller alias, item name). */
  subtitle?: ReactNode;
  /** Icon shown before the title, in a tinted square. */
  icon?: ReactNode;
  iconTone?: "accent" | "danger";
  /** "alertdialog" for confirmations of destructive actions. */
  role?: "dialog" | "alertdialog";
  /** A request is in flight: nothing closes the modal and × is disabled. */
  busy?: boolean;
  /** Id of the element that describes the dialog (`aria-describedby`). */
  describedBy?: string;
  /** Force the stacked z-index (a dialog opened from inside another one).
   *  Set automatically when another Modal is already open. */
  nested?: boolean;
  /** Extra class on the panel. */
  className?: string;
  /** Extra class on the scrolling body. */
  bodyClassName?: string;
  /** Hide the × button (the footer has the only way out). */
  hideClose?: boolean;
}

// Open modals, oldest first. Only the last one handles Escape and Tab.
const stack: string[] = [];
let scrollLocks = 0;
let savedOverflow = "";

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), iframe, [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.getClientRects().length > 0 && !el.closest("[inert]"),
  );
}

export default function Modal(props: ModalProps) {
  if (!props.open) return null;
  return <OpenModal {...props} />;
}

function OpenModal({
  title,
  onClose,
  dismissible = true,
  size = "md",
  footer,
  initialFocusRef,
  children,
  subtitle,
  icon,
  iconTone = "accent",
  role = "dialog",
  busy = false,
  describedBy,
  nested,
  className,
  bodyClassName,
  hideClose = false,
}: ModalProps) {
  const id = useId();
  const titleId = `${id}-title`;
  const panelRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const downOnBackdrop = useRef(false);
  // Read the latest props from the document listener without re-binding it.
  const latest = useRef({ onClose, busy });
  latest.current = { onClose, busy };
  // Decided once, at open: was another modal already up?
  const depthRef = useRef<number | null>(null);
  if (depthRef.current === null) depthRef.current = stack.length;
  const isNested = nested ?? depthRef.current > 0;

  // Register on the stack, lock scroll, and restore focus on close.
  useLayoutEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    stack.push(id);
    if (scrollLocks++ === 0) {
      savedOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    return () => {
      const i = stack.lastIndexOf(id);
      if (i !== -1) stack.splice(i, 1);
      if (--scrollLocks === 0) document.body.style.overflow = savedOverflow;
      if (previouslyFocused && document.contains(previouslyFocused)) {
        previouslyFocused.focus({ preventScroll: true });
      }
    };
  }, [id]);

  // Initial focus.
  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const target =
      initialFocusRef?.current ??
      (bodyRef.current ? focusables(bodyRef.current)[0] : undefined) ??
      (footer ? focusables(panel).find((el) => !el.closest(".modal-header")) : undefined) ??
      panel;
    target.focus({ preventScroll: true });
    // Only on open: later prop changes must not steal focus back.
  }, []);

  // Escape and the Tab trap, for the topmost modal only. Bubble phase on
  // document: a field inside that handles Escape itself (and calls
  // preventDefault or stopPropagation) wins, and stopping here keeps the
  // key from window-level listeners of whatever is underneath.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== id) return;
      const panel = panelRef.current;
      if (!panel) return;
      if (e.key === "Escape") {
        if (e.defaultPrevented) return;
        e.preventDefault();
        e.stopPropagation();
        if (!latest.current.busy) latest.current.onClose();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables(panel);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      if (e.shiftKey && (active === first || !inside)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !inside)) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [id]);

  const overlayClass = [
    "modal-overlay",
    isNested ? "is-nested" : "",
    size === "sm" ? "is-sheet-sm" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const panelClass = ["modal-panel", `modal-${size}`, className ?? ""]
    .filter(Boolean)
    .join(" ");

  return createPortal(
    <div
      className={overlayClass}
      role="presentation"
      onMouseDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Keep clicks from reaching React ancestors of the component that
        // rendered the modal (a clickable table row, say).
        e.stopPropagation();
        const onBackdrop = downOnBackdrop.current && e.target === e.currentTarget;
        downOnBackdrop.current = false;
        if (onBackdrop && dismissible && !busy) onClose();
      }}
    >
      <div
        ref={panelRef}
        className={panelClass}
        role={role}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        aria-busy={busy || undefined}
        tabIndex={-1}
      >
        <div className="modal-header">
          <div className="modal-header-text">
            {icon && (
              <span
                className={`modal-icon${iconTone === "danger" ? " modal-icon-danger" : ""}`}
                aria-hidden="true"
              >
                {icon}
              </span>
            )}
            <div style={{ minWidth: 0 }}>
              <h2 id={titleId} className="modal-title">
                {title}
              </h2>
              {subtitle && <div className="modal-subtitle">{subtitle}</div>}
            </div>
          </div>
          {!hideClose && (
            <button
              type="button"
              className="modal-close"
              aria-label="Close"
              title="Close"
              disabled={busy}
              onClick={onClose}
            >
              <X size={18} aria-hidden="true" />
            </button>
          )}
        </div>
        <div ref={bodyRef} className={`modal-body${bodyClassName ? ` ${bodyClassName}` : ""}`}>
          {children}
        </div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
