import { LOGO_MARK } from "../lib/appIcon";

/**
 * Логотип Mestia: знак на плитке цвета акцента — перекрашивается вместе с темой
 * (та же плитка уходит в иконку окна и трея, см. lib/appIcon.ts).
 */
export default function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`mestia-logo flex items-center gap-2.5 no-select ${compact ? "px-0" : "px-2"}`}>
      <span className="relative flex h-8 w-8 items-center justify-center overflow-hidden rounded-[9px] bg-accent text-white shadow-sm">
        <svg
          viewBox="0 0 256 256"
          className="mestia-logo-arrow h-[26px] w-[26px]"
          aria-hidden="true"
          dangerouslySetInnerHTML={{ __html: LOGO_MARK }}
        />
      </span>
      {!compact && <span className="bg-gradient-to-r from-ink to-accent bg-clip-text text-lg font-bold tracking-tight text-transparent">
        Mestia
      </span>}
    </div>
  );
}
