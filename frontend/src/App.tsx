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
        <header className="bg-white shadow-md sticky top-0 z-10">
          <div className="container mx-auto flex justify-between items-center py-4 px-6">
            <Link to="/" className="text-2xl font-bold text-blue-700 tracking-tight">사출 생산관리 시스템</Link>
            <nav className="flex gap-6">
              <Link to="/records" className="text-gray-700 hover:text-blue-600 font-medium transition">생산 기록</Link>
              <Link to="/records/new" className="text-gray-700 hover:text-blue-600 font-medium transition">기록 추가</Link>
              <Link to="/summary" className="text-gray-700 hover:text-blue-600 font-medium transition">일일 현황</Link>
            </nav>
          </div>
        </header>

        {/* 메인 컨텐츠 */}
        <main className="py-8 px-2 md:px-0">
          <Routes>
            <Route path="/" element={<RecordsPage />} />
            <Route path="/records" element={<RecordsPage />} />
            <Route path="/records/new" element={<NewRecordPage />} />
            <Route path="/summary" element={<SummaryPage />} />
          </Routes>
        </main>

        {/* 토스트 알림 */}
        <ToastContainer position="bottom-right" />
      </div>
    </Router>
  );
}

export default App;
