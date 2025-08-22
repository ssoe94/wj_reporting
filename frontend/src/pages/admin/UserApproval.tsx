import { useState, useEffect } from 'react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { api } from '../../lib/api';

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
  can_edit_injection: boolean;
  can_view_machining: boolean;
  can_edit_machining: boolean;
  can_view_eco: boolean;
  can_edit_eco: boolean;
  can_view_inventory: boolean;
  can_edit_inventory: boolean;
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
  
  // 권한 설정 상태
  const [permissions, setPermissions] = useState({
    can_view_injection: false,
    can_edit_injection: false,
    can_view_machining: false,
    can_edit_machining: false,
    can_view_eco: false,
    can_edit_eco: false,
    can_view_inventory: false,
    can_edit_inventory: false,
  });

  // 가입 요청 목록 가져오기
  const fetchRequests = async () => {
    try {
      const response = await api.get('/signup-requests/');
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
      const response = await api.get('/user-profiles/');
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
      const response = await api.post(`/signup-requests/${requestId}/approve/`, { permissions });
      setApprovalResult({
        username: response.data.username,
        temporary_password: response.data.temporary_password,
      });
      fetchRequests(); // 목록 새로고침
      setSelectedRequest(null);
    } catch (error: any) {
      console.error('Approval failed:', error);
      const errorMessage = error?.response?.data?.error || error?.response?.data?.detail || error?.message || '승인 처리 중 오류가 발생했습니다.';
      alert(errorMessage);
    }
  };

  // 가입 거부
  const handleReject = async (requestId: number) => {
    if (!confirm('정말 이 가입 요청을 거부하시겠습니까?')) return;

    try {
      await api.post(`/signup-requests/${requestId}/reject/`);
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
      can_view_injection: profile.can_view_injection,
      can_edit_injection: profile.can_edit_injection,
      can_view_machining: profile.can_view_machining,
      can_edit_machining: profile.can_edit_machining,
      can_view_eco: profile.can_view_eco,
      can_edit_eco: profile.can_edit_eco,
      can_view_inventory: profile.can_view_inventory,
      can_edit_inventory: profile.can_edit_inventory,
    });
  };

  // 사용자 권한 수정 저장
  const handleUpdateUserPermissions = async () => {
    if (!selectedProfile) return;

    try {
      await api.patch(`/user-profiles/${selectedProfile.id}/`, editingPermissions);
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
      const response = await api.post('/user/reset-password/', { user_id: userId });
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

      {/* 승인 결과 모달 */}
      {approvalResult && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
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
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
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
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <h5 className="font-medium mb-2">사출 관련</h5>
                        <div className="space-y-2">
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={permissions.can_view_injection}
                              onChange={(e) => handlePermissionChange('can_view_injection', e.target.checked)}
                              className="mr-2"
                            />
                            사출 조회 권한
                          </label>
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={permissions.can_edit_injection}
                              onChange={(e) => handlePermissionChange('can_edit_injection', e.target.checked)}
                              className="mr-2"
                            />
                            사출 편집 권한
                          </label>
                        </div>
                      </div>
                      
                      <div>
                        <h5 className="font-medium mb-2">가공 관련</h5>
                        <div className="space-y-2">
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={permissions.can_view_machining}
                              onChange={(e) => handlePermissionChange('can_view_machining', e.target.checked)}
                              className="mr-2"
                            />
                            가공 조회 권한
                          </label>
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={permissions.can_edit_machining}
                              onChange={(e) => handlePermissionChange('can_edit_machining', e.target.checked)}
                              className="mr-2"
                            />
                            가공 편집 권한
                          </label>
                        </div>
                      </div>
                      
                      <div>
                        <h5 className="font-medium mb-2">ECO 관련</h5>
                        <div className="space-y-2">
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={permissions.can_view_eco}
                              onChange={(e) => handlePermissionChange('can_view_eco', e.target.checked)}
                              className="mr-2"
                            />
                            ECO 조회 권한
                          </label>
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={permissions.can_edit_eco}
                              onChange={(e) => handlePermissionChange('can_edit_eco', e.target.checked)}
                              className="mr-2"
                            />
                            ECO 편집 권한
                          </label>
                        </div>
                      </div>
                      
                      <div>
                        <h5 className="font-medium mb-2">재고 관련</h5>
                        <div className="space-y-2">
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={permissions.can_view_inventory}
                              onChange={(e) => handlePermissionChange('can_view_inventory', e.target.checked)}
                              className="mr-2"
                            />
                            재고 조회 권한
                          </label>
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={permissions.can_edit_inventory}
                              onChange={(e) => handlePermissionChange('can_edit_inventory', e.target.checked)}
                              className="mr-2"
                            />
                            재고 편집 권한
                          </label>
                        </div>
                      </div>
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
        <h2 className="text-xl font-semibold mb-4">기존 사용자 권한 관리</h2>
        <div className="space-y-4">
          {userProfiles.map(profile => (
            <Card key={profile.id}>
              <CardContent className="p-6">
                <div className="flex justify-between items-start mb-4">
                  <div>
                    <h3 className="font-medium">{profile.first_name || profile.username}</h3>
                    <p className="text-gray-500">사용자명: {profile.username}</p>
                    <p className="text-gray-500">이메일: {profile.email}</p>
                  </div>
                  <div className="text-right">
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <span className={`px-2 py-1 rounded ${profile.can_view_injection ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                        사출조회
                      </span>
                      <span className={`px-2 py-1 rounded ${profile.can_edit_injection ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>
                        사출편집
                      </span>
                      <span className={`px-2 py-1 rounded ${profile.can_view_eco ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                        ECO조회
                      </span>
                      <span className={`px-2 py-1 rounded ${profile.can_edit_eco ? 'bg-blue-100 text-blue-800' : 'bg-gray-100 text-gray-600'}`}>
                        ECO편집
                      </span>
                    </div>
                  </div>
                </div>

                {selectedProfile?.id === profile.id && (
                  <div className="mt-4 p-4 border border-gray-200 rounded-lg bg-gray-50">
                    <h4 className="font-semibold mb-3">권한 수정</h4>
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <h5 className="font-medium mb-2">사출 관련</h5>
                        <div className="space-y-2">
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={editingPermissions.can_view_injection}
                              onChange={(e) => handleEditingPermissionChange('can_view_injection', e.target.checked)}
                              className="mr-2"
                            />
                            사출 조회 권한
                          </label>
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={editingPermissions.can_edit_injection}
                              onChange={(e) => handleEditingPermissionChange('can_edit_injection', e.target.checked)}
                              className="mr-2"
                            />
                            사출 편집 권한
                          </label>
                        </div>
                      </div>
                      
                      <div>
                        <h5 className="font-medium mb-2">가공 관련</h5>
                        <div className="space-y-2">
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={editingPermissions.can_view_machining}
                              onChange={(e) => handleEditingPermissionChange('can_view_machining', e.target.checked)}
                              className="mr-2"
                            />
                            가공 조회 권한
                          </label>
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={editingPermissions.can_edit_machining}
                              onChange={(e) => handleEditingPermissionChange('can_edit_machining', e.target.checked)}
                              className="mr-2"
                            />
                            가공 편집 권한
                          </label>
                        </div>
                      </div>
                      
                      <div>
                        <h5 className="font-medium mb-2">ECO 관련</h5>
                        <div className="space-y-2">
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={editingPermissions.can_view_eco}
                              onChange={(e) => handleEditingPermissionChange('can_view_eco', e.target.checked)}
                              className="mr-2"
                            />
                            ECO 조회 권한
                          </label>
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={editingPermissions.can_edit_eco}
                              onChange={(e) => handleEditingPermissionChange('can_edit_eco', e.target.checked)}
                              className="mr-2"
                            />
                            ECO 편집 권한
                          </label>
                        </div>
                      </div>
                      
                      <div>
                        <h5 className="font-medium mb-2">재고 관련</h5>
                        <div className="space-y-2">
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={editingPermissions.can_view_inventory}
                              onChange={(e) => handleEditingPermissionChange('can_view_inventory', e.target.checked)}
                              className="mr-2"
                            />
                            재고 조회 권한
                          </label>
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={editingPermissions.can_edit_inventory}
                              onChange={(e) => handleEditingPermissionChange('can_edit_inventory', e.target.checked)}
                              className="mr-2"
                            />
                            재고 편집 권한
                          </label>
                        </div>
                      </div>
                    </div>
                    
                    <div className="flex gap-2 mt-4">
                      <Button onClick={handleUpdateUserPermissions} className="flex-1">
                        권한 수정 저장
                      </Button>
                      <Button 
                        onClick={() => setSelectedProfile(null)} 
                        variant="secondary" 
                        className="flex-1"
                      >
                        취소
                      </Button>
                    </div>
                  </div>
                )}

                <div className="flex gap-2 mt-4">
                  {selectedProfile?.id === profile.id ? null : (
                    <>
                      <Button
                        onClick={() => handleEditUserPermissions(profile)}
                        variant="secondary"
                        className="flex-1"
                      >
                        권한 수정
                      </Button>
                      <Button
                        onClick={() => handleResetPassword(profile.user)}
                        variant="outline"
                        className="flex-1"
                      >
                        비밀번호 리셋
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* 처리된 요청 목록 */}
      <div className="mt-8">
        <h2 className="text-xl font-semibold mb-4">처리된 요청</h2>
        {requests.filter(req => req.status !== 'pending').map(request => (
          <Card key={request.id} className="mb-2">
            <CardContent className="p-4">
              <div className="flex justify-between items-center">
                <div>
                  <span className="font-medium">{request.full_name}</span>
                  <span className="text-gray-500 ml-2">({request.email})</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className={`px-2 py-1 rounded text-sm ${
                    request.status === 'approved' 
                      ? 'bg-green-100 text-green-800' 
                      : 'bg-red-100 text-red-800'
                  }`}>
                    {request.status === 'approved' ? '승인됨' : '거부됨'}
                  </span>
                  <span className="text-sm text-gray-500">
                    {new Date(request.created_at).toLocaleDateString()}
                  </span>
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}