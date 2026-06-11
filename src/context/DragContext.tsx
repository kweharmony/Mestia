import { createContext, useContext, useState, type ReactNode } from "react";
import type { VideoRow } from "../types";

/**
 * Глобальное состояние Drag-and-Drop.
 * Храним перетаскиваемое видео в контексте (а не только в dataTransfer),
 * чтобы цели сброса могли реагировать на тип объекта во время наведения.
 */
interface DragContextValue {
  dragging: VideoRow | null;
  startDrag: (v: VideoRow) => void;
  endDrag: () => void;
}

const DragContext = createContext<DragContextValue | null>(null);

export function DragProvider({ children }: { children: ReactNode }) {
  const [dragging, setDragging] = useState<VideoRow | null>(null);

  return (
    <DragContext.Provider
      value={{
        dragging,
        startDrag: (v) => setDragging(v),
        endDrag: () => setDragging(null),
      }}
    >
      {children}
    </DragContext.Provider>
  );
}

export function useDrag(): DragContextValue {
  const ctx = useContext(DragContext);
  if (!ctx) throw new Error("useDrag должен использоваться внутри DragProvider");
  return ctx;
}
