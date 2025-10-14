#!/usr/bin/env node
/**
 * 배포 후 API 엔드포인트 검증 스크립트 (Node.js)
 * Usage: node scripts/verify-deployment.js
 */

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://wj-reporting.onrender.com';
const BACKEND_URL = process.env.BACKEND_URL || 'https://wj-reporting-backend.onrender.com';
const TEST_DATE = '2025-10-14';

// 색상 코드
const colors = {
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  reset: '\x1b[0m',
};

async function testEndpoint(url, expectedStatus, testName) {
  process.stdout.write(`Testing: ${testName} ... `);
  
  try {
    const response = await fetch(url);
    const contentType = response.headers.get('content-type') || '';
    const status = response.status;
    
    // 상태 코드 검증
    if (status !== expectedStatus) {
      console.log(`${colors.red}FAIL${colors.reset}`);
      console.log(`  Expected status: ${expectedStatus}, Got: ${status}`);
      console.log(`  URL: ${url}`);
      return false;
    }
    
    // Content-Type 검증
    if (!contentType.includes('application/json')) {
      console.log(`${colors.red}FAIL${colors.reset}`);
      console.log(`  Expected JSON, Got: ${contentType}`);
      console.log(`  URL: ${url}`);
      const text = await response.text();
      console.log(`  Body preview: ${text.substring(0, 200)}`);
      return false;
    }
    
    // 응답 본문 검증
    const text = await response.text();
    
    // HTML 태그 감지
    if (text.includes('<html') || text.includes('<!DOCTYPE')) {
      console.log(`${colors.red}FAIL${colors.reset}`);
      console.log(`  Received HTML instead of JSON!`);
      console.log(`  URL: ${url}`);
      console.log(`  Body preview: ${text.substring(0, 200)}`);
      return false;
    }
    
    // JSON 파싱 검증
    try {
      JSON.parse(text);
    } catch (e) {
      console.log(`${colors.red}FAIL${colors.reset}`);
      console.log(`  Invalid JSON response`);
      console.log(`  URL: ${url}`);
      console.log(`  Parse error: ${e.message}`);
      return false;
    }
    
    console.log(`${colors.green}PASS${colors.reset}`);
    console.log(`  Status: ${status}, Content-Type: ${contentType}`);
    return true;
    
  } catch (error) {
    console.log(`${colors.red}ERROR${colors.reset}`);
    console.log(`  ${error.message}`);
    console.log(`  URL: ${url}`);
    return false;
  }
}

async function main() {
  console.log('=========================================');
  console.log('API Deployment Verification');
  console.log('=========================================');
  console.log(`Frontend: ${FRONTEND_URL}`);
  console.log(`Backend:  ${BACKEND_URL}`);
  console.log('');
  
  const results = [];
  
  // Backend Direct Tests
  console.log('=========================================');
  console.log('Backend Direct Tests');
  console.log('=========================================');
  
  results.push(await testEndpoint(
    `${BACKEND_URL}/api/health/`,
    200,
    'Health Check (Backend)'
  ));
  
  console.log('');
  console.log('=========================================');
  console.log('Frontend Proxy Tests');
  console.log('=========================================');
  
  results.push(await testEndpoint(
    `${FRONTEND_URL}/api/health/`,
    200,
    'Health Check (via Proxy)'
  ));
  
  results.push(await testEndpoint(
    `${FRONTEND_URL}/api/injection/reports/summary/?date=${TEST_DATE}`,
    200,
    'Reports Summary (via Proxy)'
  ));
  
  console.log('');
  console.log('=========================================');
  console.log('404 JSON Guard Tests');
  console.log('=========================================');
  
  results.push(await testEndpoint(
    `${FRONTEND_URL}/api/this-should-not-exist`,
    404,
    'Non-existent API endpoint'
  ));
  
  results.push(await testEndpoint(
    `${BACKEND_URL}/api/invalid-path-test`,
    404,
    'Backend 404 JSON response'
  ));
  
  console.log('');
  console.log('=========================================');
  console.log('Summary');
  console.log('=========================================');
  
  const passed = results.filter(r => r).length;
  const total = results.length;
  
  console.log(`Tests passed: ${passed}/${total}`);
  
  if (passed === total) {
    console.log(`${colors.green}All tests passed!${colors.reset}`);
    process.exit(0);
  } else {
    console.log(`${colors.red}Some tests failed!${colors.reset}`);
    console.log('');
    console.log('Troubleshooting steps:');
    console.log('1. Check render.yaml proxy configuration');
    console.log('2. Verify static.json routes (if used)');
    console.log('3. Check CORS settings in Django');
    console.log('4. Review Render deployment logs');
    process.exit(1);
  }
}

main();
