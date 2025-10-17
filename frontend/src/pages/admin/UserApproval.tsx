import { useState, useEffect } from 'react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { api } from '../../lib/api';
import { CheckCircle, XCircle, Edit, RotateCcw, User, Users, Shield } from 'lucide-react';

interface SignupRequest {
  id: number;
  full_name: string;
  department: string;
  email: string;
  reason?: string;
  status: 'pending' | 'approved' | 'rejected';
  created_at: string;
}

interface ApprovalResult {
  username: string;
  temporary_password: string;
}

interface UserProfile {
  id: number;
  user: number;
  username: string;
  email: string;
  first_name: string;
  can_view_injection: boolean;
  can_view_assembly: boolean;
  can_view_quality: boolean;
  can_view_sales: boolean;
  can_view_development: boolean;
  can_edit_injection: boolean;
  can_edit_assembly: boolean;
  can_edit_quality: boolean;
  can_edit_sales: boolean;
  can_edit_development: boolean;
  is_admin: boolean;
}

export default function UserApproval() {
  const [requests, setRequests] = useState<SignupRequest[]>([]);
  const [userProfiles, setUserProfiles] = useState<UserProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [approvalResult, setApprovalResult] = useState<ApprovalResult | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<SignupRequest | null>(null);
  const [selectedProfile, setSelectedProfile] = useState<UserProfile | null>(null);
  const [editingPermissions, setEditingPermissions] = useState<{[key: string]: boolean}>({});
  const [resetPasswordResult, setResetPasswordResult] = useState<ApprovalResult | null>(null);
  const backendApprovalUrl = 'https://wj-reporting-backend.onrender.com/staff/signup-approvals/';

  // 권한 옵션 목록 (편집 권한만 표시 - 조회는 기본 부여)
  const permissionOptions = [
    { key: 'can_edit_injection', label: '사출 편집/삭제' },
    { key: 'can_edit_assembly', label: '가공 편집/삭제' },
    { key: 'can_edit_quality', label: '품질 편집/삭제' },
    { key: 'can_edit_sales', label: '영업/재고 편집/삭제' },
    { key: 'can_edit_development', label: '개발/ECO 편집/삭제' },
    { key: 'is_admin', label: '관리자 권한' },
  ];

  // 권한 설정 상태 (편집 권한만 관리)
  const [permissions, setPermissions] = useState({
    can_edit_injection: false,
    can_edit_assembly: false,
    can_edit_quality: false,
    can_edit_sales: false,
    can_edit_development: false,
    is_admin: false,
  });

  // 권한 요약 함수
  const getPermissionSummary = (profile: UserProfile) => {
    const permissions = [];
    if (profile.is_admin) {
      return '관리자 (모든 권한)';
    }
    if (profile.can_edit_injection) permissions.push('사출');
    if (profile.can_edit_assembly) permissions.push('가공');
    if (profile.can_edit_quality) permissions.push('품질');
    if (profile.can_edit_sales) permissions.push('영업/재고');
    if (profile.can_edit_development) permissions.push('개발/ECO');

    return permissions.length > 0 ? `${permissions.join(', ')} 편집권한` : '조회만 가능';
  };

  // 가입 요청 목록 가져오기
  const fetchRequests = async () => {
    try {
      const response = await api.get('/admin/signup-requests/');
      setRequests(response.data.results || response.data);
    } catch (error: any) {
      console.error('Failed to fetch signup requests:', error);
      const errorMessage = error?.response?.data?.detail || error?.message || '가입 요청 목록을 불러오는데 실패했습니다.';
      alert(errorMessage);
    }
  };

  // 사용자 프로필 목록 가져오기
  const fetchUserProfiles = async () => {
    try {
      const response = await api.get('/admin/user-profiles/');
      setUserProfiles(response.data.results || response.data);
    } catch (error: any) {
      console.error('Failed to fetch user profiles:', error);
      const errorMessage = error?.response?.data?.detail || error?.message || '사용자 프로필 목록을 불러오는데 실패했습니다.';
      alert(errorMessage);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRequests();
    fetchUserProfiles();
  }, []);

  // 가입 승인
  const handleApprove = async (requestId: number) => {
    try {
      console.log('Sending permissions:', permissions);
      const response = await api.post(`/admin/signup-requests/${requestId}/approve/`, { permissions });

      setApprovalResult({
        username: response.data.username,
        temporary_password: response.data.temporary_password,
      });

      // 권한 초기화
      setPermissions({
        can_edit_injection: false,
        can_edit_assembly: false,
        can_edit_quality: false,
        can_edit_sales: false,
        can_edit_development: false,
        is_admin: false,
      });

      // 목록 새로고침
      await Promise.all([
        fetchRequests(),
        fetchUserProfiles()
      ]);

      setSelectedRequest(null);

    } catch (error: any) {
      console.error('Approval failed:', error);
      console.error('Error response:', error.response?.data);

      let errorMessage = '승인 처리 중 오류가 발생했습니다.';
      if (error.response?.status === 401) {
        errorMessage = '인증이 필요합니다. 다시 로그인해주세요.';
      } else if (error.response?.status === 403) {
        errorMessage = '권한이 없습니다. 관리자 권한이 필요합니다.';
      } else if (error.response?.status === 500) {
        const serverError = error.response?.data?.error || error.response?.data?.detail;
        errorMessage = serverError || '서버 내부 오류가 발생했습니다.';
      } else if (error.response?.data?.error) {
        errorMessage = error.response.data.error;
      } else if (error.response?.data?.detail) {
        errorMessage = error.response.data.detail;
      }

      alert(errorMessage);
    }
  };

  // 가입 거부
  const handleReject = async (requestId: number) => {
    if (!confirm('정말 이 가입 요청을 거부하시겠습니까?')) return;

    try {
      await api.post(`/admin/signup-requests/${requestId}/reject/`);
      alert('가입 요청이 거부되었습니다.');
      fetchRequests(); // 목록 새로고침
      setSelectedRequest(null);
    } catch (error: any) {
      console.error('Rejection failed:', error);
      const errorMessage = error?.response?.data?.error || error?.response?.data?.detail || error?.message || '거부 처리 중 오류가 발생했습니다.';
      alert(errorMessage);
    }
  };

  // 권한 체크박스 변경
  const handlePermissionChange = (key: string, value: boolean) => {
    setPermissions(prev => ({
      ...prev,
      [key]: value
    }));
  };

  // 사용자 권한 편집 시작
  const handleEditUserPermissions = (profile: UserProfile) => {
    setSelectedProfile(profile);
    setEditingPermissions({
      can_edit_injection: profile.can_edit_injection,
      can_edit_assembly: profile.can_edit_assembly,
      can_edit_quality: profile.can_edit_quality,
      can_edit_sales: profile.can_edit_sales,
      can_edit_development: profile.can_edit_development,
      is_admin: profile.is_admin,
    });
  };

  // 사용자 권한 수정 저장
  const handleUpdateUserPermissions = async () => {
    if (!selectedProfile) return;

    try {
      await api.patch(`/admin/user-profiles/${selectedProfile.id}/`, editingPermissions);
      alert('권한이 성공적으로 수정되었습니다.');
      setSelectedProfile(null);
      fetchUserProfiles(); // 목록 새로고침
    } catch (error: any) {
      console.error('Failed to update permissions:', error);
      const errorMessage = error?.response?.data?.error || error?.response?.data?.detail || error?.message || '권한 수정 중 오류가 발생했습니다.';
      alert(errorMessage);
    }
  };

  // 편집 권한 체크박스 변경
  const handleEditingPermissionChange = (key: string, value: boolean) => {
    setEditingPermissions(prev => ({
      ...prev,
      [key]: value
    }));
  };

  // 비밀번호 리셋
  const handleResetPassword = async (userId: number) => {
    if (!confirm('이 사용자의 비밀번호를 리셋하시겠습니까? 새로운 임시 비밀번호가 생성됩니다.')) return;

    try {
      const response = await api.post('/admin/user/reset-password/', { user_id: userId });
      setResetPasswordResult({
        username: response.data.username,
        temporary_password: response.data.temporary_password,
      });
      fetchUserProfiles(); // 목록 새로고침
    } catch (error: any) {
      console.error('Password reset failed:', error);
      const errorMessage = error?.response?.data?.error || error?.response?.data?.detail || error?.message || '비밀번호 리셋 중 오류가 발생했습니다.';
      alert(errorMessage);
    }
  };

  if (loading) {
    return <div className="p-6">Loading...</div>;
  }

  const pendingRequests = requests.filter(req => req.status === 'pending');

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">사용자 관리</h1>

      <div className="mb-6">
        <Card>
          <CardContent className="py-6">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex items-start gap-3">
                <Shield className="mt-1 h-6 w-6 text-blue-600" />
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">승인 포털 안내</h3>
                  <p className="text-sm text-gray-600">
                    브라우저에서 승인 요청이 차단될 경우, 아래 버튼을 눌러 백엔드 전용 포털에서 직접 승인할 수 있습니다.
                  </p>
                </div>
              </div>
              <Button
                className="bg-blue-600 text-white hover:bg-blue-700"
                onClick={() => window.open(backendApprovalUrl, '_blank', 'noopener,noreferrer')}
              >
                백엔드 승인 포털 열기
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* 승인 결과 모달 */}
      {approvalResult && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-semibold mb-4">가입 승인 완료</h3>
            <div className="space-y-2">
              <p><strong>사용자명:</strong> {approvalResult.username}</p>
              <p><strong>임시 비밀번호:</strong>
                <code className="bg-gray-100 px-2 py-1 rounded ml-2">
                  {approvalResult.temporary_password}
                </code>
              </p>
            </div>
            <div className="flex gap-2 mt-4">
              <Button
                onClick={() => {
                  navigator.clipboard.writeText(approvalResult.temporary_password);
                  alert('임시 비밀번호가 클립보드에 복사되었습니다.');
                }}
                variant="secondary"
                className="flex-1"
              >
                비밀번호 복사
              </Button>
              <Button
                onClick={() => setApprovalResult(null)}
                className="flex-1"
              >
                확인
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 비밀번호 리셋 결과 모달 */}
      {resetPasswordResult && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg p-6 w-full max-w-md mx-4">
            <h3 className="text-lg font-semibold mb-4">비밀번호 리셋 완료</h3>
            <div className="space-y-2">
              <p><strong>사용자명:</strong> {resetPasswordResult.username}</p>
              <p><strong>새 임시 비밀번호:</strong>
                <code className="bg-gray-100 px-2 py-1 rounded ml-2">
                  {resetPasswordResult.temporary_password}
                </code>
              </p>
            </div>
            <div className="flex gap-2 mt-4">
              <Button
                onClick={() => {
                  navigator.clipboard.writeText(resetPasswordResult.temporary_password);
                  alert('임시 비밀번호가 클립보드에 복사되었습니다.');
                }}
                variant="secondary"
                className="flex-1"
              >
                비밀번호 복사
              </Button>
              <Button
                onClick={() => setResetPasswordResult(null)}
                className="flex-1"
              >
                확인
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* 대기 중인 요청 목록 */}
      <div className="space-y-4">
        <h2 className="text-xl font-semibold">대기 중인 가입 요청 ({pendingRequests.length}건)</h2>

        {pendingRequests.length === 0 ? (
          <Card>
            <CardContent className="p-6 text-center text-gray-500">
              대기 중인 가입 요청이 없습니다.
            </CardContent>
          </Card>
        ) : (
          pendingRequests.map(request => (
            <Card key={request.id}>
              <CardContent className="p-6">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
                  <div>
                    <p><strong>성명:</strong> {request.full_name}</p>
                    <p><strong>부서:</strong> {request.department}</p>
                    <p><strong>이메일:</strong> {request.email}</p>
                  </div>
                  <div>
                    <p><strong>요청일:</strong> {new Date(request.created_at).toLocaleString()}</p>
                  </div>
                </div>

                {selectedRequest?.id === request.id && (
                  <div className="mt-4 p-4 border border-gray-200 rounded-lg bg-gray-50">
                    <h4 className="font-semibold mb-3">권한 설정</h4>
                    <div className="space-y-2">
                        {permissionOptions.map(({ key, label }) => (
                          <label key={key} className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 hover:border-blue-400 hover:bg-blue-50 transition-colors">
                            <span className="text-sm font-medium text-gray-700">{label}</span>
                            <input
                              type="checkbox"
                              checked={(permissions as any)[key]}
                              onChange={(e) => handlePermissionChange(key, e.target.checked)}
                              className="w-5 h-5 text-blue-600 rounded focus:ring-blue-500"
                            />
                          </label>
                        ))}
                      </div>
                  </div>
                )}

                <div className="flex gap-2 mt-4">
                  {selectedRequest?.id === request.id ? (
                    <>
                      <Button
                        onClick={() => handleApprove(request.id)}
                        className="flex-1"
                      >
                        승인
                      </Button>
                      <Button
                        onClick={() => handleReject(request.id)}
                        variant="danger"
                        className="flex-1"
                      >
                        거부
                      </Button>
                      <Button
                        onClick={() => setSelectedRequest(null)}
                        variant="secondary"
                        className="flex-1"
                      >
                        취소
                      </Button>
                    </>
                  ) : (
                    <Button
                      onClick={() => setSelectedRequest(request)}
                      variant="secondary"
                      className="flex-1"
                    >
                      권한 설정 및 처리
                    </Button>
                  )}
                </div>
              </CardContent>
            </Card>
          ))
        )}
      </div>

      {/* 기존 사용자 권한 관리 */}
      <div className="mt-8">
        <div className="flex items-center gap-2 mb-6">
          <Users className="w-5 h-5 text-gray-600" />
          <h2 className="text-xl font-semibold">사용자 권한 관리</h2>
          <span className="text-sm text-gray-500">({userProfiles.length}명)</span>
        </div>

        <div className="bg-white rounded-lg shadow overflow-hidden">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  사용자 정보
                </th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  권한 요약
                </th>
                <th className="px-6 py-3 text-center text-xs font-medium text-gray-500 uppercase tracking-wider">
                  작업
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {userProfiles.map(profile => (
                <tr key={profile.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4 whitespace-nowrap">
                    <div className="flex items-center">
                      <div className="flex-shrink-0 h-10 w-10">
                        <div className="h-10 w-10 rounded-full bg-gray-300 flex items-center justify-center">
                          <User className="w-5 h-5 text-gray-600" />
                        </div>
                      </div>
                      <div className="ml-4">
                        <div className="text-sm font-medium text-gray-900">
                          {profile.first_name || profile.username}
                        </div>
                        <div className="text-sm text-gray-500">
                          {profile.email}
                        </div>
                      </div>
                    </div>
                  </td>
                  <td className="px-6 py-4">
                    <div className="text-sm text-gray-900">
                      {getPermissionSummary(profile)}
                    </div>
                  </td>
                  <td className="px-6 py-4 whitespace-nowrap text-center">
                    <div className="flex items-center justify-center space-x-2">
                      <Button
                        onClick={() => handleEditUserPermissions(profile)}
                        size="sm"
                        variant="ghost"
                        className="text-blue-600 hover:text-blue-800 hover:bg-blue-50"
                      >
                        <Edit className="w-4 h-4 mr-1" />
                        권한 수정
                      </Button>
                      <Button
                        onClick={() => handleResetPassword(profile.user)}
                        size="sm"
                        variant="ghost"
                        className="text-orange-600 hover:text-orange-800 hover:bg-orange-50"
                      >
                        <RotateCcw className="w-4 h-4 mr-1" />
                        비밀번호 재설정
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* 권한 편집 모달 */}
        {selectedProfile && (
          <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
            <div className="bg-white rounded-lg p-6 w-full max-w-2xl mx-4 max-h-[80vh] overflow-y-auto">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-semibold">
                  {selectedProfile.first_name || selectedProfile.username} - 권한 수정
                </h3>
                <Button
                  onClick={() => setSelectedProfile(null)}
                  variant="ghost"
                  size="sm"
                >
                  ×
                </Button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div className="md:col-span-2">
                  <h5 className="font-semibold mb-3 text-gray-800">권한 설정</h5>
                  <div className="space-y-2">
                    {permissionOptions.map(({ key, label }) => (
                      <label key={key} className="flex items-center justify-between rounded-lg border border-gray-200 px-4 py-3 hover:border-blue-400 hover:bg-blue-50 transition-colors">
                        <span className="text-sm font-medium text-gray-700">{label}</span>
                        <input
                          type="checkbox"
                          checked={(editingPermissions as any)[key]}
                          onChange={(e) => handleEditingPermissionChange(key, e.target.checked)}
                          className="w-5 h-5 text-blue-600 rounded focus:ring-blue-500"
                        />
                      </label>
                    ))}
                  </div>
                </div>
              </div>

              <div className="flex gap-3 mt-6 pt-4 border-t">
                <Button onClick={handleUpdateUserPermissions} className="flex-1">
                  <CheckCircle className="w-4 h-4 mr-2" />
                  저장
                </Button>
                <Button
                  onClick={() => setSelectedProfile(null)}
                  variant="secondary"
                  className="flex-1"
                >
                  <XCircle className="w-4 h-4 mr-2" />
                  취소
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
