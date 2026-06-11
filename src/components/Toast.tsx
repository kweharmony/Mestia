import {
  createContext,
  useCallback,
  useContext,
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

  const notify = useCallback((text: string, kind: ToastKind = "success") => {
    setToast({ text, kind, visible: true });
    window.setTimeout(
      () => setToast((t) => ({ ...t, visible: false })),
      2600
    );
  }, []);

  return (
    <ToastContext.Provider value={{ notify }}>
      {children}
      <div
        className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 rounded-ui border-2 border-ink px-5 py-3 text-sm font-semibold text-white shadow-lg ${
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
