import {
  createContext,
  useCallback,
  useContext,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { CheckCircle2, AlertCircle } from "lucide-react";

type ToastKind = "success" | "error";
interface ToastState {
  text: string;
  kind: ToastKind;
  visible: boolean;
}

interface ToastContextValue {
  notify: (text: string, kind?: ToastKind) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastState>({
    text: "",
    kind: "success",
    visible: false,
  });

  // Таймер предыдущего тоста сбрасываем: иначе он скрыл бы новый раньше срока.
  const hideTimer = useRef<number | undefined>(undefined);
  const notify = useCallback((text: string, kind: ToastKind = "success") => {
    setToast({ text, kind, visible: true });
    window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(
      () => setToast((t) => ({ ...t, visible: false })),
      2600
    );
  }, []);

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div
        className={`fixed bottom-20 right-4 z-50 flex md:bottom-6 md:right-6 items-center gap-3 rounded-ui border-2 border-ink px-5 py-3 text-sm font-semibold text-white shadow-lg ${
          toast.kind === "error" ? "bg-rose-600" : "bg-accent"
        } ${
          toast.visible
            ? "translate-y-0 opacity-100"
            : "pointer-events-none translate-y-20 opacity-0"
        }`}
      >
        {toast.kind === "error" ? (
          <AlertCircle className="h-4 w-4" strokeWidth={2.25} />
        ) : (
          <CheckCircle2 className="h-4 w-4" strokeWidth={2.25} />
        )}
        <span>{toast.text}</span>
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast должен использоваться внутри ToastProvider");
  return ctx;
}
