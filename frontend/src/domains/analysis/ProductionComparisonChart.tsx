import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

export default function ProductionComparisonChart({ rows, lang }: {
  rows: { name: string; plan: number | null; actual: number | null }[];
  lang: string;
}) {
  const format = (value: number) => new Intl.NumberFormat(lang === "zh" ? "zh-CN" : "ko-KR", { maximumFractionDigits: 0 }).format(value);
  return <ResponsiveContainer width="100%" height={235}><BarChart data={rows} margin={{ top: 18, right: 8, left: 8, bottom: 4 }}>
    <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#e8edf5" /><XAxis dataKey="name" tickLine={false} axisLine={false} />
    <YAxis tickFormatter={format} tickLine={false} axisLine={false} width={70} />
    <Tooltip formatter={(value: number) => `${format(value)} ea`} /><Legend />
    <Bar dataKey="plan" name={lang === "zh" ? "计划" : "계획"} fill="#a6b8d2" maxBarSize={72} radius={[5, 5, 0, 0]} isAnimationActive={false} />
    <Bar dataKey="actual" name={lang === "zh" ? "观测实绩" : "관측 실적"} fill="#3771df" maxBarSize={72} radius={[5, 5, 0, 0]} isAnimationActive={false} />
  </BarChart></ResponsiveContainer>;
}
