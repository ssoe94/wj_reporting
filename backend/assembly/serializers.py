from rest_framework import serializers
from .models import AssemblyReport, AssemblyPartSpec, AssemblyProduct
import pandas as pd
from datetime import datetime
from django.utils.dateparse import parse_date


class AssemblyReportSerializer(serializers.ModelSerializer):
    # 계산된 필드들을 읽기 전용으로 포함
    incoming_defect_qty = serializers.ReadOnlyField()
    total_defect_qty = serializers.ReadOnlyField()
    achievement_rate = serializers.ReadOnlyField()
    defect_rate = serializers.ReadOnlyField()
    total_production_qty = serializers.ReadOnlyField()
    uptime_rate = serializers.ReadOnlyField()
    uph = serializers.ReadOnlyField()
    upph = serializers.ReadOnlyField()
    actual_operation_time = serializers.ReadOnlyField()

    class Meta:
        model = AssemblyReport
        fields = [
            'id', 'date', 'line_no', 'part_no', 'model', 'supply_type',
            'plan_qty', 'input_qty', 'actual_qty', 'rework_qty',
            'injection_defect', 'outsourcing_defect', 'processing_defect',
            'incoming_defects_detail', 'processing_defects_detail',
            'operation_time', 'total_time', 'idle_time', 'workers',
            'note',
            'created_at', 'updated_at',
            # 계산된 필드들
            'incoming_defect_qty', 'total_defect_qty', 'achievement_rate', 'defect_rate', 
            'total_production_qty', 'uptime_rate', 'uph', 'upph', 'actual_operation_time'
        ]


class AssemblyPartSpecSerializer(serializers.ModelSerializer):
    class Meta:
        model = AssemblyPartSpec
        fields = [
            'id', 'part_no', 'model_code', 'description',
            'process_type', 'material_type',
            'standard_cycle_time', 'standard_worker_count',
            'valid_from', 'created_at'
        ]


class AssemblyProductSerializer(serializers.ModelSerializer):
    class Meta:
        model = AssemblyProduct
        fields = [
            'id', 'model', 'part_no', 'process_line'
        ]


class CSVValidationResultSerializer(serializers.Serializer):
    """CSV 업로드 검증 결과"""
    valid_data = serializers.ListField(child=serializers.DictField())
    auto_corrected = serializers.ListField(child=serializers.DictField())
    new_parts = serializers.ListField(child=serializers.DictField())
    errors = serializers.ListField(child=serializers.DictField())
    total_rows = serializers.IntegerField()


