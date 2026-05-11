type StatCardProps = {
  title: string;
  value: string;
  hint: string;
};

export function StatCard({ title, value, hint }: StatCardProps) {
  return (
    <article className="stat-card">
      <p className="stat-card__title">{title}</p>
      <strong className="stat-card__value">{value}</strong>
      <p className="stat-card__hint">{hint}</p>
    </article>
  );
}
