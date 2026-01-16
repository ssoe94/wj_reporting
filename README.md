# WJ Reporting System

## 1. Project Overview
**WJ Reporting System** is a production data reporting system for manufacturing environments. It tracks injection molding records, assembly data, inventory snapshots, and quality monitoring.

### Key Features
- ✅ Injection Molding Records Management
- ✅ Assembly Data Tracking
- ✅ Inventory Snapshots
- ✅ Quality Monitoring
- ✅ Real-time Dashboard
- ✅ Role-based Access Control (RBAC)

## 2. Technology Stack

### Frontend
- **Framework**: React 18, TypeScript, Vite
- **Styling**: TailwindCSS
- **HTTP Client**: Axios
- **State Management**: React Context / Hooks

### Backend
- **Framework**: Django 5.2, Django REST Framework (DRF)
- **Database**: PostgreSQL
- **Authentication**: JWT (JSON Web Tokens)
- **Media Storage**: Cloudinary

### Infrastructure
- **Hosting**: Render
- **CI/CD**: GitHub Actions

## 3. Project Structure
```
production-site/
├── frontend/           # React + Vite Frontend
├── backend/            # Django REST API
├── scripts/            # Deployment & Verification Scripts
├── tests/              # E2E Tests
└── .github/            # GitHub Actions Workflows
```

## 4. Setup & Development Guide

### Prerequisites
- Node.js (v18+)
- Python (v3.10+)
- PostgreSQL

### Frontend Setup
```bash
cd frontend
npm install
npm run dev
```
- **Environment Variables** (`frontend/.env.production`):
  - `VITE_API_BASE_URL=/api`

### Backend Setup
```bash
cd backend
python -m venv venv
# Windows
venv\Scripts\activate
# Mac/Linux
source venv/bin/activate

pip install -r requirements.txt
python manage.py migrate
python manage.py runserver
```
- **Environment Variables** (`backend/.env`):
  - `SECRET_KEY`: Your secret key
  - `DEBUG`: True/False
  - `DATABASE_URL`: PostgreSQL connection string
  - `CLOUDINARY_*`: Cloudinary credentials

## 5. Deployment Guide (Render)

### Automation
This project is configured for **automated deployment** on Render.
- **Migrations**: Automatically applied via `startCommand`.
- **User Setup**: Existing users and groups are automatically configured via migrations and signals.

### Deployment Process
1. **Push to Main**: `git push origin main` triggers the CI/CD pipeline.
2. **CI/CD**: GitHub Actions runs tests.
3. **Deploy**: If tests pass, Render automatically deploys the backend and frontend.

### Verification
After deployment, run the smoke test:
```bash
bash scripts/quick-smoke-test.sh
```

## 6. Troubleshooting

### Common Issues
- **Unexpected token '<'**: Usually caused by incorrect proxy settings or 404s returning `index.html`. Check `render.yaml` rewrites.
- **CORS Errors**: Check `CORS_ALLOWED_ORIGINS` in Django settings and ensure the frontend domain is listed.
- **404 returning HTML**: Ensure `APINotFoundMiddleware` is active in Django.
- **Environment Variables**: Frontend variables must start with `VITE_` and are baked in at build time.
- **VPN/Network**: If you cannot connect to localhost, try temporarily disabling your VPN or checking firewall settings.

### Debugging Tools
- **Browser DevTools**: Network tab for API requests.
- **Django Logs**: Check Render dashboard logs.
- **Verification Scripts**: `node scripts/verify-deployment.js`

## 7. Cloudinary Setup
Images are stored in Cloudinary.
- **Backend**: Generates signed URLs for secure uploads.
- **Frontend**: Uploads directly to Cloudinary using the signature.
- **Credentials**: Managed via environment variables (`CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`).

## 8. Security
- **HTTPS**: Enforced in production.
- **Secrets**: Managed via environment variables. Never commit `.env` files.
- **DEBUG**: Must be `False` in production.
- **Access Control**: JWT for API, RBAC for feature access.

## 9. Features & Functionality

### Core Modules
- **Injection**: Manage injection molding production records and machine data.
- **Assembly**: Track assembly line production and performance.
- **Quality**: Report defects, upload images (Cloudinary), and monitor quality metrics.
- **Inventory**: View stock levels and manage inventory snapshots.
- **ECO (Engineering Change Order)**: Manage and track engineering changes.
- **Sales**: Track sales performance and orders.
- **Analysis**: Visual data analysis and reporting tools.
- **Admin**: User management, role-based access control (RBAC), and system configuration.

### System Features
- **Authentication**: Secure login/signup with JWT.
- **Dashboard**: Real-time overview of key metrics.
- **Responsive Design**: Optimized for desktop and tablet use.

## 10. Git Status & Deployment Info
*(As of 2026-01-06)*

- **Current Branch**: `main`
- **Status**: Up to date with `origin/main`.
- **Recent Updates**:
  - Password reset functionality fixes.
  - Deployment speed improvements.
  - Cloudinary integration for quality reports.
- **Deployed Version**: Matches `origin/main`.