class CSVUploadSerializer(serializers.Serializer):
    """CSV 파일 업로드"""
    csv_file = serializers.FileField()
    
    def validate_csv_file(self, value):
        if not value.name.lower().endswith('.csv'):
            raise serializers.ValidationError("CSV 파일만 업로드 가능합니다.")
        return value
    
    def validate_and_preview_csv(self):
        """CSV 데이터 검증 및 미리보기 생성"""
        csv_file = self.validated_data['csv_file']
        
        try:
            # CSV 읽기
            df = pd.read_csv(csv_file)
        except Exception as e:
            raise serializers.ValidationError(f"CSV 파일 읽기 실패: {str(e)}")
        
        # 필수 컬럼 확인
        required_columns = ['date', 'part_no', 'model', 'plan_qty', 'actual_qty']
        missing_columns = [col for col in required_columns if col not in df.columns]
        if missing_columns:
            raise serializers.ValidationError(f"필수 컬럼이 누락되었습니다: {', '.join(missing_columns)}")
        
        # 기존 Part 스펙 매핑 정보 가져오기
        existing_parts = AssemblyPartSpec.objects.values('part_no', 'model_code')
        part_mapping = {p['part_no']: p['model_code'] for p in existing_parts}
        
        valid_data = []
        auto_corrected = []
        new_parts = []
        errors = []
        
        for index, row in df.iterrows():
            row_data = row.to_dict()
            row_number = index + 2  # Excel 행 번호 (헤더 포함)
            
            try:
                # 데이터 검증 및 변환
                validated_row = self._validate_row(row_data, row_number)
                
                part_no = validated_row['part_no']
                csv_model = validated_row['model']
                
                if part_no in part_mapping:
                    db_model = part_mapping[part_no]
                    if csv_model != db_model:
                        # 자동 보정
                        validated_row['model'] = db_model
                        validated_row['original_model'] = csv_model
                        validated_row['status'] = 'auto_corrected'
                        auto_corrected.append({
                            'row_number': row_number,
                            'data': validated_row,
                            'message': f"모델명이 '{csv_model}'에서 '{db_model}'로 자동 보정되었습니다."
                        })
                    else:
                        validated_row['status'] = 'valid'
                        valid_data.append({
                            'row_number': row_number,
                            'data': validated_row
                        })
                else:
                    # 신규 Part No.
                    validated_row['status'] = 'new_part'
                    new_parts.append({
                        'row_number': row_number,
                        'data': validated_row,
                        'message': f"신규 Part No. '{part_no}' - 추가 정보 입력이 필요합니다."
                    })
                    
            except serializers.ValidationError as e:
                errors.append({
                    'row_number': row_number,
                    'data': row_data,
                    'errors': e.detail if hasattr(e, 'detail') else str(e)
                })
        
        return {
            'valid_data': valid_data,
            'auto_corrected': auto_corrected,
            'new_parts': new_parts,
            'errors': errors,
            'total_rows': len(df)
        }
    
    def _validate_row(self, row_data, row_number):
        """개별 행 데이터 검증"""
        validated = {}
        
        # 필수 필드 검증
        required_fields = {
            'date': '생산일자',
            'part_no': 'Part No.',
            'model': '모델명',
            'plan_qty': '계획수량',
            'actual_qty': '실제수량'
        }
        
        for field, label in required_fields.items():
            if field not in row_data or pd.isna(row_data[field]):
                raise serializers.ValidationError(f"{label}는 필수입니다.")
            validated[field] = row_data[field]
        
        # 날짜 검증
        try:
            if isinstance(validated['date'], str):
                date_obj = parse_date(validated['date'])
                if not date_obj:
                    raise ValueError("Invalid date format")
                validated['date'] = date_obj.strftime('%Y-%m-%d')
        except (ValueError, TypeError):
            raise serializers.ValidationError("날짜 형식이 올바르지 않습니다. (YYYY-MM-DD)")
        
        # 숫자 필드 검증
        numeric_fields = ['plan_qty', 'actual_qty', 'injection_defect', 'outsourcing_defect', 'processing_defect']
        for field in numeric_fields:
            if field in row_data and not pd.isna(row_data[field]):
                try:
                    validated[field] = int(float(row_data[field]))
                    if validated[field] < 0:
                        raise ValueError("음수는 허용되지 않습니다.")
                except (ValueError, TypeError):
                    raise serializers.ValidationError(f"{field}는 0 이상의 정수여야 합니다.")
            elif field in ['plan_qty', 'actual_qty']:
                # 필수 필드는 이미 위에서 확인했으므로 여기서는 기본값 설정하지 않음
                pass
            else:
                validated[field] = 0  # 선택 필드는 기본값 0
        
        # 선택 필드들
        optional_fields = ['line_no', 'input_qty', 'operation_time', 'total_time', 'idle_time', 'workers', 'note']
        for field in optional_fields:
            if field in row_data and not pd.isna(row_data[field]):
                if field in ['input_qty', 'operation_time', 'total_time', 'idle_time', 'workers']:
                    try:
                        validated[field] = int(float(row_data[field]))
                    except (ValueError, TypeError):
                        validated[field] = 0 if field != 'workers' else 1
                else:
                    validated[field] = str(row_data[field])
            else:
                if field == 'workers':
                    validated[field] = 1
                elif field == 'total_time':
                    validated[field] = 1440  # 24시간
                elif field in ['input_qty', 'operation_time', 'idle_time']:
                    validated[field] = 0
                else:
                    validated[field] = ''
        
        return validated


class NewPartInfoSerializer(serializers.Serializer):
    """신규 Part 정보 입력"""
    part_no = serializers.CharField(max_length=100)
    model_code = serializers.CharField(max_length=100)
    description = serializers.CharField(max_length=200, required=False, allow_blank=True)
    process_type = serializers.CharField(max_length=50, required=False, allow_blank=True)
    material_type = serializers.CharField(max_length=50, required=False, allow_blank=True)
    standard_cycle_time = serializers.IntegerField(required=False, allow_null=True)
    standard_worker_count = serializers.IntegerField(required=False, allow_null=True, default=1)
    
    def validate_part_no(self, value):
        # 이미 존재하는 Part No. 확인
        if AssemblyPartSpec.objects.filter(part_no=value).exists():
            raise serializers.ValidationError("이미 존재하는 Part No.입니다.")
        return value