import { useState, useEffect } from 'react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';
import { api } from '../../lib/api';
import { CheckCircle, XCircle, Edit, RotateCcw, User, Users } from 'lucide-react';

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

  // 권한 요약 함수
  const getPermissionSummary = (profile: UserProfile) => {
    const permissions = [];
    
    if (profile.can_view_injection || profile.can_edit_injection) {
      const injection = profile.can_edit_injection ? '사출(편집)' : '사출(조회)';
      permissions.push(injection);
    }
    
    if (profile.can_view_machining || profile.can_edit_machining) {
      const assembly = profile.can_edit_machining ? '조립(편집)' : '조립(조회)';
      permissions.push(assembly);
    }
    
    if (profile.can_view_eco || profile.can_edit_eco) {
      const eco = profile.can_edit_eco ? 'ECO(편집)' : 'ECO(조회)';
      permissions.push(eco);
    }
    
    if (profile.can_view_inventory || profile.can_edit_inventory) {
      const inventory = profile.can_edit_inventory ? '영업/재고(편집)' : '영업/재고(조회)';
      permissions.push(inventory);
    }
    
    return permissions.length > 0 ? permissions.join(', ') : '권한 없음';
  };

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
      console.log('Sending permissions:', permissions);
      const response = await api.post(`/signup-requests/${requestId}/approve/`, { permissions });
      
      setApprovalResult({
        username: response.data.username,
        temporary_password: response.data.temporary_password,
      });
      
      // 권한 초기화
      setPermissions({
        can_view_injection: false,
        can_edit_injection: false,
        can_view_machining: false,
        can_edit_machining: false,
        can_view_eco: false,
        can_edit_eco: false,
        can_view_inventory: false,
        can_edit_inventory: false,
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
                            사출 (/injection) 조회 권한
                          </label>
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={permissions.can_edit_injection}
                              onChange={(e) => handlePermissionChange('can_edit_injection', e.target.checked)}
                              className="mr-2"
                            />
                            사출 (/injection) 편집 권한
                          </label>
                        </div>
                      </div>
                      
                      <div>
                        <h5 className="font-medium mb-2">조립 관련</h5>
                        <div className="space-y-2">
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={permissions.can_view_machining}
                              onChange={(e) => handlePermissionChange('can_view_machining', e.target.checked)}
                              className="mr-2"
                            />
                            조립 (/assembly) 조회 권한
                          </label>
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={permissions.can_edit_machining}
                              onChange={(e) => handlePermissionChange('can_edit_machining', e.target.checked)}
                              className="mr-2"
                            />
                            조립 (/assembly) 편집 권한
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
                            ECO (/eco) 조회 권한
                          </label>
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={permissions.can_edit_eco}
                              onChange={(e) => handlePermissionChange('can_edit_eco', e.target.checked)}
                              className="mr-2"
                            />
                            ECO (/eco) 편집 권한
                          </label>
                        </div>
                      </div>
                      
                      <div>
                        <h5 className="font-medium mb-2">영업/재고 관련</h5>
                        <div className="space-y-2">
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={permissions.can_view_inventory}
                              onChange={(e) => handlePermissionChange('can_view_inventory', e.target.checked)}
                              className="mr-2"
                            />
                            영업/재고 (/sales) 조회 권한
                          </label>
                          <label className="flex items-center">
                            <input
                              type="checkbox"
                              checked={permissions.can_edit_inventory}
                              onChange={(e) => handlePermissionChange('can_edit_inventory', e.target.checked)}
                              className="mr-2"
                            />
                            영업/재고 (/sales) 편집 권한
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
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
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
                <div>
                  <h5 className="font-semibold mb-3 text-gray-800">사출 관련</h5>
                  <div className="space-y-3">
                    <label className="flex items-center p-2 hover:bg-gray-50 rounded">
                      <input
                        type="checkbox"
                        checked={editingPermissions.can_view_injection}
                        onChange={(e) => handleEditingPermissionChange('can_view_injection', e.target.checked)}
                        className="mr-3 w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                      />
                      <span className="text-sm">사출 (/injection) 조회 권한</span>
                    </label>
                    <label className="flex items-center p-2 hover:bg-gray-50 rounded">
                      <input
                        type="checkbox"
                        checked={editingPermissions.can_edit_injection}
                        onChange={(e) => handleEditingPermissionChange('can_edit_injection', e.target.checked)}
                        className="mr-3 w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                      />
                      <span className="text-sm">사출 (/injection) 편집 권한</span>
                    </label>
                  </div>
                </div>
                
                <div>
                  <h5 className="font-semibold mb-3 text-gray-800">조립 관련</h5>
                  <div className="space-y-3">
                    <label className="flex items-center p-2 hover:bg-gray-50 rounded">
                      <input
                        type="checkbox"
                        checked={editingPermissions.can_view_machining}
                        onChange={(e) => handleEditingPermissionChange('can_view_machining', e.target.checked)}
                        className="mr-3 w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                      />
                      <span className="text-sm">조립 (/assembly) 조회 권한</span>
                    </label>
                    <label className="flex items-center p-2 hover:bg-gray-50 rounded">
                      <input
                        type="checkbox"
                        checked={editingPermissions.can_edit_machining}
                        onChange={(e) => handleEditingPermissionChange('can_edit_machining', e.target.checked)}
                        className="mr-3 w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                      />
                      <span className="text-sm">조립 (/assembly) 편집 권한</span>
                    </label>
                  </div>
                </div>
                
                <div>
                  <h5 className="font-semibold mb-3 text-gray-800">ECO 관련</h5>
                  <div className="space-y-3">
                    <label className="flex items-center p-2 hover:bg-gray-50 rounded">
                      <input
                        type="checkbox"
                        checked={editingPermissions.can_view_eco}
                        onChange={(e) => handleEditingPermissionChange('can_view_eco', e.target.checked)}
                        className="mr-3 w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                      />
                      <span className="text-sm">ECO (/eco) 조회 권한</span>
                    </label>
                    <label className="flex items-center p-2 hover:bg-gray-50 rounded">
                      <input
                        type="checkbox"
                        checked={editingPermissions.can_edit_eco}
                        onChange={(e) => handleEditingPermissionChange('can_edit_eco', e.target.checked)}
                        className="mr-3 w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                      />
                      <span className="text-sm">ECO (/eco) 편집 권한</span>
                    </label>
                  </div>
                </div>
                
                <div>
                  <h5 className="font-semibold mb-3 text-gray-800">영업/재고 관련</h5>
                  <div className="space-y-3">
                    <label className="flex items-center p-2 hover:bg-gray-50 rounded">
                      <input
                        type="checkbox"
                        checked={editingPermissions.can_view_inventory}
                        onChange={(e) => handleEditingPermissionChange('can_view_inventory', e.target.checked)}
                        className="mr-3 w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                      />
                      <span className="text-sm">영업/재고 (/sales) 조회 권한</span>
                    </label>
                    <label className="flex items-center p-2 hover:bg-gray-50 rounded">
                      <input
                        type="checkbox"
                        checked={editingPermissions.can_edit_inventory}
                        onChange={(e) => handleEditingPermissionChange('can_edit_inventory', e.target.checked)}
                        className="mr-3 w-4 h-4 text-blue-600 rounded focus:ring-blue-500"
                      />
                      <span className="text-sm">영업/재고 (/sales) 편집 권한</span>
                    </label>
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