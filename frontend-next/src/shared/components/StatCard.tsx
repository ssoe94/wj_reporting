type StatCardProps = {
  title: string;
  value: string;
  hint: string;
  hintTone?: "positive" | "negative" | "neutral";
};

export function StatCard({ title, value, hint, hintTone }: StatCardProps) {
  return (
    <article className="stat-card">
      <p className="stat-card__title">{title}</p>
      <strong className="stat-card__value">{value}</strong>
      <p className={["stat-card__hint", hintTone ? `stat-card__hint--${hintTone}` : ""].filter(Boolean).join(" ")}>
        {hint}
      </p>
    </article>
  );
}
