import React from 'react';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

import RecordsPage from './pages/records';
import NewRecordPage from './pages/records/new';
import SummaryPage from './pages/summary';

function App() {
  return (
    <Router>
      <div className="min-h-screen bg-gray-100">
        {/* 네비게이션 바 */}
        <nav className="bg-white shadow-lg">
          <div className="container mx-auto px-4">
            <div className="flex justify-between h-16">
              <div className="flex">
                <Link to="/" className="flex items-center px-4 text-gray-700 hover:text-gray-900">
                  생산관리 시스템
                </Link>
              </div>
              <div className="flex space-x-4">
                <Link to="/records" className="flex items-center px-4 text-gray-700 hover:text-gray-900">
                  생산 기록
                </Link>
                <Link to="/records/new" className="flex items-center px-4 text-gray-700 hover:text-gray-900">
                  기록 추가
                </Link>
                <Link to="/summary" className="flex items-center px-4 text-gray-700 hover:text-gray-900">
                  일일 현황
                </Link>
              </div>
            </div>
          </div>
        </nav>

        {/* 메인 컨텐츠 */}
        <main className="py-4">
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
