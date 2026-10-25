import { useEffect } from "react";
import { motion, useReducedMotion, useSpring, useTransform } from "framer-motion";

/**
 * Число, которое «доезжает» до нового значения пружиной (42 → 43 → … без скачков).
 * Цифры моноширинные — ширина не дёргается. С reduced-motion просто подменяется.
 */
export default function AnimatedNumber({ value, suffix = "%" }: { value: number; suffix?: string }) {
  const reduce = useReducedMotion();
  const spring = useSpring(value, { stiffness: 140, damping: 26, restDelta: 0.1 });
  const text = useTransform(spring, (v) => `${Math.round(v)}${suffix}`);

  useEffect(() => {
    if (reduce) spring.jump(value);
    else spring.set(value);
  }, [value, reduce, spring]);

  return <motion.span className="tabular-nums">{text}</motion.span>;
}
