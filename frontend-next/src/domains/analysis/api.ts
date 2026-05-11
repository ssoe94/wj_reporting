import { http } from "@/shared/api/http";

export async function getInjectionSummary(date?: string) {
  const query = date ? `?date=${encodeURIComponent(date)}` : "";
  const response = await http.get(`/injection/reports/summary/${query}`);
  return response.data;
}
