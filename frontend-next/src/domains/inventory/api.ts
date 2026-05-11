import { http } from "@/shared/api/http";

export async function getInventoryLastUpdate() {
  const response = await http.get("/inventory/last-update/");
  return response.data;
}

export async function getWarehouses() {
  const response = await http.get("/inventory/warehouses/");
  return response.data;
}
