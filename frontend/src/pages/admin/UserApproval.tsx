import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { api } from '../../lib/api';
import { Shield, RefreshCcw, User, UserPlus, Users, Key, Edit, UserCheck, UserX, X } from 'lucide-react';

interface SignupRequest {
  id: number;
  full_name: string;
  department: string;
  email: string;
  reason?: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}

interface EditablePermissions {
  can_edit_injection: boolean;
  can_edit_assembly: boolean;
  can_edit_quality: boolean;
  can_edit_sales: boolean;
  can_edit_development: boolean;
  can_confirm_moulds: boolean;
  is_admin: boolean;
}

interface UserProfile extends EditablePermissions {
  id: number;
  user: number;
  username: string;
  email: string;
  first_name: string;
  department?: string;
  is_active: boolean;
  is_staff: boolean;
  is_superuser: boolean;
}

interface UserFormState {
  first_name: string;
  username: string;
  email: string;
  department: string;
  permissions: EditablePermissions;
}

function createEmptyPermissions(): EditablePermissions {
  return {
    can_edit_injection: false,
    can_edit_assembly: false,
    can_edit_quality: false,
    can_edit_sales: false,
    can_edit_development: false,
    can_confirm_moulds: false,
    is_admin: false,
  };
}

function createEmptyUserForm(): UserFormState {
  return {
    first_name: '',
    username: '',
    email: '',
    department: '',
    permissions: createEmptyPermissions(),
  };
}

function getApiErrorMessage(payload: unknown, fallback: string) {
  if (!payload || typeof payload !== 'object') return fallback;
  const data = payload as Record<string, unknown>;
  for (const key of ['first_name', 'username', 'email', 'department', 'is_active', 'is_admin', 'detail', 'error']) {
    const value = data[key];
    if (Array.isArray(value) && value.length > 0) return String(value[0]);
    if (typeof value === 'string' && value) return value;
  }
  return fallback;
}

function getPermissionSummary(profile: UserProfile) {
  if (profile.is_admin) return '관리자 (모든 권한)';

  const editable: string[] = [];
  if (profile.can_edit_injection) editable.push('사출');
  if (profile.can_edit_assembly) editable.push('가공');
  if (profile.can_edit_quality) editable.push('품질');
  if (profile.can_edit_sales) editable.push('영업/재고');
  if (profile.can_edit_development) editable.push('개발/ECO');
  if (profile.can_confirm_moulds) editable.push('금형 확인·확정');

  return editable.length > 0 ? `${editable.join(', ')} 편집 권한` : '조회 전용';
}

