type StatCardProps = {
  title: string;
  value: string;
  hint: string;
  hintTone?: "positive" | "negative" | "neutral";
  isActive?: boolean;
  onClick?: () => void;
};

export function StatCard({ title, value, hint, hintTone, isActive, onClick }: StatCardProps) {
  const className = [
    "stat-card",
    onClick ? "stat-card--button" : "",
    isActive ? "stat-card--active" : "",
  ].filter(Boolean).join(" ");
  const content = (
    <>
      <p className="stat-card__title">{title}</p>
      <strong className="stat-card__value">{value}</strong>
      <p className={["stat-card__hint", hintTone ? `stat-card__hint--${hintTone}` : ""].filter(Boolean).join(" ")}>
        {hint}
      </p>
    </>
  );

  if (onClick) {
    return (
      <button
        aria-pressed={Boolean(isActive)}
        className={className}
        onClick={onClick}
        type="button"
      >
        {content}
      </button>
    );
  }

  return (
    <article className={className}>
      {content}
    </article>
  );
}
