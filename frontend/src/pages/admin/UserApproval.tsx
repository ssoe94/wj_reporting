import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { api } from '../../lib/api';
import { Shield, ExternalLink, RefreshCcw, User, Users } from 'lucide-react';

interface SignupRequest {
  id: number;
  full_name: string;
  department: string;
  email: string;
  reason?: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}

interface UserProfile {
  id: number;
  username: string;
  email: string;
  first_name: string;
  can_edit_injection: boolean;
  can_edit_assembly: boolean;
  can_edit_quality: boolean;
  can_edit_sales: boolean;
  can_edit_development: boolean;
  is_admin: boolean;
}

const backendApprovalUrl = 'https://wj-reporting-backend.onrender.com/staff/signup-approvals/';

function openPortal(requestId?: number) {
  const url = requestId ? `${backendApprovalUrl}?request=${requestId}` : backendApprovalUrl;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function getPermissionSummary(profile: UserProfile) {
  if (profile.is_admin) return '관리자 (모든 권한)';

  const editable: string[] = [];
  if (profile.can_edit_injection) editable.push('사출');
  if (profile.can_edit_assembly) editable.push('가공');
  if (profile.can_edit_quality) editable.push('품질');
  if (profile.can_edit_sales) editable.push('영업/재고');
  if (profile.can_edit_development) editable.push('개발/ECO');

  return editable.length > 0 ? `${editable.join(', ')} 편집 권한` : '조회 전용';
}

export default function UserApproval() {
  const [requests, setRequests] = useState<SignupRequest[]>([]);
  const [userProfiles, setUserProfiles] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [requestsRes, profilesRes] = await Promise.all([
        api.get('/admin/signup-requests/'),
        api.get('/admin/user-profiles/'),
      ]);
      setRequests(requestsRes.data.results || requestsRes.data || []);
      setUserProfiles(profilesRes.data.results || profilesRes.data || []);
    } catch (err: any) {
      const message =
        err?.response?.data?.detail ||
        err?.response?.data?.error ||
        err?.message ||
        '가입자 정보를 불러오는데 실패했습니다.';
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  const pendingRequests = useMemo(
    () => requests.filter((req) => req.status === 'pending'),
    [requests],
  );

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">사용자 관리</h1>
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => fetchData()} disabled={loading}>
            <RefreshCcw className="mr-2 h-4 w-4" />
            새로고침
          </Button>
          <Button onClick={() => openPortal()} className="bg-blue-600 text-white hover:bg-blue-700">
            <ExternalLink className="mr-2 h-4 w-4" />
            백엔드 승인 포털 열기
          </Button>
        </div>
      </div>

      <Card>
        <CardContent className="py-6">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div className="flex items-start gap-3">
              <Shield className="mt-1 h-7 w-7 text-blue-600" />
              <div>
                <h2 className="text-lg font-semibold text-gray-900">승인 포털 안내</h2>
                <p className="text-sm text-gray-600 leading-relaxed">
                  브라우저에서 직접 승인 요청을 보내면 CORS 정책으로 차단될 수 있습니다.
                  <br />
                  관리자 계정으로 백엔드에 로그인한 뒤 위 버튼을 눌러 전용 포털에서 승인/거부를 진행해 주세요.
                </p>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {error && (
        <div className="rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div>
        <div className="mb-4 flex items-center gap-2">
          <Users className="h-5 w-5 text-gray-600" />
          <h2 className="text-xl font-semibold">
            승인 대기 중인 가입 요청 ({pendingRequests.length}명)
          </h2>
        </div>

        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold text-gray-600">사용자 정보</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-600">요청 사유</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-600">요청일</th>
                    <th className="px-4 py-3 text-center font-semibold text-gray-600">작업</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loading ? (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-gray-500">
                        정보를 불러오는 중입니다…
                      </td>
                    </tr>
                  ) : pendingRequests.length === 0 ? (
                    <tr>
                      <td colSpan={4} className="py-8 text-center text-gray-500">
                        승인 대기 중인 요청이 없습니다.
                      </td>
                    </tr>
                  ) : (
                    pendingRequests.map((req) => (
                      <tr key={req.id} className="hover:bg-blue-50/40">
                        <td className="px-4 py-3">
                          <div className="font-semibold text-gray-900">{req.full_name}</div>
                          <div className="text-gray-600">{req.email}</div>
                          <div className="text-gray-500">{req.department || '부서 미기재'}</div>
                        </td>
                        <td className="px-4 py-3 text-gray-700">
                          {req.reason ? (
                            <p className="whitespace-pre-wrap leading-relaxed">{req.reason}</p>
                          ) : (
                            <span className="text-gray-400">사유 없음</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {new Date(req.created_at).toLocaleString()}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <Button
                            size="sm"
                            variant="secondary"
                            className="text-blue-600 hover:text-blue-700"
                            onClick={() => openPortal(req.id)}
                          >
                            <ExternalLink className="mr-2 h-4 w-4" />
                            포털에서 열기
                          </Button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>

      <div>
        <div className="mb-4 flex items-center gap-2">
          <User className="h-5 w-5 text-gray-600" />
          <h2 className="text-xl font-semibold">등록된 사용자 목록 ({userProfiles.length}명)</h2>
        </div>

        <Card>
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left font-semibold text-gray-600">사용자</th>
                    <th className="px-4 py-3 text-left font-semibold text-gray-600">권한 요약</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loading ? (
                    <tr>
                      <td colSpan={2} className="py-8 text-center text-gray-500">
                        정보를 불러오는 중입니다…
                      </td>
                    </tr>
                  ) : userProfiles.length === 0 ? (
                    <tr>
                      <td colSpan={2} className="py-8 text-center text-gray-500">
                        등록된 사용자가 없습니다.
                      </td>
                    </tr>
                  ) : (
                    userProfiles.map((profile) => (
                      <tr key={profile.id}>
                        <td className="px-4 py-3">
                          <div className="font-semibold text-gray-900">
                            {profile.first_name || profile.username}
                          </div>
                          <div className="text-gray-600">{profile.email}</div>
                        </td>
                        <td className="px-4 py-3 text-gray-700">
                          {getPermissionSummary(profile)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
