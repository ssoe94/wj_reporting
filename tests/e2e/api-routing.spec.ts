/**
 * E2E Tests for API Routing and Error Handling
 * 
 * Run with: npx playwright test tests/e2e/api-routing.spec.ts
 */
import { test, expect } from '@playwright/test';

const FRONTEND_URL = process.env.FRONTEND_URL || 'https://wj-reporting.onrender.com';
const TEST_DATE = '2025-10-14';

test.describe('API Routing and JSON Response', () => {
  
  test('should return JSON for health check endpoint', async ({ page }) => {
    // Intercept API request
    const responsePromise = page.waitForResponse(
      response => response.url().includes('/api/health/')
    );
    
    // Navigate to trigger health check (or make direct request)
    await page.goto(FRONTEND_URL);
    
    // Make API call
    const response = await page.request.get(`${FRONTEND_URL}/api/health/`);
    
    // Verify response
    expect(response.status()).toBe(200);
    
    const contentType = response.headers()['content-type'];
    expect(contentType).toContain('application/json');
    
    // Verify it's valid JSON
    const body = await response.text();
    expect(() => JSON.parse(body)).not.toThrow();
    
    // Should not contain HTML
    expect(body).not.toContain('<html');
    expect(body).not.toContain('<!DOCTYPE');
  });
  
  test('should display data correctly (not undefined)', async ({ page }) => {
    // Setup: Login first (adjust based on your auth flow)
    await page.goto(`${FRONTEND_URL}/login`);
    
    // TODO: Add your login logic here
    // await page.fill('[name="username"]', 'testuser');
    // await page.fill('[name="password"]', 'testpass');
    // await page.click('button[type="submit"]');
    
    // Navigate to dashboard
    await page.goto(`${FRONTEND_URL}/dashboard`);
    
    // Wait for data to load
    await page.waitForLoadState('networkidle');
    
    // Check that data cards show numbers, not "undefined"
    const dataCards = page.locator('[data-testid="data-card"]');
    const count = await dataCards.count();
    
    if (count > 0) {
      for (let i = 0; i < count; i++) {
        const text = await dataCards.nth(i).textContent();
        
        // Should not contain "undefined"
        expect(text?.toLowerCase()).not.toContain('undefined');
        
        // Should not contain "NaN"
        expect(text?.toLowerCase()).not.toContain('nan');
      }
    }
  });
  
  test('should handle 401 unauthorized with proper redirect', async ({ page }) => {
    // Clear any existing auth
    await page.context().clearCookies();
    
    // Try to access protected route
    const response = await page.request.get(
      `${FRONTEND_URL}/api/injection/reports/summary/?date=${TEST_DATE}`
    );
    
    // Should return 401
    expect(response.status()).toBe(401);
    
    // Should be JSON, not HTML
    const contentType = response.headers()['content-type'];
    expect(contentType).toContain('application/json');
    
    const body = await response.text();
    expect(body).not.toContain('<html');
    
    // Parse JSON response
    const json = await response.json();
    expect(json).toHaveProperty('detail');
  });
  
  test('should return JSON 404 for non-existent API endpoints', async ({ page }) => {
    const response = await page.request.get(
      `${FRONTEND_URL}/api/_nonexistent_endpoint_test`
    );
    
    // Should return 404
    expect(response.status()).toBe(404);
    
    // Should be JSON, not HTML
    const contentType = response.headers()['content-type'];
    expect(contentType).toContain('application/json');
    
    const body = await response.text();
    
    // Should not be HTML
    expect(body).not.toContain('<html');
    expect(body).not.toContain('<!DOCTYPE');
    
    // Should be valid JSON
    const json = await response.json();
    expect(json).toHaveProperty('detail');
    expect(json.detail).toContain('Not found');
  });
  
  test('should show user-friendly error message on API failure', async ({ page }) => {
    // Setup console listener
    const consoleErrors: string[] = [];
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrors.push(msg.text());
      }
    });
    
    // Mock API failure
    await page.route('**/api/injection/reports/summary/*', route => {
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'Internal server error' }),
      });
    });
    
    await page.goto(`${FRONTEND_URL}/dashboard`);
    
    // Wait for error handling
    await page.waitForTimeout(2000);
    
    // Check for error toast or message (adjust selector based on your UI)
    const errorMessage = page.locator('[role="alert"], .error-toast, .error-message');
    
    if (await errorMessage.count() > 0) {
      const text = await errorMessage.first().textContent();
      
      // Should show user-friendly message
      expect(text).toBeTruthy();
      expect(text?.length).toBeGreaterThan(0);
    }
    
    // Console should log detailed error info
    const hasAPIError = consoleErrors.some(err => 
      err.includes('[API Error]') || err.includes('500')
    );
    expect(hasAPIError).toBe(true);
  });
  
  test('should send cookies with API requests (withCredentials)', async ({ page }) => {
    // Set a test cookie
    await page.context().addCookies([{
      name: 'test_session',
      value: 'test_value',
      domain: new URL(FRONTEND_URL).hostname,
      path: '/',
    }]);
    
    // Intercept API request
    let requestHeaders: Record<string, string> = {};
    
    await page.route('**/api/health/', route => {
      requestHeaders = route.request().headers();
      route.continue();
    });
    
    // Make API call
    await page.request.get(`${FRONTEND_URL}/api/health/`);
    
    // Verify Cookie header is sent
    expect(requestHeaders['cookie']).toBeTruthy();
    expect(requestHeaders['cookie']).toContain('test_session');
  });
  
  test('should have proper cache headers for API responses', async ({ page }) => {
    const response = await page.request.get(
      `${FRONTEND_URL}/api/injection/reports/summary/?date=${TEST_DATE}`
    );
    
    const cacheControl = response.headers()['cache-control'];
    
    // API responses should not be cached
    expect(cacheControl).toBeTruthy();
    expect(cacheControl.toLowerCase()).toContain('no-store');
  });
});

test.describe('Proxy Configuration', () => {
  
  test('should proxy /api/* to backend', async ({ page }) => {
    const response = await page.request.get(`${FRONTEND_URL}/api/health/`);
    
    // Should get response from backend
    expect(response.status()).toBe(200);
    
    // Check if it's actually from backend (not frontend static)
    const contentType = response.headers()['content-type'];
    expect(contentType).toContain('application/json');
  });
  
  test('should serve index.html for non-API routes (SPA)', async ({ page }) => {
    // Request a non-existent frontend route
    const response = await page.goto(`${FRONTEND_URL}/some-spa-route`);
    
    // Should return 200 (not 404) because of SPA rewrite
    expect(response?.status()).toBe(200);
    
    // Should be HTML
    const contentType = response?.headers()['content-type'];
    expect(contentType).toContain('text/html');
    
    // Should contain app root element
    const body = await page.content();
    expect(body).toContain('<div id="root"');
  });
});
