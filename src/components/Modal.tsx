import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";

interface ModalProps {
  /** Открыта ли модалка. Переход в false анимирует выход и сохраняет содержимое до конца. */
  open: boolean;
  /** Закрытие по клику на фон и по Esc. Если не передан — модалка не закрывается этими путями. */
  onClose?: () => void;
  children: ReactNode;
  /** Максимальная ширина карточки в px (по умолчанию 400). Игнорируется при cardClassName. */
  maxWidth?: number;
  /** z-index слоя (по умолчанию 50) — для вложенных модалок поверх других. */
  z?: number;
  /** Переопределить стиль карточки целиком (для нестандартных размеров/скролла). */
  cardClassName?: string;
}

/**
 * Единая модалка приложения: рендерится порталом в body (вне любых transform-предков,
 * которые иначе увели бы `fixed` в низ прокрученной страницы), центрируется по вьюпорту,
 * закрывается по клику на фон и по Esc. AnimatePresence сохраняет содержимое на время
 * анимации выхода, поэтому вызывающий код может сразу обнулять своё состояние.
 */
export default function Modal({ open, onClose, children, maxWidth = 400, z = 50, cardClassName }: ModalProps) {
  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="mestia-anim fixed inset-0 flex items-center justify-center bg-black/60 p-8 backdrop-blur-sm"
          style={{ zIndex: z }}
          onClick={() => onClose?.()}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className={
              cardClassName ??
              "mestia-anim w-full space-y-5 rounded-ui border-2 border-ink bg-snow p-6"
            }
            style={cardClassName ? undefined : { maxWidth }}
            onClick={(e) => e.stopPropagation()}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
