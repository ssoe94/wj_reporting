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
      await axios.post('${process.env.REACT_APP_API_URL}/api/reports/', data);
      toast.success('생산 기록이 성공적으로 저장되었습니다.');
      navigate('/records');
    } catch (error) {
      toast.error('생산 기록 저장에 실패했습니다.');
      console.error('Error:', error);
    }
  };

  return (
    <div className="container mx-auto px-4 py-8">
      <h1 className="text-2xl font-bold mb-6">새 사출 생산 기록</h1>
      
      <form onSubmit={handleSubmit(onSubmit)} className="max-w-2xl">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* 날짜 */}
          <div className="form-control">
            <label className="label">
              <span className="label-text">생산일자</span>
            </label>
            <input
              type="date"
              {...register('date', { required: '생산일자를 선택해주세요' })}
              className="input input-bordered w-full"
            />
            {errors.date && <span className="text-error text-sm">{errors.date.message}</span>}
          </div>

          {/* 톤수 */}
          <div className="form-control">
            <label className="label">
              <span className="label-text">톤수</span>
            </label>
            <input
              type="text"
              {...register('tonnage', { required: '톤수를 입력해주세요' })}
              placeholder="예: 850T"
              className="input input-bordered w-full"
            />
            {errors.tonnage && <span className="text-error text-sm">{errors.tonnage.message}</span>}
          </div>

          {/* 모델명 */}
          <div className="form-control">
            <label className="label">
              <span className="label-text">모델명</span>
            </label>
            <input
              type="text"
              {...register('model', { required: '모델명을 입력해주세요' })}
              placeholder="예: 24TL510"
              className="input input-bordered w-full"
            />
            {errors.model && <span className="text-error text-sm">{errors.model.message}</span>}
          </div>

          {/* 구분 */}
          <div className="form-control">
            <label className="label">
              <span className="label-text">구분</span>
            </label>
            <select
              {...register('section', { required: '구분을 선택해주세요' })}
              className="select select-bordered w-full"
            >
              <option value="">선택해주세요</option>
              <option value="C/A">C/A</option>
              <option value="B/C">B/C</option>
              <option value="COVER">COVER</option>
            </select>
            {errors.section && <span className="text-error text-sm">{errors.section.message}</span>}
          </div>

          {/* 계획수량 */}
          <div className="form-control">
            <label className="label">
              <span className="label-text">계획수량</span>
            </label>
            <input
              type="number"
              {...register('plan_qty', {
                required: '계획수량을 입력해주세요',
                min: { value: 0, message: '0 이상의 값을 입력해주세요' }
              })}
              className="input input-bordered w-full"
            />
            {errors.plan_qty && <span className="text-error text-sm">{errors.plan_qty.message}</span>}
          </div>

          {/* 실제수량 */}
          <div className="form-control">
            <label className="label">
              <span className="label-text">실제수량</span>
            </label>
            <input
              type="number"
              {...register('actual_qty', {
                required: '실제수량을 입력해주세요',
                min: { value: 0, message: '0 이상의 값을 입력해주세요' }
              })}
              className="input input-bordered w-full"
            />
            {errors.actual_qty && <span className="text-error text-sm">{errors.actual_qty.message}</span>}
          </div>

          {/* 보고불량수 */}
          <div className="form-control">
            <label className="label">
              <span className="label-text">보고불량수</span>
            </label>
            <input
              type="number"
              {...register('reported_defect', {
                required: '보고불량수를 입력해주세요',
                min: { value: 0, message: '0 이상의 값을 입력해주세요' }
              })}
              className="input input-bordered w-full"
            />
            {errors.reported_defect && <span className="text-error text-sm">{errors.reported_defect.message}</span>}
          </div>

          {/* 실제불량수 */}
          <div className="form-control">
            <label className="label">
              <span className="label-text">실제불량수</span>
            </label>
            <input
              type="number"
              {...register('actual_defect', {
                required: '실제불량수를 입력해주세요',
                min: { value: 0, message: '0 이상의 값을 입력해주세요' }
              })}
              className="input input-bordered w-full"
            />
            {errors.actual_defect && <span className="text-error text-sm">{errors.actual_defect.message}</span>}
          </div>

          {/* 가동시간 */}
          <div className="form-control">
            <label className="label">
              <span className="label-text">가동시간 (분)</span>
            </label>
            <input
              type="number"
              {...register('operation_time', {
                required: '가동시간을 입력해주세요',
                min: { value: 0, message: '0 이상의 값을 입력해주세요' }
              })}
              className="input input-bordered w-full"
            />
            {errors.operation_time && <span className="text-error text-sm">{errors.operation_time.message}</span>}
          </div>

          {/* 총시간 */}
          <div className="form-control">
            <label className="label">
              <span className="label-text">총시간 (분)</span>
            </label>
            <input
              type="number"
              {...register('total_time', {
                required: '총시간을 입력해주세요',
                min: { value: 0, message: '0 이상의 값을 입력해주세요' }
              })}
              defaultValue={1440}
              className="input input-bordered w-full"
            />
            {errors.total_time && <span className="text-error text-sm">{errors.total_time.message}</span>}
          </div>
        </div>

        {/* 비고 */}
        <div className="form-control mt-4">
          <label className="label">
            <span className="label-text">비고</span>
          </label>
          <textarea
            {...register('note')}
            className="textarea textarea-bordered h-24"
            placeholder="조정시간, 금형교체 시간 등을 입력해주세요"
          />
        </div>

        {/* 버튼 */}
        <div className="mt-6 flex gap-4">
          <button type="submit" className="btn btn-primary">
            저장하기
          </button>
          <button
            type="button"
            onClick={() => navigate('/records')}
            className="btn btn-ghost"
          >
            취소
          </button>
        </div>
      </form>
    </div>
  );
};

export default NewRecordPage; 