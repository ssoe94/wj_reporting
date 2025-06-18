// import React from 'react';
import { useForm } from 'react-hook-form';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import { toast } from 'react-toastify';

interface InjectionFormData {
  date: string;
  tonnage: string;
  model: string;
  section: string;
  plan_qty: number;
  actual_qty: number;
  reported_defect: number;
  actual_defect: number;
  operation_time: number;
  total_time: number;
  note: string;
}

const NewRecordPage: React.FC = () => {
  const navigate = useNavigate();
  const { register, handleSubmit, formState: { errors } } = useForm<InjectionFormData>();

  const onSubmit = async (data: InjectionFormData) => {
    try {
      await axios.post(`${import.meta.env.VITE_APP_API_URL}/api/reports/`, data);
      toast.success('생산 기록이 성공적으로 저장되었습니다.');
      navigate('/records');
    } catch (error) {
      toast.error('생산 기록 저장에 실패했습니다.');
      console.error('Error:', error);
    }
  };

  return (
    <div className="max-w-xl mx-auto bg-white rounded-xl shadow-md p-8 mt-8">
      <h1 className="text-3xl font-bold mb-8 text-center text-blue-700">새 사출 생산 기록</h1>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-5">
        {/* 날짜 */}
        <div>
          <label className="block text-gray-700 font-medium mb-1">생산일자</label>
          <input type="date" {...register('date', { required: '생산일자를 선택해주세요' })} className="input input-bordered w-full" />
          {errors.date && <span className="text-error text-sm">{errors.date.message}</span>}
        </div>
        {/* 톤수 */}
        <div>
          <label className="block text-gray-700 font-medium mb-1">톤수</label>
          <input type="text" {...register('tonnage', { required: '톤수를 입력해주세요' })} placeholder="예: 850T" className="input input-bordered w-full" />
          {errors.tonnage && <span className="text-error text-sm">{errors.tonnage.message}</span>}
        </div>
        {/* 모델명 */}
        <div>
          <label className="block text-gray-700 font-medium mb-1">모델명</label>
          <input type="text" {...register('model', { required: '모델명을 입력해주세요' })} placeholder="예: 24TL510" className="input input-bordered w-full" />
          {errors.model && <span className="text-error text-sm">{errors.model.message}</span>}
        </div>
        {/* 구분 */}
        <div>
          <label className="block text-gray-700 font-medium mb-1">구분</label>
          <select {...register('section', { required: '구분을 선택해주세요' })} className="select select-bordered w-full">
            <option value="">선택해주세요</option>
            <option value="C/A">C/A</option>
            <option value="B/C">B/C</option>
            <option value="COVER">COVER</option>
          </select>
          {errors.section && <span className="text-error text-sm">{errors.section.message}</span>}
        </div>
        {/* 계획수량 */}
        <div>
          <label className="block text-gray-700 font-medium mb-1">계획수량</label>
          <input type="number" {...register('plan_qty', { required: '계획수량을 입력해주세요', min: { value: 0, message: '0 이상의 값을 입력해주세요' } })} className="input input-bordered w-full" />
          {errors.plan_qty && <span className="text-error text-sm">{errors.plan_qty.message}</span>}
        </div>
        {/* 실제수량 */}
        <div>
          <label className="block text-gray-700 font-medium mb-1">실제수량</label>
          <input type="number" {...register('actual_qty', { required: '실제수량을 입력해주세요', min: { value: 0, message: '0 이상의 값을 입력해주세요' } })} className="input input-bordered w-full" />
          {errors.actual_qty && <span className="text-error text-sm">{errors.actual_qty.message}</span>}
        </div>
        {/* 보고불량수 */}
        <div>
          <label className="block text-gray-700 font-medium mb-1">보고불량수</label>
          <input type="number" {...register('reported_defect', { required: '보고불량수를 입력해주세요', min: { value: 0, message: '0 이상의 값을 입력해주세요' } })} className="input input-bordered w-full" />
          {errors.reported_defect && <span className="text-error text-sm">{errors.reported_defect.message}</span>}
        </div>
        {/* 실제불량수 */}
        <div>
          <label className="block text-gray-700 font-medium mb-1">실제불량수</label>
          <input type="number" {...register('actual_defect', { required: '실제불량수를 입력해주세요', min: { value: 0, message: '0 이상의 값을 입력해주세요' } })} className="input input-bordered w-full" />
          {errors.actual_defect && <span className="text-error text-sm">{errors.actual_defect.message}</span>}
        </div>
        {/* 가동시간 */}
        <div>
          <label className="block text-gray-700 font-medium mb-1">가동시간 (분)</label>
          <input type="number" {...register('operation_time', { required: '가동시간을 입력해주세요', min: { value: 0, message: '0 이상의 값을 입력해주세요' } })} className="input input-bordered w-full" />
          {errors.operation_time && <span className="text-error text-sm">{errors.operation_time.message}</span>}
        </div>
        {/* 총시간 */}
        <div>
          <label className="block text-gray-700 font-medium mb-1">총시간 (분)</label>
          <input type="number" {...register('total_time', { required: '총시간을 입력해주세요', min: { value: 0, message: '0 이상의 값을 입력해주세요' } })} defaultValue={1440} className="input input-bordered w-full" />
          {errors.total_time && <span className="text-error text-sm">{errors.total_time.message}</span>}
        </div>
        {/* 비고 */}
        <div>
          <label className="block text-gray-700 font-medium mb-1">비고</label>
          <textarea {...register('note')} className="textarea textarea-bordered w-full min-h-[80px]" placeholder="조정시간, 금형교체 시간 등을 입력해주세요" />
        </div>
        {/* 버튼 */}
        <div className="flex gap-4 justify-end pt-2">
          <button type="submit" className="btn btn-primary px-6 py-2 rounded-lg shadow font-semibold">저장하기</button>
          <button type="button" onClick={() => navigate('/records')} className="btn btn-ghost px-6 py-2 rounded-lg font-semibold">취소</button>
        </div>
      </form>
    </div>
  );
};

export default NewRecordPage; 