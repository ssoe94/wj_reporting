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
import { Textarea } from "@/components/ui/textarea";
import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { ToastContainer } from "react-toastify";
import "react-toastify/dist/ReactToastify.css";

const navItems = [
  { id: "summary", label: "현황 요약" },
  { id: "records", label: "생산 기록" },
  { id: "new", label: "신규 등록" },
];

export default function App() {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <div className="min-h-screen font-sans text-gray-900">
      {/* Header */}
      <header className="sticky top-0 z-30 bg-white/80 backdrop-blur supports-[backdrop-filter]:bg-white/60 shadow-sm">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3 md:px-8">
          <div className="flex items-center gap-3">
            <img
              src="/logo.jpg"
              alt="로고"
              className="h-10 w-10 rounded-full object-cover shadow"
            />
            <span className="whitespace-nowrap text-lg font-bold tracking-tight text-blue-700 md:text-2xl">
              사출 생산관리 시스템
            </span>
          </div>
          <Button
            variant="ghost"
            className="md:hidden"
            onClick={() => setSidebarOpen(true)}
            size="icon"
            aria-label="메뉴 열기"
          >
            <MenuIcon className="h-6 w-6" />
          </Button>
        </div>
      </header>

      {/* Sidebar (Desktop) */}
      <aside className="fixed left-0 top-[72px] hidden h-[calc(100vh-72px)] w-56 flex-col gap-2 overflow-y-auto border-r bg-white py-8 px-4 shadow-md md:flex">
        {navItems.map((item) => (
          <a
            key={item.id}
            href={`#${item.id}`}
            className="rounded-lg px-3 py-2 font-medium text-gray-700 transition hover:bg-blue-50 hover:text-blue-600"
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
              onClick={() => setSidebarOpen(false)}
              aria-label="메뉴 닫기"
            >
              <XIcon className="h-6 w-6" />
            </Button>
            <nav className="mt-8 flex flex-col gap-4">
              {navItems.map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  onClick={() => setSidebarOpen(false)}
                  className="rounded-lg px-3 py-2 font-medium text-gray-700 transition hover:bg-blue-50 hover:text-blue-600"
                >
                  {item.label}
                </a>
              ))}
            </nav>
          </motion.aside>
        )}
      </AnimatePresence>

      {/* Main Content */}
      <main className="mx-auto flex max-w-7xl flex-col gap-10 px-4 py-10 md:ml-56 md:px-8">
        {/* Summary Section */}
        <section id="summary">
          <h2 className="sr-only">현황 요약</h2>
          <div className="grid grid-cols-1 gap-6 sm:grid-cols-3">
            <Card className="flex flex-col items-center">
              <CardHeader className="text-gray-500">총 생산 건수</CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-blue-700">12건</p>
              </CardContent>
            </Card>
            <Card className="flex flex-col items-center">
              <CardHeader className="text-gray-500">평균 달성률</CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-green-600">97.2%</p>
              </CardContent>
            </Card>
            <Card className="flex flex-col items-center">
              <CardHeader className="text-gray-500">평균 불량률</CardHeader>
              <CardContent>
                <p className="text-3xl font-bold text-red-500">2.1%</p>
              </CardContent>
            </Card>
          </div>
        </section>

        {/* Records Section */}
        <section id="records" className="w-full">
          <Card>
            <CardHeader className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
              <h2 className="text-xl font-bold text-blue-700">생산 기록</h2>
              <Button size="sm" className="gap-2">
                <DownloadCloud className="h-4 w-4" /> 엑셀 다운로드
              </Button>
            </CardHeader>
            <CardContent className="overflow-x-auto">
              <table className="min-w-full table-auto text-sm md:text-base">
                <thead>
                  <tr className="bg-blue-50 text-blue-900">
                    <th className="px-3 py-2 font-semibold">일자</th>
                    <th className="px-3 py-2 font-semibold">톤수</th>
                    <th className="px-3 py-2 font-semibold">모델명</th>
                    <th className="px-3 py-2 font-semibold">구분</th>
                    <th className="px-3 py-2 font-semibold text-right">계획</th>
                    <th className="px-3 py-2 font-semibold text-right">실적</th>
                    <th className="px-3 py-2 font-semibold text-right">달성률</th>
                    <th className="px-3 py-2 font-semibold text-right">불량수</th>
                    <th className="px-3 py-2 font-semibold text-right">불량률</th>
                    <th className="px-3 py-2 font-semibold text-right">가동률</th>
                    <th className="px-3 py-2 font-semibold">비고</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="hover:bg-blue-50 transition">
                    <td className="px-3 py-2">2024-06-18</td>
                    <td className="px-3 py-2">850T</td>
                    <td className="px-3 py-2">24TL510</td>
                    <td className="px-3 py-2">B/C</td>
                    <td className="px-3 py-2 text-right">1,400</td>
                    <td className="px-3 py-2 text-right">1,245</td>
                    <td className="px-3 py-2 text-right">89%</td>
                    <td className="px-3 py-2 text-right">90</td>
                    <td className="px-3 py-2 text-right">6.7%</td>
                    <td className="px-3 py-2 text-right">92.4%</td>
                    <td className="px-3 py-2 max-w-xs truncate">조정 60분, 금형교체 40분</td>
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>
        </section>

        {/* New Record Section */}
        <section id="new" className="w-full max-w-lg">
          <Card>
            <CardHeader>
              <h2 className="text-xl font-bold text-blue-700">신규 생산 기록 등록</h2>
            </CardHeader>
            <CardContent>
              <form className="space-y-6">
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <Label htmlFor="date">생산일자</Label>
                    <Input id="date" type="date" />
                  </div>
                  <div>
                    <Label htmlFor="ton">톤수</Label>
                    <Input id="ton" placeholder="예: 850T" />
                  </div>
                  <div>
                    <Label htmlFor="model">모델명</Label>
                    <Input id="model" placeholder="예: 24TL510" />
                  </div>
                  <div>
                    <Label htmlFor="type">구분</Label>
                    <select
                      id="type"
                      className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-blue-500"
                    >
                      <option value="">선택</option>
                      <option value="C/A">C/A</option>
                      <option value="B/C">B/C</option>
                      <option value="COVER">COVER</option>
                    </select>
                  </div>
                  <div>
                    <Label htmlFor="plan">계획수량</Label>
                    <Input id="plan" type="number" />
                  </div>
                  <div>
                    <Label htmlFor="actual">실제수량</Label>
                    <Input id="actual" type="number" />
                  </div>
                  <div>
                    <Label htmlFor="reported-defect">보고불량수</Label>
                    <Input id="reported-defect" type="number" />
                  </div>
                  <div>
                    <Label htmlFor="real-defect">실제불량수</Label>
                    <Input id="real-defect" type="number" />
                  </div>
                  <div>
                    <Label htmlFor="run-time">가동시간(분)</Label>
                    <Input id="run-time" type="number" />
                  </div>
                  <div>
                    <Label htmlFor="total-time">총시간(분)</Label>
                    <Input id="total-time" type="number" defaultValue={1440} />
                  </div>
                </div>
                <div>
                  <Label htmlFor="note">비고</Label>
                  <Textarea
                    id="note"
                    placeholder="조정시간, 금형교체 시간 등"
                    className="min-h-[80px]"
                  />
                </div>
                <div className="flex justify-end gap-4">
                  <Button size="sm" className="gap-2">
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

      {/* Toast Notification */}
      <ToastContainer position="bottom-right" />
    </div>
  );
}
