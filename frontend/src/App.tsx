import api from "@/lib/api";
import {
  Menu as MenuIcon,
  X as XIcon,
  DownloadCloud,
  PlusCircle,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";
import { toast } from "react-toastify";
import RecordsTable from "@/components/RecordsTable";
import { useQueryClient } from "@tanstack/react-query";
import { Autocomplete, TextField } from "@mui/material";
import { usePartSpecSearch, usePartListByModel } from "@/hooks/usePartSpecs";
import type { PartSpec } from "@/hooks/usePartSpecs";
import React from "react";
import { useReportSummary } from "@/hooks/useReports";

const navItems = [
  { id: "summary", label: "현황 요약" },
  { id: "records", label: "생산 기록" },
  { id: "new", label: "신규 등록" },
];

// 컴포넌트 최상단에 추가
const formatTime = (mins: number) => {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h}시간 ${m}분 (${mins}분)`;
};

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const queryClient = useQueryClient();
  const [productQuery, setProductQuery] = useState("");
  const { data: searchResults = [] } = usePartSpecSearch(productQuery.toUpperCase());
  const uniqueModelDesc = React.useMemo(() => {
    const map = new Map<string, PartSpec>();
    searchResults.forEach((it) => {
      const key = `${it.model_code}|${it.description}`;
      if (!map.has(key)) map.set(key, it);
    });
    return Array.from(map.values());
  }, [searchResults]);

  const [selectedModelDesc, setSelectedModelDesc] = useState<PartSpec | null>(null);
  const { data: modelParts = [] } = usePartListByModel(selectedModelDesc?.model_code);

  const partNoOptions = React.useMemo(() => {
    if (!selectedModelDesc) return [] as PartSpec[];
    const keyDesc = selectedModelDesc.description.trim().toLowerCase();
    const seen = new Set<string>();
    return modelParts.filter((it: PartSpec) => {
      if (it.description.trim().toLowerCase() !== keyDesc) return false;
      if (seen.has(it.part_no)) return false;
      seen.add(it.part_no);
      return true;
    });
  }, [selectedModelDesc, modelParts]);

  const [selectedPartSpec, setSelectedPartSpec] = useState<PartSpec | null>(null);

  /* ---------------- 신규 등록 폼 상태 ---------------- */
  const today = new Date().toISOString().slice(0, 10);
  const machines = [
    { id: 1, ton: 850 },
    { id: 2, ton: 850 },
    { id: 3, ton: 1300 },
    { id: 4, ton: 1400 },
    { id: 5, ton: 1400 },
    { id: 6, ton: 2500 },
    { id: 7, ton: 1300 },
    { id: 8, ton: 850 },
    { id: 9, ton: 850 },
    { id: 10, ton: 650 },
    { id: 11, ton: 550 },
    { id: 12, ton: 550 },
    { id: 13, ton: 450 },
    { id: 14, ton: 850 },
    { id: 15, ton: 650 },
    { id: 16, ton: 1050 },
    { id: 17, ton: 1200 },
  ];

  const roundTo5 = (d: Date) => {
    d.setSeconds(0, 0);
    d.setMinutes(Math.floor(d.getMinutes() / 5) * 5);
    return d;
  };
  // datetime-local 문자열로 변환 (로컬 시각 그대로)
  const toLocalInput = (d: Date) => {
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000); // 오프셋 보정
    return local.toISOString().slice(0, 16); // yyyy-MM-ddTHH:mm
  };
  // 브라우저 로컬 시간을 5분 단위로 절삭하여 기본값 생성
  const nowStr = toLocalInput(roundTo5(new Date()));

  const [form, setForm] = useState({
    date: today,
    machineId: "",
    model: "",
    type: "",
    partNo: "",
    plan: "",
    actual: "",
    reportedDefect: "",
    realDefect: "",
    resin: "",
    netG: "",
    srG: "",
    ct: "",
    start: nowStr,
    end: nowStr,
    idle: "",
    note: "",
  });

  const handleChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => setForm({ ...form, [e.target.id]: e.target.value });

  const diffMinutes = () => {
    if (!form.start || !form.end) return 0;
    const startDate = new Date(form.start);
    const endDate = new Date(form.end);
    const diffMs = endDate.getTime() - startDate.getTime();
    return diffMs > 0 ? Math.floor(diffMs / 60000) : 0;
  };

  const totalMinutes = diffMinutes();
  const runMinutes = totalMinutes && form.idle ? totalMinutes - Number(form.idle) : 0;

  const handleSubmit = async (ev: React.FormEvent) => {
    ev.preventDefault();
    // ---------------- 필수 입력 검증 ----------------
    const requiredErrors: string[] = [];
    if (!form.machineId) requiredErrors.push('사출기를 선택하세요');
    if (!form.model.trim()) requiredErrors.push('모델명을 입력하세요');
    if (!form.type) requiredErrors.push('구분을 선택하세요');
    if (!form.plan) requiredErrors.push('계획수량을 입력하세요');
    if (!form.actual) requiredErrors.push('실제수량을 입력하세요');
    if (!form.start || !form.end) requiredErrors.push('시작·종료 시간을 입력하세요');

    if (requiredErrors.length) {
      toast.error(requiredErrors[0]);
      return;
    }

    try {
      // machineId -> tonnage string
      const machine = machines.find((m) => String(m.id) === form.machineId);
      const payload = {
        date: form.date,
        machine_no: machine ? machine.id : 0,
        tonnage: machine ? `${machine.ton}` : "",
        model: form.model,
        section: form.type,
        plan_qty: Number(form.plan || 0),
        actual_qty: Number(form.actual || 0),
        reported_defect: Number(form.reportedDefect || 0),
        actual_defect: Number(form.realDefect || 0),
        start_datetime: form.start,
        end_datetime: form.end,
        total_time: totalMinutes,
        operation_time: runMinutes,
        part_no: form.partNo,
        note: form.note,
      };
      await api.post("/reports/", payload);
      queryClient.invalidateQueries({ queryKey: ["reports"] });
      queryClient.invalidateQueries({ queryKey: ["reports-summary"] });
      toast.success("저장되었습니다");
      setForm({ ...form, model: "", type: "", plan: "", actual: "", reportedDefect: "", realDefect: "", start: "", end: "", idle: "", note: "" });
    } catch (err: any) {
      console.error(err);
      if (err.response?.status === 400 && err.response.data) {
        // DRF ValidationError 형식 {field: [msg]}
        const firstMsg = Object.values(err.response.data)[0] as any;
        toast.error(Array.isArray(firstMsg) ? firstMsg[0] : String(firstMsg));
      } else {
        toast.error("저장 중 오류가 발생했습니다");
      }
    }
  };

  const downloadCsv = async () => {
    try {
      const { data } = await api.get("/reports/export/", { responseType: "blob" });
      const url = URL.createObjectURL(data);
      const a = document.createElement("a");
      a.href = url;
      a.download = "reports.csv";
      a.click();
    } catch (err) {
      console.error(err);
      toast.error("CSV 다운로드 실패");
    }
  };

  // compute derived values
  const totalPieces = Number(form.actual || 0) + Number((form.realDefect || form.reportedDefect) || 0);

  // 런타임(분) → 초 로 변환
  const runSeconds = runMinutes * 60

  // 모든 사출된 개수 기준 C/T
  const shotCt = totalPieces > 0
    ? runSeconds / totalPieces
    : 0

  // 양품(실제) 기준 C/T
  const goodCt = Number(form.actual) > 0
    ? runSeconds / Number(form.actual)
    : 0

  // 전체 요약 데이터
  const { data: summary } = useReportSummary();

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 shadow-xs">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 md:px-8">
          <div className="flex items-center gap-3">
            <img src="/logo.jpg" alt="로고" className="h-10 w-10 rounded-full shadow-sm" />
            <span className="whitespace-nowrap text-lg font-bold text-blue-700 md:text-2xl">
              사출 생산관리 시스템
            </span>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={() => setSidebarOpen(true)}
            aria-label="메뉴 열기"
          >
            <MenuIcon className="h-6 w-6" />
          </Button>
        </div>
      </header>

      {/* Sidebar (Desktop) */}
      <aside className="fixed left-0 top-[72px] hidden h-[calc(100vh-72px)] w-56 overflow-y-auto border-r bg-white py-8 px-4 shadow-md md:flex flex-col gap-2">
        {navItems.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            className="px-3 py-2 rounded-lg font-medium text-gray-700 hover:bg-blue-50 hover:text-blue-600 transition"
          >
            {item.label}
          </a>
        ))}
      </aside>

      {/* Sidebar (Mobile) */}
      <AnimatePresence>
        {sidebarOpen && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-40 bg-black/40"
            onClick={() => setSidebarOpen(false)}
          />
        )}
        {sidebarOpen && (
          <motion.aside
            initial={{ x: -260 }}
            animate={{ x: 0 }}
            exit={{ x: -260 }}
            transition={{ type: "spring", stiffness: 300, damping: 30 }}
            className="fixed left-0 top-0 z-50 h-full w-64 bg-white p-8 shadow-lg"
          >
            <Button
              variant="ghost"
              size="icon"
              className="absolute right-4 top-4"
              aria-label="메뉴 닫기"
              onClick={() => setSidebarOpen(false)}
            >
              <XIcon className="h-6 w-6" />
            </Button>
            <nav className="mt-8 flex flex-col gap-4">
              {navItems.map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  onClick={() => setSidebarOpen(false)}
                  className="px-3 py-2 rounded-lg font-medium text-gray-700 hover:bg-blue-50 hover:text-blue-600 transition"
                >
                  {item.label}
                </a>
              ))}
            </nav>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main className="mx-auto max-w-7xl px-4 py-10 md:ml-56 md:px-8 flex flex-col gap-10">
        {/* Summary Section */}
        <section id="summary">
          <h2 className="sr-only">현황 요약</h2>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
            <Card className="flex flex-col items-center">
              <CardHeader className="text-gray-500">총 생산 건수</CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-blue-700">
                  {summary ? `${summary.total_count}건` : '...'}
                </p>
              </CardContent>
            </Card>
            <Card className="flex flex-col items-center">
              <CardHeader className="text-gray-500">평균 달성률</CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-green-600">
                  {summary ? `${summary.achievement_rate}%` : '...'}
                </p>
              </CardContent>
            </Card>
            <Card className="flex flex-col items-center">
              <CardHeader className="text-gray-500">평균 불량률</CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-red-500">
                  {summary ? `${summary.defect_rate}%` : '...'}
                </p>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Records Section */}
        <section id="records" className="w-full space-y-4">
          <div className="flex justify-end items-center gap-3">
            {/* CSV 업로드 */}
            <input
              id="csvFile"
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const fd = new FormData();
                fd.append("file", file);
                try {
                  const { data } = await api.post("/reports/bulk-import/", fd, {
                    headers: { "Content-Type": "multipart/form-data" },
                  });
                  toast.success(`생성 ${data.created}건 / 중복 ${data.skipped}건 / 오류 ${data.errors}건`);
                  queryClient.invalidateQueries({ queryKey: ["reports"] });
                  queryClient.invalidateQueries({ queryKey: ["reports-summary"] });
                } catch (err) {
                  console.error(err);
                  toast.error("CSV 업로드 실패");
                } finally {
                  e.target.value = ""; // reset
                }
              }}
            />
            <Button size="sm" variant="ghost" onClick={() => document.getElementById("csvFile")?.click()}>
              CSV 업로드
            </Button>
            {/* CSV 다운로드 */}
            <Button size="sm" className="gap-2" onClick={downloadCsv}>
              <DownloadCloud className="h-4 w-4" /> CSV 저장
            </Button>
          </div>
          <RecordsTable />
        </section>

        {/* New Record Section */}
        <section id="new" className="w-full">
          <Card>
            <CardHeader>
              <h2 className="text-xl font-bold text-blue-700">신규 생산 기록 등록</h2>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="flex flex-col gap-y-6">
                
                {/* ── (1) 상단: 보고일자 / 사출기 / 모델 검색 / Part No. ── */}
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
                  {/* 보고일자 */}
                  <div>
                    <Label htmlFor="date">보고일자</Label>
                    <Input
                      id="date"
                      type="date"
                      value={form.date}
                      onChange={handleChange}
                      className="text-center"
                    />
                  </div>
                  {/* 사출기 */}
                  <div>
                    <Label htmlFor="machineId">사출기</Label>
                    <select
                      id="machineId"
                      value={form.machineId}
                      onChange={handleChange}
                      className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-700 focus:border-blue-500 focus:ring-blue-500 text-center"
                    >
                      <option value="">선택</option>
                      {machines.map((m) => (
                        <option key={m.id} value={m.id}>
                          {`${m.id}호기 - ${m.ton}T`}
                        </option>
                      ))}
                    </select>
                  </div>
                  {/* 모델 검색 */}
                  <div>
                    <Label>모델 검색</Label>
                    <Autocomplete<PartSpec>
                      options={uniqueModelDesc}
                      getOptionLabel={(opt) => `${opt.model_code} – ${opt.description}`}
                      onInputChange={(_, v) => setProductQuery(v)}
                      onChange={(_, v) => {
                        setSelectedModelDesc(v);
                        if (v) {
                          setForm(f => ({
                            ...f,
                            model: v.model_code,
                            type: v.description,
                            partNo: "",
                            resin: "",
                            netG: "",
                            srG: "",
                            ct: "",
                          }));
                          setSelectedPartSpec(null);
                        }
                      }}
                      renderInput={(params) => (
                        <TextField {...params} size="small" placeholder="모델명 또는 PART 검색" />
                      )}
                    />
                  </div>
                  {/* Part No. (항상 표시) */}
                  <div>
                    <Label>Part No.</Label>
                    <Autocomplete<PartSpec>
                      options={partNoOptions}
                      getOptionLabel={(opt) => opt.part_no}
                      onChange={(_, v) => {
                        setSelectedPartSpec(v);
                        if (v) {
                          setForm(f => ({
                            ...f,
                            partNo: v.part_no,
                            model: v.model_code,
                            type: v.description,
                            resin: v.resin_type || "",
                            netG: v.net_weight_g?.toString() || "",
                            srG: v.sr_weight_g?.toString() || "",
                            ct: v.cycle_time_sec?.toString() || "",
                          }));
                        }
                      }}
                      renderInput={(params) => (
                        <TextField {...params} size="small" placeholder="Part No. 선택" />
                      )}
                    />
                  </div>
                </div>

                {/* ── (2) Part Spec 선택 시 요약 카드 ── */}
                {selectedPartSpec && (
                  <Card className="bg-slate-50">
                    <CardHeader className="text-blue-700 font-semibold text-lg">
                      {form.model} / {form.partNo}
                    </CardHeader>
                    <CardContent className="grid grid-cols-2 gap-x-10 text-base">
                      {/* Left Column */}
                      <div className="grid grid-cols-[120px_1fr] gap-y-2">
                        <span className="text-gray-500">Resin</span>
                        <span className="font-medium font-mono">{form.resin || "-"}</span>
                        <span className="text-gray-500">Color</span>
                        <span className="font-medium font-mono">{selectedPartSpec.color || "-"}</span>
                        <span className="text-gray-500">기준 C/T(초)</span>
                        <span className="font-medium font-mono">{form.ct}</span>
                      </div>
                      {/* Right Column */}
                      <div className="grid grid-cols-[120px_1fr] gap-y-2">
                        <span className="text-gray-500">Net Wt (g)</span>
                        <span className="font-medium font-mono">{form.netG}</span>
                        <span className="text-gray-500">S/R Wt (g)</span>
                        <span className="font-medium font-mono">{form.srG}</span>
                        <span className="text-gray-500">기준 불량률</span>
                        <span className="font-medium font-mono">
                          {selectedPartSpec.defect_rate_pct != null
                            ? `${(selectedPartSpec.defect_rate_pct * 100).toFixed(1)}%`
                            : "-"}
                        </span>
                      </div>
                    </CardContent>
                  </Card>
                )}

                {/* ── (3) 2-컬럼 그리드: 생산 시간 / 생산 보고 ── */}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-4 items-stretch">
                  
                  {/* 생산 시간 */}
                  {/* ── 생산 시간 카드 ── */}
                  <Card className="h-full flex flex-col">
                    <CardHeader className="font-semibold text-blue-700">생산 시간</CardHeader>
                    <CardContent className="flex-1 space-y-4">
                      {/* 1행: 시작/종료 */}
                      <div className="grid grid-cols-2 gap-4">
                        <div className="flex flex-col">
                          <Label htmlFor="start">시작일시</Label>
                          <Input
                            id="start"
                            type="datetime-local"
                            step={300}
                            value={form.start}
                            onChange={handleChange}
                            className="text-center"
                          />
                        </div>
                        <div className="flex flex-col">
                          <Label htmlFor="end">종료일시</Label>
                          <Input
                            id="end"
                            type="datetime-local"
                            step={300}
                            value={form.end}
                            onChange={handleChange}
                            className="text-center"
                          />
                        </div>
                      </div>

                      {/* 2행: 총시간 / 부동시간 */}
                      <div className="grid grid-cols-2 gap-4">
                        {/* 총시간 */}
                        <div className="flex flex-col">
                          <Label>총시간</Label>
                          <Input
                            value={formatTime(totalMinutes)}
                            disabled
                            className="text-center"
                          />
                        </div>
                        {/* 부동시간 */}
                        <div className="flex flex-col">
                          <Label htmlFor="idle">부동시간(분)</Label>
                          <Input
                            id="idle"
                            type="number"
                            value={form.idle}
                            onChange={handleChange}
                            className="text-center"
                          />
                        </div>
                      </div>

                      {/* 3행: 부동시간 비고 */}
                      <div className="flex flex-col">
                        <Label htmlFor="note">부동시간 비고</Label>
                        <Input
                          id="note"
                          type="text"
                          value={form.note}
                          onChange={handleChange}
                        />
                      </div>

                      {/* (기존 두 개의 grid row 아래에 추가) */}
                      {/* ── 마지막 행: 가동시간 (full-width) ── */}
                      <div className="grid grid-cols-2 gap-4">
                        <div className="col-span-2 flex flex-col">
                          <Label>가동시간</Label>
                          <Input
                            value={formatTime(runMinutes)}
                            disabled
                            className="text-center"
                          />
                        </div>
                      </div>
                    </CardContent>
                  </Card>


                  {/* 생산 보고 */}
                  <Card className="h-full flex flex-col">
                    <CardHeader className="font-semibold text-blue-700">생산 보고</CardHeader>
                    <CardContent className="flex-1 grid grid-cols-2 gap-4">
                      <div>
                        <Label htmlFor="plan">계획수량*</Label>
                        <Input
                          id="plan"
                          type="number"
                          value={form.plan}
                          onChange={handleChange}
                          required
                          className="text-center"
                        />
                      </div>
                      <div>
                        <Label htmlFor="actual">양품수량*</Label>
                        <Input
                          id="actual"
                          type="number"
                          value={form.actual}
                          onChange={handleChange}
                          required
                          className="text-center"
                        />
                      </div>
                      <div>
                        <Label htmlFor="reportedDefect">불량수량(보고)*</Label>
                        <Input
                          id="reportedDefect"
                          type="number"
                          value={form.reportedDefect}
                          onChange={handleChange}
                          required
                          className="text-center"
                        />
                      </div>
                      <div>
                        <Label htmlFor="realDefect">불량수량(실제)</Label>
                        <Input
                          id="realDefect"
                          type="number"
                          value={form.realDefect}
                          onChange={handleChange}
                          className="text-center"
                        />
                      </div>

                      {/* summary */}
                      <div className="col-span-2 border-t pt-2 text-sm text-gray-500">
                        <div className="flex justify-between">
                          <span>총 사출수량</span>
                          <span className="font-medium">{totalPieces}</span>
                        </div>
                        <div className="flex justify-between">
                          <span>사출기 C/T(초)</span>
                          <span className="font-medium">
                            {shotCt.toFixed(1)}초
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span>양품기준 C/T(초)</span>
                          <span className="font-medium">
                            {goodCt.toFixed(1)}초
                          </span>
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>

                {/* ── (4) 저장/초기화 버튼 ── */}
                <div className="flex justify-end gap-4 mt-4">
                  <Button type="submit" size="sm" className="gap-2">
                    <PlusCircle className="h-4 w-4" /> 저장하기
                  </Button>
                  <Button type="reset" variant="ghost" size="sm">
                    초기화
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>
        </section>
      </main>

      <ToastContainer position="bottom-right" />
    </div>
  );
}
