import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { api } from '../../lib/api';
import { Shield, ExternalLink, RefreshCcw, User, Users, Key, Edit, Trash2, X } from 'lucide-react';

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
  user: number;
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

  // 모달 상태
  const [resetPasswordModal, setResetPasswordModal] = useState<{ open: boolean; user: UserProfile | null }>({ open: false, user: null });
  const [editPermissionsModal, setEditPermissionsModal] = useState<{ open: boolean; user: UserProfile | null }>({ open: false, user: null });
  const [deleteUserModal, setDeleteUserModal] = useState<{ open: boolean; user: UserProfile | null }>({ open: false, user: null });
  const [actionLoading, setActionLoading] = useState(false);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState<string | null>(null);

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

  // 비밀번호 리셋 핸들러
  const handleResetPassword = async (userId: number) => {
    setActionLoading(true);
    setError(null);
    setNewPassword(null);
    try {
      const response = await api.post('/admin/user/reset-password/', { user_id: userId });
      setNewPassword(response.data.temporary_password || '비밀번호가 리셋되었습니다');
      setActionSuccess('비밀번호가 성공적으로 리셋되었습니다');
      setTimeout(() => setActionSuccess(null), 3000);
    } catch (err: any) {
      const message = err?.response?.data?.detail || err?.response?.data?.error || '비밀번호 리셋에 실패했습니다';
      setError(message);
    } finally {
      setActionLoading(false);
    }
  };

  // 권한 수정 핸들러
  const handleUpdatePermissions = async (userId: number, permissions: Partial<UserProfile>) => {
    setActionLoading(true);
    setError(null);
    try {
      await api.patch(`/admin/user-profiles/${userId}/`, permissions);
      setActionSuccess('권한이 성공적으로 수정되었습니다');
      setEditPermissionsModal({ open: false, user: null });
      setTimeout(() => setActionSuccess(null), 3000);
      await fetchData(); // 목록 새로고침
    } catch (err: any) {
      const message = err?.response?.data?.detail || err?.response?.data?.error || '권한 수정에 실패했습니다';
      setError(message);
    } finally {
      setActionLoading(false);
    }
  };

  // 사용자 삭제 핸들러
  const handleDeleteUser = async (userId: number) => {
    setActionLoading(true);
    setError(null);
    try {
      await api.delete(`/admin/user-profiles/${userId}/`);
      setActionSuccess('사용자가 성공적으로 삭제되었습니다');
      setDeleteUserModal({ open: false, user: null });
      setTimeout(() => setActionSuccess(null), 3000);
      await fetchData(); // 목록 새로고침
    } catch (err: any) {
      const message = err?.response?.data?.detail || err?.response?.data?.error || '사용자 삭제에 실패했습니다';
      setError(message);
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">사용자 관리</h1>
        <Button variant="secondary" onClick={() => fetchData()} disabled={loading}>
          <RefreshCcw className="mr-2 h-4 w-4" />
          새로고침
        </Button>
      </div>

      {/* 백엔드 승인 포털 안내 카드 */}
      <Card className="border-2 border-blue-200 bg-blue-50/50">
        <CardContent className="py-5">
          <div className="flex flex-col gap-4">
            <div className="flex items-start gap-3">
              <Shield className="mt-1 h-7 w-7 text-blue-600 flex-shrink-0" />
              <div className="flex-1">
                <h2 className="text-lg font-semibold text-gray-900 mb-2">신규 사용자 승인 포털</h2>
                <p className="text-sm text-gray-700 leading-relaxed mb-4">
                  신규 가입 요청을 승인하거나 거부하려면 백엔드 승인 포털을 사용해주세요.
                  <br />
                  관리자 계정으로 백엔드에 로그인한 뒤 전용 포털에서 승인/거부를 진행할 수 있습니다.
                </p>
                <Button
                  onClick={() => openPortal()}
                  className="bg-blue-600 text-white hover:bg-blue-700 shadow-md"
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  백엔드 승인 포털 열기
                </Button>
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

      {actionSuccess && (
        <div className="rounded-md border border-green-200 bg-green-50 px-4 py-3 text-sm text-green-700">
          {actionSuccess}
        </div>
      )}

      {/* 승인 대기 요청 정보 */}
      {pendingRequests.length > 0 && (
        <Card className="border-l-4 border-l-orange-500">
          <CardContent className="py-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <Users className="h-6 w-6 text-orange-600" />
                <div>
                  <h3 className="font-semibold text-gray-900">승인 대기 중인 가입 요청</h3>
                  <p className="text-sm text-gray-600">
                    {pendingRequests.length}명의 사용자가 승인을 기다리고 있습니다
                  </p>
                </div>
              </div>
              <Button
                onClick={() => openPortal()}
                className="bg-orange-600 text-white hover:bg-orange-700"
              >
                승인 포털로 이동
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

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
                    <th className="px-4 py-3 text-center font-semibold text-gray-600">작업</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {loading ? (
                    <tr>
                      <td colSpan={3} className="py-8 text-center text-gray-500">
                        정보를 불러오는 중입니다…
                      </td>
                    </tr>
                  ) : userProfiles.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="py-8 text-center text-gray-500">
                        등록된 사용자가 없습니다.
                      </td>
                    </tr>
                  ) : (
                    userProfiles.map((profile) => (
                      <tr key={profile.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3">
                          <div className="font-semibold text-gray-900">
                            {profile.first_name || profile.username}
                          </div>
                          <div className="text-gray-600">{profile.email}</div>
                        </td>
                        <td className="px-4 py-3 text-gray-700">
                          {getPermissionSummary(profile)}
                        </td>
                        <td className="px-4 py-3">
                          <div className="flex items-center justify-center gap-2">
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-blue-600 hover:text-blue-700 hover:bg-blue-50"
                              onClick={() => setResetPasswordModal({ open: true, user: profile })}
                              title="비밀번호 리셋"
                            >
                              <Key className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-green-600 hover:text-green-700 hover:bg-green-50"
                              onClick={() => setEditPermissionsModal({ open: true, user: profile })}
                              title="권한 수정"
                            >
                              <Edit className="h-4 w-4" />
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-red-600 hover:text-red-700 hover:bg-red-50"
                              onClick={() => setDeleteUserModal({ open: true, user: profile })}
                              title="사용자 삭제"
                            >
                              <Trash2 className="h-4 w-4" />
                            </Button>
                          </div>
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

      {/* 비밀번호 리셋 모달 */}
      {resetPasswordModal.open && resetPasswordModal.user && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md mx-4">
            <CardContent className="pt-6">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Key className="h-5 w-5 text-blue-600" />
                  <h3 className="text-lg font-semibold">비밀번호 리셋</h3>
                </div>
                <button
                  onClick={() => {
                    setResetPasswordModal({ open: false, user: null });
                    setNewPassword(null);
                    setError(null);
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="mb-6">
                <p className="text-sm text-gray-600 mb-2">
                  <span className="font-semibold">{resetPasswordModal.user.first_name || resetPasswordModal.user.username}</span>님의 비밀번호를 리셋하시겠습니까?
                </p>
                {newPassword && (
                  <div className="mt-4 p-4 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-sm font-semibold text-blue-900 mb-2">새 임시 비밀번호:</p>
                    <code className="block p-2 bg-white border border-blue-300 rounded text-blue-700 font-mono text-sm break-all">
                      {newPassword}
                    </code>
                    <p className="text-xs text-blue-600 mt-2">
                      이 비밀번호를 사용자에게 전달하세요. 사용자는 로그인 후 비밀번호를 변경해야 합니다.
                    </p>
                  </div>
                )}
              </div>

              <div className="flex gap-2 justify-end">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setResetPasswordModal({ open: false, user: null });
                    setNewPassword(null);
                    setError(null);
                  }}
                  disabled={actionLoading}
                >
                  {newPassword ? '닫기' : '취소'}
                </Button>
                {!newPassword && (
                  <Button
                    onClick={() => handleResetPassword(resetPasswordModal.user!.user)}
                    disabled={actionLoading}
                    className="bg-blue-600 text-white hover:bg-blue-700"
                  >
                    {actionLoading ? '처리 중...' : '리셋'}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* 권한 수정 모달 */}
      {editPermissionsModal.open && editPermissionsModal.user && (
        <PermissionEditModal
          user={editPermissionsModal.user}
          onClose={() => {
            setEditPermissionsModal({ open: false, user: null });
            setError(null);
          }}
          onSave={handleUpdatePermissions}
          loading={actionLoading}
        />
      )}

      {/* 사용자 삭제 모달 */}
      {deleteUserModal.open && deleteUserModal.user && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md mx-4">
            <CardContent className="pt-6">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Trash2 className="h-5 w-5 text-red-600" />
                  <h3 className="text-lg font-semibold">사용자 삭제</h3>
                </div>
                <button
                  onClick={() => {
                    setDeleteUserModal({ open: false, user: null });
                    setError(null);
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="mb-6">
                <p className="text-sm text-gray-700 mb-4">
                  <span className="font-semibold">{deleteUserModal.user.first_name || deleteUserModal.user.username}</span>님을 삭제하시겠습니까?
                </p>
                <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
                  <p className="text-sm text-red-700">
                    ⚠️ <strong>경고:</strong> 이 작업은 되돌릴 수 없습니다. 사용자의 모든 데이터가 영구적으로 삭제됩니다.
                  </p>
                </div>
              </div>

              <div className="flex gap-2 justify-end">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setDeleteUserModal({ open: false, user: null });
                    setError(null);
                  }}
                  disabled={actionLoading}
                >
                  취소
                </Button>
                <Button
                  onClick={() => handleDeleteUser(deleteUserModal.user!.id)}
                  disabled={actionLoading}
                  className="bg-red-600 text-white hover:bg-red-700"
                >
                  {actionLoading ? '삭제 중...' : '삭제'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// 권한 수정 모달 컴포넌트
function PermissionEditModal({
  user,
  onClose,
  onSave,
  loading,
}: {
  user: UserProfile;
  onClose: () => void;
  onSave: (userId: number, permissions: Partial<UserProfile>) => void;
  loading: boolean;
}) {
  const [permissions, setPermissions] = useState({
    can_edit_injection: user.can_edit_injection,
    can_edit_assembly: user.can_edit_assembly,
    can_edit_quality: user.can_edit_quality,
    can_edit_sales: user.can_edit_sales,
    can_edit_development: user.can_edit_development,
    is_admin: user.is_admin,
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <Card className="w-full max-w-md mx-4">
        <CardContent className="pt-6">
          <div className="flex items-start justify-between mb-4">
            <div className="flex items-center gap-2">
              <Edit className="h-5 w-5 text-green-600" />
              <h3 className="text-lg font-semibold">권한 수정</h3>
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
              <X className="h-5 w-5" />
            </button>
          </div>

          <div className="mb-6">
            <p className="text-sm text-gray-600 mb-4">
              <span className="font-semibold">{user.first_name || user.username}</span>님의 권한을 수정합니다
            </p>

            <div className="space-y-3">
              <label className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={permissions.is_admin}
                  onChange={(e) => setPermissions({ ...permissions, is_admin: e.target.checked })}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <div>
                  <div className="font-medium text-gray-900">관리자</div>
                  <div className="text-xs text-gray-500">모든 권한 포함</div>
                </div>
              </label>

              <label className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={permissions.can_edit_injection}
                  onChange={(e) => setPermissions({ ...permissions, can_edit_injection: e.target.checked })}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <div className="font-medium text-gray-900">사출 편집 권한</div>
              </label>

              <label className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={permissions.can_edit_assembly}
                  onChange={(e) => setPermissions({ ...permissions, can_edit_assembly: e.target.checked })}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <div className="font-medium text-gray-900">가공 편집 권한</div>
              </label>

              <label className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={permissions.can_edit_quality}
                  onChange={(e) => setPermissions({ ...permissions, can_edit_quality: e.target.checked })}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <div className="font-medium text-gray-900">품질 편집 권한</div>
              </label>

              <label className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={permissions.can_edit_sales}
                  onChange={(e) => setPermissions({ ...permissions, can_edit_sales: e.target.checked })}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <div className="font-medium text-gray-900">영업/재고 편집 권한</div>
              </label>

              <label className="flex items-center gap-3 p-3 rounded-lg border border-gray-200 hover:bg-gray-50 cursor-pointer">
                <input
                  type="checkbox"
                  checked={permissions.can_edit_development}
                  onChange={(e) => setPermissions({ ...permissions, can_edit_development: e.target.checked })}
                  className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
                />
                <div className="font-medium text-gray-900">개발/ECO 편집 권한</div>
              </label>
            </div>
          </div>

          <div className="flex gap-2 justify-end">
            <Button variant="secondary" onClick={onClose} disabled={loading}>
              취소
            </Button>
            <Button
              onClick={() => onSave(user.id, permissions)}
              disabled={loading}
              className="bg-green-600 text-white hover:bg-green-700"
            >
              {loading ? '저장 중...' : '저장'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
