import { useState, useEffect } from 'react';
import { Card, CardContent } from '../../components/ui/card';
import { Button } from '../../components/ui/button';

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

export default function UserApproval() {
  const [requests, setRequests] = useState<SignupRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [approvalResult, setApprovalResult] = useState<ApprovalResult | null>(null);
  const [selectedRequest, setSelectedRequest] = useState<SignupRequest | null>(null);
  
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
      const response = await fetch('/api/signup-requests/', {
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
        },
      });
      if (response.ok) {
        const data = await response.json();
        setRequests(data.results || data);
      }
    } catch (error) {
      console.error('Failed to fetch signup requests:', error);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRequests();
  }, []);

  // 가입 승인
  const handleApprove = async (requestId: number) => {
    try {
      const response = await fetch(`/api/signup-requests/${requestId}/approve/`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ permissions }),
      });

      if (response.ok) {
        const result = await response.json();
        setApprovalResult({
          username: result.username,
          temporary_password: result.temporary_password,
        });
        fetchRequests(); // 목록 새로고침
        setSelectedRequest(null);
      } else {
        alert('승인 처리 중 오류가 발생했습니다.');
      }
    } catch (error) {
      console.error('Approval failed:', error);
      alert('승인 처리 중 오류가 발생했습니다.');
    }
  };

  // 가입 거부
  const handleReject = async (requestId: number) => {
    if (!confirm('정말 이 가입 요청을 거부하시겠습니까?')) return;

    try {
      const response = await fetch(`/api/signup-requests/${requestId}/reject/`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${localStorage.getItem('access_token')}`,
        },
      });

      if (response.ok) {
        alert('가입 요청이 거부되었습니다.');
        fetchRequests(); // 목록 새로고침
        setSelectedRequest(null);
      } else {
        alert('거부 처리 중 오류가 발생했습니다.');
      }
    } catch (error) {
      console.error('Rejection failed:', error);
      alert('거부 처리 중 오류가 발생했습니다.');
    }
  };

  // 권한 체크박스 변경
  const handlePermissionChange = (key: string, value: boolean) => {
    setPermissions(prev => ({
      ...prev,
      [key]: value
    }));
  };

  if (loading) {
    return <div className="p-6">Loading...</div>;
  }

  const pendingRequests = requests.filter(req => req.status === 'pending');

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <h1 className="text-2xl font-bold mb-6">가입 요청 관리</h1>

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