/** Always include the edited row, even when its original Part No. was empty. */
export function buildCavityEditPartNos(
  originalPartNo: string,
  editedPartNo: string,
  groupPartNos: string[],
): string[] {
  const original = originalPartNo.trim().toUpperCase();
  const edited = editedPartNo.trim().toUpperCase();
  if (!edited) return [];
  const partners = groupPartNos
    .map((partNo) => partNo.trim().toUpperCase())
    .filter((partNo) => partNo && partNo !== original);
  return [...new Set([edited, ...partners])];
}