export default function UserApproval() {
  const [requests, setRequests] = useState<SignupRequest[]>([]);
  const [userProfiles, setUserProfiles] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 모달 상태
  const [resetPasswordModal, setResetPasswordModal] = useState<{ open: boolean; user: UserProfile | null }>({ open: false, user: null });
  const [editUserModal, setEditUserModal] = useState<{ open: boolean; user: UserProfile | null }>({ open: false, user: null });
  const [deleteUserModal, setDeleteUserModal] = useState<{ open: boolean; user: UserProfile | null }>({ open: false, user: null });
  const [approvalModal, setApprovalModal] = useState<{ open: boolean; request: SignupRequest | null }>({ open: false, request: null });
  const [approvalPermissions, setApprovalPermissions] = useState<EditablePermissions>(createEmptyPermissions);
  const [createUserModal, setCreateUserModal] = useState(false);
  const [createUserForm, setCreateUserForm] = useState<UserFormState>(createEmptyUserForm);
  const [editUserForm, setEditUserForm] = useState<UserFormState | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const [requestsRes, profilesRes] = await Promise.all([
        api.get('/admin/approval-requests/?status=pending'),
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

  // 승인 핸들러
  const handleApproveRequest = async (requestId: number, permissions: any) => {
    setActionLoading(true);
    setError(null);
    setNewPassword(null);
    try {
      const response = await api.post(`/admin/approval-requests/${requestId}/approve/`, { permissions });
      setNewPassword(response.data.temporary_password);
      setActionSuccess('사용자 가입이 승인되었습니다');
      setApprovalModal({ open: true, request: null }); // Keep modal open for password display (using resetPasswordModal's structure or similar)
      // Actually, we use newPassword state to show the password, so let's set a state that triggers a success modal
      await fetchData();
    } catch (err: any) {
      const message = err?.response?.data?.detail || err?.response?.data?.error || '승인에 실패했습니다';
      setError(message);
      setActionLoading(false);
    } finally {
      // actionLoading is set to false only if not showing password
      if (!newPassword) setActionLoading(false);
    }
  };

  // 거부 핸들러
  const handleRejectRequest = async (requestId: number) => {
    if (!window.confirm('정말로 이 가입 요청을 거부하시겠습니까?')) return;
    setActionLoading(true);
    setError(null);
    try {
      await api.post(`/admin/approval-requests/${requestId}/reject/`);
      setActionSuccess('가입 요청이 거부되었습니다');
      setTimeout(() => setActionSuccess(null), 3000);
      await fetchData();
    } catch (err: any) {
      const message = err?.response?.data?.detail || err?.response?.data?.error || '거부에 실패했습니다';
      setError(message);
    } finally {
      setActionLoading(false);
    }
  };

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

  const openEditUserModal = (profile: UserProfile) => {
    setEditUserForm({
      first_name: profile.first_name || '',
      username: profile.username,
      email: profile.email || '',
      department: profile.department || '',
      permissions: {
        can_edit_injection: profile.can_edit_injection,
        can_edit_assembly: profile.can_edit_assembly,
        can_edit_quality: profile.can_edit_quality,
        can_edit_sales: profile.can_edit_sales,
        can_edit_development: profile.can_edit_development,
        can_confirm_moulds: profile.can_confirm_moulds,
        is_admin: profile.is_admin,
      },
    });
    setEditUserModal({ open: true, user: profile });
    setError(null);
  };

  const handleUpdateUser = async (profileId: number) => {
    if (!editUserForm) return;
    setActionLoading(true);
    setError(null);
    try {
      await api.patch(`/admin/user-profiles/${profileId}/`, {
        first_name: editUserForm.first_name.trim(),
        username: editUserForm.username.trim(),
        email: editUserForm.email.trim(),
        department: editUserForm.department.trim(),
        ...editUserForm.permissions,
      });
      setActionSuccess('사용자 정보가 성공적으로 수정되었습니다');
      setEditUserModal({ open: false, user: null });
      setEditUserForm(null);
      setTimeout(() => setActionSuccess(null), 3000);
      await fetchData(); // 목록 새로고침
    } catch (err: any) {
      setError(getApiErrorMessage(err?.response?.data, '사용자 정보 수정에 실패했습니다'));
    } finally {
      setActionLoading(false);
    }
  };

  const handleToggleUserActive = async (profile: UserProfile) => {
    setActionLoading(true);
    setError(null);
    try {
      const nextActive = !profile.is_active;
      await api.patch(`/admin/user-profiles/${profile.id}/`, { is_active: nextActive });
      setActionSuccess(nextActive ? '계정이 다시 활성화되었습니다' : '계정 사용이 중지되었습니다');
      setDeleteUserModal({ open: false, user: null });
      setTimeout(() => setActionSuccess(null), 3000);
      await fetchData();
    } catch (err: any) {
      setError(getApiErrorMessage(err?.response?.data, '계정 상태 변경에 실패했습니다'));
    } finally {
      setActionLoading(false);
    }
  };

  const handleCreateUser = async () => {
    setActionLoading(true);
    setError(null);
    try {
      const response = await api.post('/admin/users/', {
        first_name: createUserForm.first_name.trim(),
        username: createUserForm.username.trim(),
        email: createUserForm.email.trim(),
        department: createUserForm.department.trim(),
        permissions: createUserForm.permissions,
      });
      const initialPassword = String(response.data?.initial_password || '');
      setActionSuccess(
        initialPassword
          ? `사용자가 생성되었습니다. 초기 비밀번호는 ${initialPassword}이며 첫 로그인 시 변경해야 합니다.`
          : '사용자가 생성되었습니다. 사용자는 첫 로그인 시 비밀번호를 변경해야 합니다.',
      );
      setCreateUserModal(false);
      setCreateUserForm(createEmptyUserForm());
      setTimeout(() => setActionSuccess(null), 8000);
      await fetchData();
    } catch (err: any) {
      setError(getApiErrorMessage(err?.response?.data, '사용자 생성에 실패했습니다'));
    } finally {
      setActionLoading(false);
    }
  };

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-8">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">사용자 관리</h1>
        <div className="flex gap-2">
          <Button onClick={() => setCreateUserModal(true)}>
            <UserPlus className="mr-2 h-4 w-4" />
            사용자 추가
          </Button>
          <Button variant="secondary" onClick={() => fetchData()} disabled={loading}>
            <RefreshCcw className="mr-2 h-4 w-4" />
            새로고침
          </Button>
        </div>
      </div>

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

      {/* 승인 대기 요청 목록 */}
      <div>
        <div className="mb-4 flex items-center gap-2">
          <Users className="h-6 w-6 text-orange-600" />
          <h2 className="text-2xl font-bold text-orange-700">승인 대기 중인 가입 요청 ({pendingRequests.length})</h2>
        </div>

        <div className="bg-white rounded-lg border border-orange-100 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gradient-to-r from-orange-50 to-amber-50">
                <tr>
                  <th className="px-4 py-3.5 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">요청자</th>
                  <th className="px-4 py-3.5 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">부서/사유</th>
                  <th className="px-4 py-3.5 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">신청일시</th>
                  <th className="px-4 py-3.5 text-center text-xs font-bold text-gray-700 uppercase tracking-wider">관리</th>
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
                    <td colSpan={4} className="py-8 text-center text-gray-400">
                      대기 중인 가입 요청이 없습니다.
                    </td>
                  </tr>
                ) : (
                  pendingRequests.map((req) => (
                    <tr key={req.id} className="hover:bg-orange-50/20">
                      <td className="px-4 py-3">
                        <div className="font-semibold text-gray-900">{req.full_name}</div>
                        <div className="text-gray-600 underline text-xs">{req.email}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-gray-700 font-medium">{req.department}</div>
                        <div className="text-gray-500 text-xs mt-0.5 line-clamp-1" title={req.reason}>
                          {req.reason || '-'}
                        </div>
                      </td>
                      <td className="px-4 py-3 text-gray-500 text-xs">
                        {new Date(req.created_at).toLocaleString()}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center justify-center gap-2">
                          <Button
                            size="sm"
                            className="bg-green-600 text-white hover:bg-green-700 h-8 px-3"
                            onClick={() => {
                              setApprovalPermissions(createEmptyPermissions());
                              setApprovalModal({ open: true, request: req });
                            }}
                          >
                            승인
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-red-600 hover:text-red-700 hover:bg-red-50 h-8 px-3"
                            onClick={() => handleRejectRequest(req.id)}
                          >
                            거부
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      <div>
        <div className="mb-4 flex items-center gap-2">
          <User className="h-6 w-6 text-gray-600" />
          <h2 className="text-2xl font-bold text-gray-800">등록된 사용자 목록 ({userProfiles.length}명)</h2>
        </div>

        <div className="bg-white rounded-lg border border-gray-200 overflow-hidden shadow-sm">
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gradient-to-r from-blue-50 to-indigo-50">
                <tr>
                  <th className="px-4 py-3.5 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">사용자</th>
                  <th className="px-4 py-3.5 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">부서</th>
                  <th className="px-4 py-3.5 text-left text-xs font-bold text-gray-700 uppercase tracking-wider">권한 요약</th>
                  <th className="px-4 py-3.5 text-center text-xs font-bold text-gray-700 uppercase tracking-wider">작업</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {loading ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-gray-500">
                      정보를 불러오는 중입니다…
                    </td>
                  </tr>
                ) : userProfiles.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="py-8 text-center text-gray-500">
                      등록된 사용자가 없습니다.
                    </td>
                  </tr>
                ) : (
                  userProfiles.map((profile) => (
                    <tr
                      key={profile.id}
                      className={`transition-colors duration-150 ${profile.is_active ? 'hover:bg-blue-50/30' : 'bg-gray-50 opacity-70'}`}
                    >
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 font-semibold text-gray-900">
                          <span>{profile.first_name || profile.username}</span>
                          {!profile.is_active && (
                            <span className="rounded-full bg-gray-200 px-2 py-0.5 text-[10px] font-bold text-gray-600">
                              사용 중지
                            </span>
                          )}
                        </div>
                        <div className="text-xs text-gray-500">아이디: {profile.username}</div>
                        <div className="text-gray-600 underline text-xs">{profile.email || '-'}</div>
                      </td>
                      <td className="px-4 py-3 text-gray-700 font-medium">
                        {profile.department || '-'}
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
                            disabled={!profile.is_active}
                            title="비밀번호 리셋"
                          >
                            <Key className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className="text-green-600 hover:text-green-700 hover:bg-green-50"
                            onClick={() => openEditUserModal(profile)}
                            title="사용자 정보 수정"
                          >
                            <Edit className="h-4 w-4" />
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            className={profile.is_active
                              ? 'text-red-600 hover:text-red-700 hover:bg-red-50'
                              : 'text-emerald-600 hover:text-emerald-700 hover:bg-emerald-50'}
                            onClick={() => setDeleteUserModal({ open: true, user: profile })}
                            title={profile.is_active ? '계정 사용 중지' : '계정 다시 활성화'}
                          >
                            {profile.is_active
                              ? <UserX className="h-4 w-4" />
                              : <UserCheck className="h-4 w-4" />}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {createUserModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 px-4 py-8">
          <Card className="w-full max-w-2xl shadow-2xl">
            <CardContent className="pt-6">
              <div className="mb-5 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <UserPlus className="h-5 w-5 text-blue-600" />
                  <h3 className="text-lg font-semibold">사용자 추가</h3>
                </div>
                <button onClick={() => setCreateUserModal(false)} className="text-gray-400 hover:text-gray-600" aria-label="닫기">
                  <X className="h-5 w-5" />
                </button>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="block text-sm font-semibold text-gray-700">
                  이름
                  <input
                    value={createUserForm.first_name}
                    onChange={(event) => setCreateUserForm((current) => ({ ...current, first_name: event.target.value }))}
                    className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 font-normal focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="사용자 이름"
                    autoComplete="name"
                  />
                </label>
                <label className="block text-sm font-semibold text-gray-700">
                  아이디
                  <input
                    value={createUserForm.username}
                    onChange={(event) => setCreateUserForm((current) => ({ ...current, username: event.target.value }))}
                    className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 font-normal focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="로그인 아이디"
                    autoComplete="off"
                  />
                </label>
                <label className="block text-sm font-semibold text-gray-700">
                  이메일 주소
                  <input
                    type="email"
                    value={createUserForm.email}
                    onChange={(event) => setCreateUserForm((current) => ({ ...current, email: event.target.value }))}
                    className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 font-normal focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="name@njwanjia.com"
                    autoComplete="email"
                  />
                </label>
                <label className="block text-sm font-semibold text-gray-700">
                  부서
                  <input
                    value={createUserForm.department}
                    onChange={(event) => setCreateUserForm((current) => ({ ...current, department: event.target.value }))}
                    className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 font-normal focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="부서"
                  />
                </label>
              </div>

              <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
                생성 완료 후 초기 비밀번호가 표시됩니다. 사용자는 첫 로그인 직후 본인 비밀번호로 반드시 변경해야 합니다.
              </div>

              <div className="mt-5">
                <h4 className="mb-3 text-xs font-black uppercase tracking-widest text-gray-400">초기 권한 설정</h4>
                <PermissionCheckboxList
                  permissions={createUserForm.permissions}
                  onSelectionChange={(permissions) => setCreateUserForm((current) => ({ ...current, permissions }))}
                />
              </div>
              <div className="mt-6 flex justify-end gap-2">
                <Button variant="secondary" onClick={() => setCreateUserModal(false)} disabled={actionLoading}>취소</Button>
                <Button
                  onClick={handleCreateUser}
                  disabled={
                    actionLoading
                    || !createUserForm.first_name.trim()
                    || !createUserForm.username.trim()
                    || !createUserForm.email.trim()
                  }
                >
                  {actionLoading ? '생성 중...' : '사용자 생성'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* 승인 모달 (권한 설정 포함) */}
      {approvalModal.open && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 overflow-y-auto pt-10 pb-10">
          <Card className="w-full max-w-md mx-4 shadow-2xl">
            <CardContent className="pt-6">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Shield className="h-5 w-5 text-green-600" />
                  <h3 className="text-lg font-semibold">사용자 가입 승인</h3>
                </div>
                <button
                  onClick={() => {
                    setApprovalModal({ open: false, request: null });
                    setNewPassword(null);
                    setError(null);
                  }}
                  className="text-gray-400 hover:text-gray-600"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              {!newPassword ? (
                <>
                  <div className="mb-4 bg-gray-50 p-3 rounded-lg border border-gray-100">
                    <div className="text-sm font-bold text-gray-900">{approvalModal.request?.full_name}</div>
                    <div className="text-xs text-gray-600">{approvalModal.request?.email}</div>
                    <div className="text-xs text-gray-500 mt-1">{approvalModal.request?.department}</div>
                  </div>

                  <div className="mb-6">
                    <h4 className="text-xs font-black text-gray-400 uppercase tracking-widest mb-3">초기 권한 설정</h4>
                    <PermissionCheckboxList
                      permissions={approvalPermissions}
                      onSelectionChange={setApprovalPermissions}
                    />
                  </div>

                  <div className="flex gap-2 justify-end">
                    <Button
                      variant="secondary"
                      onClick={() => setApprovalModal({ open: false, request: null })}
                      disabled={actionLoading}
                    >
                      취소
                    </Button>
                    <Button
                      onClick={() => handleApproveRequest(approvalModal.request!.id, approvalPermissions)}
                      disabled={actionLoading}
                      className="bg-green-600 text-white hover:bg-green-700"
                    >
                      {actionLoading ? '승인 처리 중...' : '확인 및 승인'}
                    </Button>
                  </div>
                </>
              ) : (
                <div className="space-y-6">
                  <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-center">
                    <div className="w-12 h-12 bg-green-100 text-green-600 rounded-full flex items-center justify-center mx-auto mb-3">
                      <Shield className="h-6 w-6" />
                    </div>
                    <h4 className="text-green-900 font-bold mb-1">승인 완료</h4>
                    <p className="text-sm text-green-700">임시 비밀번호가 생성되었습니다.</p>
                  </div>

                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-xl">
                    <p className="text-xs font-bold text-blue-900 mb-2 uppercase tracking-tight">임시 비밀번호</p>
                    <code className="block p-3 bg-white border border-blue-300 rounded-lg text-blue-700 font-mono text-lg text-center break-all shadow-sm">
                      {newPassword}
                    </code>
                    <p className="text-[10px] text-blue-600 mt-3 leading-relaxed">
                      * 이 비밀번호를 사용자에게 안전하게 전달하세요.<br />
                      * 사용자는 최초 로그인 시 비밀번호를 변경해야 합니다.
                    </p>
                  </div>

                  <Button
                    className="w-full bg-gray-900 text-white hover:bg-black"
                    onClick={() => {
                      setApprovalModal({ open: false, request: null });
                      setNewPassword(null);
                    }}
                  >
                    닫기
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* 비밀번호 리셋 모달 */}
      {resetPasswordModal.open && resetPasswordModal.user && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md mx-4 shadow-2xl">
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

              {!newPassword ? (
                <div className="mb-6">
                  <p className="text-sm text-gray-600 mb-2">
                    <span className="font-semibold">{resetPasswordModal.user.first_name || resetPasswordModal.user.username}</span>님의 비밀번호를 리셋하시겠습니까?
                  </p>
                  <p className="text-xs text-gray-400">리셋 시 무작위로 생성된 임시 비밀번호가 부여됩니다.</p>
                </div>
              ) : (
                <div className="mb-6">
                  <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
                    <p className="text-xs font-semibold text-blue-900 mb-2 uppercase tracking-widest">새 임시 비밀번호</p>
                    <code className="block p-4 bg-white border border-blue-300 rounded text-blue-700 font-mono text-lg text-center break-all">
                      {newPassword}
                    </code>
                    <p className="text-[10px] text-blue-600 mt-3 leading-relaxed">
                      이 비밀번호를 사용자에게 전달하세요. 사용자는 로그인 후 비밀번호를 변경해야 합니다.
                    </p>
                  </div>
                </div>
              )}

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
                    {actionLoading ? '처리 중...' : '리셋 실행'}
                  </Button>
                )}
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* 사용자 정보 수정 모달 */}
      {editUserModal.open && editUserModal.user && editUserForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/50 px-4 py-8">
          <Card className="w-full max-w-2xl shadow-xl">
            <CardContent className="pt-6">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-2">
                  <Edit className="h-5 w-5 text-green-600" />
                  <h3 className="text-lg font-semibold">사용자 정보 수정</h3>
                </div>
                <button
                  onClick={() => {
                    setEditUserModal({ open: false, user: null });
                    setEditUserForm(null);
                    setError(null);
                  }}
                  className="text-gray-400 hover:text-gray-600"
                  aria-label="닫기"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>

              <div className="mb-6">
                <p className="text-sm text-gray-600 mb-4">
                  <span className="font-semibold">{editUserModal.user.first_name || editUserModal.user.username}</span>님의 계정 정보와 권한을 수정합니다.
                </p>

                <div className="mb-5 grid gap-4 sm:grid-cols-2">
                  <label className="block text-sm font-semibold text-gray-700">
                    이름
                    <input
                      value={editUserForm.first_name}
                      onChange={(event) => setEditUserForm((current) => current && ({ ...current, first_name: event.target.value }))}
                      className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 font-normal focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="사용자 이름"
                    />
                  </label>
                  <label className="block text-sm font-semibold text-gray-700">
                    아이디
                    <input
                      value={editUserForm.username}
                      onChange={(event) => setEditUserForm((current) => current && ({ ...current, username: event.target.value }))}
                      className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 font-normal focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="로그인 아이디"
                      autoComplete="off"
                    />
                  </label>
                  <label className="block text-sm font-semibold text-gray-700">
                    이메일 주소
                    <input
                      type="email"
                      value={editUserForm.email}
                      onChange={(event) => setEditUserForm((current) => current && ({ ...current, email: event.target.value }))}
                      className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 font-normal focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="name@njwanjia.com"
                    />
                  </label>
                  <label className="block text-sm font-semibold text-gray-700">
                    부서
                    <input
                      value={editUserForm.department}
                      onChange={(event) => setEditUserForm((current) => current && ({ ...current, department: event.target.value }))}
                      className="mt-1 w-full rounded-md border border-gray-200 px-3 py-2 font-normal focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="부서를 입력하세요"
                    />
                  </label>
                </div>

                <h4 className="mb-3 text-xs font-black uppercase tracking-widest text-gray-400">권한 설정</h4>
                <PermissionCheckboxList
                  permissions={editUserForm.permissions}
                  onSelectionChange={(permissions) => setEditUserForm((current) => current && ({ ...current, permissions }))}
                />
              </div>

              <div className="flex gap-2 justify-end">
                <Button
                  variant="secondary"
                  onClick={() => {
                    setEditUserModal({ open: false, user: null });
                    setEditUserForm(null);
                    setError(null);
                  }}
                  disabled={actionLoading}
                >
                  취소
                </Button>
                <Button
                  onClick={() => handleUpdateUser(editUserModal.user!.id)}
                  disabled={actionLoading || !editUserForm.username.trim()}
                  className="bg-green-600 text-white hover:bg-green-700"
                >
                  {actionLoading ? '저장 중...' : '정보 저장'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}

      {/* 계정 활성 상태 변경 모달 */}
      {deleteUserModal.open && deleteUserModal.user && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <Card className="w-full max-w-md mx-4">
            <CardContent className="pt-6">
              <div className="flex items-start justify-between mb-4">
                <div className="flex items-center gap-2">
                  {deleteUserModal.user.is_active
                    ? <UserX className="h-5 w-5 text-red-600" />
                    : <UserCheck className="h-5 w-5 text-emerald-600" />}
                  <h3 className="text-lg font-semibold">
                    {deleteUserModal.user.is_active ? '계정 사용 중지' : '계정 다시 활성화'}
                  </h3>
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
                  <span className="font-semibold">{deleteUserModal.user.first_name || deleteUserModal.user.username}</span>님의 계정을
                  {deleteUserModal.user.is_active ? ' 사용 중지하시겠습니까?' : ' 다시 활성화하시겠습니까?'}
                </p>
                <div className={deleteUserModal.user.is_active
                  ? 'rounded-lg border border-amber-200 bg-amber-50 p-4'
                  : 'rounded-lg border border-emerald-200 bg-emerald-50 p-4'}>
                  <p className={deleteUserModal.user.is_active ? 'text-sm text-amber-800' : 'text-sm text-emerald-800'}>
                    {deleteUserModal.user.is_active
                      ? '즉시 로그인이 차단되지만 기존 작업 이력과 계정 정보는 안전하게 보존됩니다. 필요하면 다시 활성화할 수 있습니다.'
                      : '활성화하면 이 사용자가 다시 로그인할 수 있습니다.'}
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
                  onClick={() => handleToggleUserActive(deleteUserModal.user!)}
                  disabled={actionLoading}
                  className={deleteUserModal.user.is_active
                    ? 'bg-red-600 text-white hover:bg-red-700'
                    : 'bg-emerald-600 text-white hover:bg-emerald-700'}
                >
                  {actionLoading
                    ? '처리 중...'
                    : deleteUserModal.user.is_active ? '사용 중지' : '다시 활성화'}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// 추출된 권한 체크박스 리스트 컴포넌트
function PermissionCheckboxList({
  permissions,
  onSelectionChange,
}: {
  permissions: EditablePermissions;
  onSelectionChange: (permissions: EditablePermissions) => void;
}) {
  const handleChange = (key: keyof EditablePermissions, value: boolean) => {
    onSelectionChange({ ...permissions, [key]: value });
  };

  return (
    <div className="space-y-2">
      <label className="flex items-center gap-3 p-3 rounded-xl border border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors shadow-sm bg-white">
        <input
          type="checkbox"
          checked={permissions.is_admin}
          onChange={(e) => handleChange('is_admin', e.target.checked)}
          className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
        />
        <div>
          <div className="font-bold text-gray-900 text-sm">관리자</div>
          <div className="text-[10px] text-gray-500 uppercase font-black">Full access included</div>
        </div>
      </label>

      {([
        { id: 'can_edit_injection', label: '사출 편집 권한' },
        { id: 'can_confirm_moulds', label: '금형 확인·확정 권한' },
        { id: 'can_edit_assembly', label: '가공 편집 권한' },
        { id: 'can_edit_quality', label: '품질 편집 권한' },
        { id: 'can_edit_sales', label: '영업/재고 편집 권한' },
        { id: 'can_edit_development', label: '개발/ECO 편집 권한' },
      ] as Array<{ id: keyof EditablePermissions; label: string }>).map((permission) => (
        <label key={permission.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-gray-100 hover:bg-gray-50 cursor-pointer transition-colors bg-white/50">
          <input
            type="checkbox"
            checked={permissions[permission.id]}
            onChange={(event) => handleChange(permission.id, event.target.checked)}
            className="w-4 h-4 text-blue-600 rounded focus:ring-2 focus:ring-blue-500"
          />
          <div className="font-semibold text-gray-700 text-xs">{permission.label}</div>
        </label>
      ))}
    </div>
  );
}
