export interface AssemblyReport {
  id?: number;
  date: string;
  line_no: string;
  part_no: string;
  model: string;
  supply_type?: 'JIT' | 'CSK' | 'SVC' | 'REWORK' | 'INSPECTION' | '';
  plan_qty: number;
  actual_qty: number;
  rework_qty?: number;
  injection_defect: number;
  outsourcing_defect: number;
  processing_defect: number;
  incoming_defects_detail?: Record<string, number>;
  processing_defects_detail?: Record<string, number>;
  processing_defects_dynamic?: Array<{defect_type: string; quantity: number}>;
  outsourcing_defects_dynamic?: Array<{defect_type: string; quantity: number}>;
  operation_time: number;
  total_time: number;
  idle_time: number;
  workers: number;
  note: string;
  start_datetime?: string;
  end_datetime?: string;
  // 계산된 필드들
  incoming_defect_qty?: number;
  total_defect_qty?: number;
  achievement_rate?: number;
  defect_rate?: number;
  total_production_qty?: number;
  uptime_rate?: number;
  uph?: number;
  upph?: number;
  actual_operation_time?: number;
  created_at?: string;
  updated_at?: string;
}

export interface AssemblyReportFilters {
  date?: string;
  line_no?: string;
  model?: string;
  part_no?: string;
  page?: number;
  search?: string;
}

export interface AssemblyReportSummary {
  total_count: number;
  total_plan_qty: number;
  total_actual_qty: number;
  total_injection_defect: number;
  total_outsourcing_defect: number;
  total_incoming_defect: number;
  total_processing_defect: number;
  total_defect_qty: number;
  achievement_rate: number;
  defect_rate: number;
}

export interface AssemblyPartSpec {
  id?: number;
  part_no: string;
  model_code: string;
  description: string;
  process_type?: string;
  material_type?: string;
  standard_cycle_time?: number;
  standard_worker_count?: number;
  valid_from: string;
  created_at?: string;
}

export interface AssemblyProduct {
  id?: number;
  model: string;
  part_no: string;
  process_line?: string;
}