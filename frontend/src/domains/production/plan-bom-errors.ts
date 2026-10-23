// Only translate known service codes; provider text can contain sensitive data.
const messages: Record<string, [string, string]> = {
  mes_bom_not_found: ["이 품번의 MES BOM이 없습니다. BOM 등록을 확인하세요.", "该物料没有MES BOM，请确认BOM是否已建。"],
  mes_bom_list_incomplete: ["MES BOM 목록이 완전하지 않습니다. 다시 조회하세요.", "MES BOM列表不完整，请重新查询。"],
  mes_bom_default_ambiguous: ["사용할 기본 BOM이 하나로 정해져 있지 않습니다. MES 기본 버전을 확인하세요.", "无法确定唯一默认BOM，请确认MES默认版本。"],
  mes_bom_process_mismatch: ["BOM 공정이 이 계획의 사출·가공 구분과 다릅니다. 공정을 확인하세요.", "BOM工序与计划的注塑／加工类型不符，请核对工序。"],
  mes_bom_complex_control: ["BOM은 조회됐지만 투입 관리 설정을 확인해야 합니다.", "已读取BOM，但需要核对投料管理设置。"],
  mes_bom_complex_input: ["BOM은 조회됐지만 대체재·손실률·분할 투입 설정을 확인해야 합니다.", "已读取BOM，但需要核对替代料、损耗率或分批投料设置。"],
  mes_bom_multiple_processes: ["여러 공정이 있는 BOM입니다. 공정별 투입 연결을 확인해야 합니다.", "该BOM包含多个工序，需要核对各工序用料连接。"],
  mes_bom_material_disabled: ["BOM에 사용 중지된 물료가 있습니다. MES 물료 상태를 확인하세요.", "BOM包含停用物料，请核对MES物料状态。"],
  mes_bom_material_unit: ["BOM과 물료의 단위가 일치하지 않습니다. MES 단위를 확인하세요.", "BOM与物料单位不一致，请核对MES单位。"],
  mes_bom_detail_changed: ["조회 중 BOM 버전이 바뀌었습니다. 다시 조회하세요.", "查询期间BOM版本发生变化，请重新查询。"],
  permission_required: ["MES BOM 조회 권한이 없습니다. 앱 권한을 확인하세요.", "没有MES BOM查询权限，请核对应用权限。"],
  field_permission_required: ["MES BOM 일부 필드의 조회 권한이 없습니다.", "没有MES BOM部分字段的查询权限。"],
  service_app_unavailable: ["MES 앱 인증을 사용할 수 없습니다. 연결 상태를 확인하세요.", "MES应用认证不可用，请检查连接。"],
  app_authentication_rejected: ["MES 앱 인증이 거절됐습니다. 연결 상태를 확인하세요.", "MES应用认证被拒绝，请检查连接。"],
};

export function planBomErrorMessage(error: unknown, zh: boolean): string {
  const response = (error as { response?: { status?: number; data?: unknown } } | null)?.response;
  const data = response?.data;
  const detail = Array.isArray(data) && data.length === 1 ? data[0]
    : data && typeof data === "object" && "detail" in data ? data.detail : undefined;
  if (typeof detail === "string" && Object.hasOwn(messages, detail)) return messages[detail][zh ? 1 : 0];
  if (response?.status === 401) return zh ? "WJ登录已过期，请重新登录后查询BOM。" : "WJ 로그인이 만료됐습니다. 다시 로그인한 뒤 BOM을 조회하세요.";
  if (response?.status === 403) return zh ? "没有该计划的查询权限。" : "이 계획을 조회할 권한이 없습니다.";
  if (response?.status === 400) return zh ? "已收到BOM响应，但结构或设置尚不支持。请核对BOM配置。" : "BOM 응답의 구성 또는 설정을 처리할 수 없습니다. BOM 설정을 확인해야 합니다.";
  return zh ? "BOM查询暂时失败。草稿已保留，请重新查询。" : "BOM 조회에 실패했습니다. 초안은 보존됐으며 다시 조회할 수 있습니다.";
}
