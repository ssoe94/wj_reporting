import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';
import { useState } from 'react';

function App() {
  // 예시: 사이드바 메뉴 상태
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <Router>
      <div className="min-h-screen bg-gray-50 font-sans">
        {/* 헤더 */}
        <header className="bg-white shadow sticky top-0 z-20">
          <div className="max-w-7xl mx-auto flex justify-between items-center py-3 px-4 md:px-8">
            <div className="flex items-center gap-3">
              <img src="/logo.jpg" alt="로고" className="h-10 w-10 rounded-full object-cover shadow" />
              <span className="text-xl md:text-2xl font-bold text-blue-700 tracking-tight">사출 생산관리 시스템</span>
            </div>
            <button className="md:hidden btn btn-ghost" onClick={() => setSidebarOpen(!sidebarOpen)}>
              <span className="material-icons">menu</span>
            </button>
          </div>
        </header>

        {/* 사이드바 (PC) */}
        <aside className="hidden md:block fixed top-16 left-0 h-full w-56 bg-white shadow-lg z-10">
          <nav className="flex flex-col gap-2 p-6">
            <a href="#summary" className="text-gray-700 hover:text-blue-600 font-medium transition">현황 요약</a>
            <a href="#records" className="text-gray-700 hover:text-blue-600 font-medium transition">생산 기록</a>
            <a href="#new" className="text-gray-700 hover:text-blue-600 font-medium transition">신규 등록</a>
          </nav>
        </aside>

        {/* 사이드바 (모바일) */}
        {sidebarOpen && (
          <div className="fixed inset-0 bg-black bg-opacity-30 z-30" onClick={() => setSidebarOpen(false)}>
            <aside className="fixed top-0 left-0 h-full w-56 bg-white shadow-lg z-40 p-6 flex flex-col gap-2">
              <a href="#summary" className="text-gray-700 hover:text-blue-600 font-medium transition" onClick={() => setSidebarOpen(false)}>현황 요약</a>
              <a href="#records" className="text-gray-700 hover:text-blue-600 font-medium transition" onClick={() => setSidebarOpen(false)}>생산 기록</a>
              <a href="#new" className="text-gray-700 hover:text-blue-600 font-medium transition" onClick={() => setSidebarOpen(false)}>신규 등록</a>
            </aside>
          </div>
        )}

        {/* 메인 컨텐츠 */}
        <main className="md:ml-56 max-w-7xl mx-auto py-8 px-4">
          {/* 현황 요약 카드 */}
          <section id="summary" className="mb-10">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="bg-white rounded-xl shadow p-6 flex flex-col items-center">
                <span className="text-gray-500">총 생산 건수</span>
                <span className="text-3xl font-bold text-blue-700 mt-2">12건</span>
              </div>
              <div className="bg-white rounded-xl shadow p-6 flex flex-col items-center">
                <span className="text-gray-500">평균 달성률</span>
                <span className="text-3xl font-bold text-green-600 mt-2">97.2%</span>
              </div>
              <div className="bg-white rounded-xl shadow p-6 flex flex-col items-center">
                <span className="text-gray-500">평균 불량률</span>
                <span className="text-3xl font-bold text-red-500 mt-2">2.1%</span>
              </div>
            </div>
          </section>

          {/* 생산 기록 테이블 */}
          <section id="records" className="mb-10">
            <div className="bg-white rounded-xl shadow p-6">
              <div className="flex justify-between items-center mb-4">
                <h2 className="text-xl font-bold text-blue-700">생산 기록</h2>
                <button className="btn btn-primary btn-sm">엑셀 다운로드</button>
              </div>
              <div className="overflow-x-auto">
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
                    {/* 예시 데이터 */}
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
                    {/* ... */}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          {/* 신규 등록 패널 */}
          <section id="new" className="mb-10">
            <div className="bg-white rounded-xl shadow p-6 max-w-lg mx-auto">
              <h2 className="text-xl font-bold text-blue-700 mb-4">신규 생산 기록 등록</h2>
              <form className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-gray-700 font-medium mb-1">생산일자</label>
                    <input type="date" className="input input-bordered w-full" />
                  </div>
                  <div>
                    <label className="block text-gray-700 font-medium mb-1">톤수</label>
                    <input type="text" placeholder="예: 850T" className="input input-bordered w-full" />
                  </div>
                  <div>
                    <label className="block text-gray-700 font-medium mb-1">모델명</label>
                    <input type="text" placeholder="예: 24TL510" className="input input-bordered w-full" />
                  </div>
                  <div>
                    <label className="block text-gray-700 font-medium mb-1">구분</label>
                    <select className="select select-bordered w-full">
                      <option value="">선택</option>
                      <option value="C/A">C/A</option>
                      <option value="B/C">B/C</option>
                      <option value="COVER">COVER</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-gray-700 font-medium mb-1">계획수량</label>
                    <input type="number" className="input input-bordered w-full" />
                  </div>
                  <div>
                    <label className="block text-gray-700 font-medium mb-1">실제수량</label>
                    <input type="number" className="input input-bordered w-full" />
                  </div>
                  <div>
                    <label className="block text-gray-700 font-medium mb-1">보고불량수</label>
                    <input type="number" className="input input-bordered w-full" />
                  </div>
                  <div>
                    <label className="block text-gray-700 font-medium mb-1">실제불량수</label>
                    <input type="number" className="input input-bordered w-full" />
                  </div>
                  <div>
                    <label className="block text-gray-700 font-medium mb-1">가동시간(분)</label>
                    <input type="number" className="input input-bordered w-full" />
                  </div>
                  <div>
                    <label className="block text-gray-700 font-medium mb-1">총시간(분)</label>
                    <input type="number" className="input input-bordered w-full" defaultValue={1440} />
                  </div>
                </div>
                <div>
                  <label className="block text-gray-700 font-medium mb-1">비고</label>
                  <textarea className="textarea textarea-bordered w-full min-h-[60px]" placeholder="조정시간, 금형교체 시간 등"></textarea>
                </div>
                <div className="flex gap-4 justify-end pt-2">
                  <button type="submit" className="btn btn-primary px-6 py-2 rounded-lg shadow font-semibold">저장하기</button>
                  <button type="reset" className="btn btn-ghost px-6 py-2 rounded-lg font-semibold">초기화</button>
                </div>
              </form>
            </div>
          </section>
        </main>

        {/* 토스트 알림 */}
        <ToastContainer position="bottom-right" />
      </div>
    </Router>
  );
}

export default App;
