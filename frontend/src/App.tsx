// import React from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

import RecordsPage from './pages/records';
import NewRecordPage from './pages/records/new';
import SummaryPage from './pages/summary';

function App() {
  return (
    <Router>
      <div className="min-h-screen bg-gray-50 font-sans">
        {/* 헤더 */}
        <header className="bg-white shadow sticky top-0 z-20">
          <div className="max-w-7xl mx-auto flex justify-between items-center py-3 px-4 md:px-8">
            <Link to="/" className="flex items-center gap-3">
              <img src="/logo.jpg" alt="로고" className="h-10 w-10 rounded-full object-cover shadow" />
              <span className="text-xl md:text-2xl font-bold text-blue-700 tracking-tight">사출 생산관리 시스템</span>
            </Link>
            <nav className="flex gap-4 md:gap-8">
              <Link to="/records" className="text-gray-700 hover:text-blue-600 font-medium transition">생산 기록</Link>
              <Link to="/records/new" className="text-gray-700 hover:text-blue-600 font-medium transition">기록 추가</Link>
              <Link to="/summary" className="text-gray-700 hover:text-blue-600 font-medium transition">일일 현황</Link>
            </nav>
          </div>
        </header>

        {/* 메인 컨텐츠 */}
        <main className="flex justify-center items-start min-h-[calc(100vh-80px)] py-8 px-2 md:px-0">
          <div className="w-full max-w-5xl">
            <Routes>
              <Route path="/" element={<RecordsPage />} />
              <Route path="/records" element={<RecordsPage />} />
              <Route path="/records/new" element={<NewRecordPage />} />
              <Route path="/summary" element={<SummaryPage />} />
            </Routes>
          </div>
        </main>

        {/* 토스트 알림 */}
        <ToastContainer position="bottom-right" />
      </div>
    </Router>
  );
}

export default App;
