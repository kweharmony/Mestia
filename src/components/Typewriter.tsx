import { useEffect, useState } from "react";

/**
 * Эффект «печатающейся машинки»: циклично печатает и стирает фразы.
 */
export default function Typewriter({
  phrases,
  className,
}: {
  phrases: string[];
  className?: string;
}) {
  const [i, setI] = useState(0);
  const [text, setText] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const full = phrases[i % phrases.length] ?? "";
    let delay = deleting ? 35 : 65;
    if (!deleting && text === full) delay = 1700; // пауза на полной фразе
    if (deleting && text === "") delay = 350; // пауза перед новой фразой

    const t = window.setTimeout(() => {
      if (!deleting && text === full) {
        setDeleting(true);
      } else if (deleting && text === "") {
        setDeleting(false);
        setI((v) => (v + 1) % phrases.length);
      } else {
        setText(full.slice(0, deleting ? text.length - 1 : text.length + 1));
      }
    }, delay);

    return () => window.clearTimeout(t);
  }, [text, deleting, i, phrases]);

  return (
    <span className={className}>
      {text}
      <span className="mestia-caret">|</span>
    </span>
  );
}
