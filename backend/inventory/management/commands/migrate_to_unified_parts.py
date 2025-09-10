"""
안전한 데이터 마이그레이션 커맨드
기존 사출/가공 Part 데이터를 UnifiedPartSpec으로 통합

사용법:
  python manage.py migrate_to_unified_parts --dry-run  # 미리보기 모드
  python manage.py migrate_to_unified_parts            # 실제 마이그레이션
  python manage.py migrate_to_unified_parts --force    # 중복 데이터가 있어도 강제 실행
"""

from django.core.management.base import BaseCommand, CommandError
from django.db import transaction
from django.utils import timezone
from datetime import date
from inventory.models import UnifiedPartSpec
from injection.models import PartSpec as InjectionPartSpec
from assembly.models import AssemblyPartSpec


class Command(BaseCommand):
    help = '기존 사출/가공 Part 데이터를 UnifiedPartSpec으로 안전하게 마이그레이션'

    def add_arguments(self, parser):
        parser.add_argument(
            '--dry-run',
            action='store_true',
            help='실제 실행하지 않고 미리보기만 표시',
        )
        parser.add_argument(
            '--force',
            action='store_true',
            help='중복 데이터가 있어도 강제로 진행',
        )

    def handle(self, *args, **options):
        dry_run = options['dry_run']
        force = options['force']
        
        self.stdout.write(self.style.SUCCESS('=== UnifiedPartSpec Data Migration ==='))
        
        # 현재 상태 확인
        unified_count = UnifiedPartSpec.objects.count()
        injection_count = InjectionPartSpec.objects.count()
        assembly_count = AssemblyPartSpec.objects.count()
        
        self.stdout.write(f"Current Status:")
        self.stdout.write(f"  - UnifiedPartSpec: {unified_count} items")
        self.stdout.write(f"  - InjectionPartSpec: {injection_count} items")
        self.stdout.write(f"  - AssemblyPartSpec: {assembly_count} items")
        
        if unified_count > 0 and not force:
            raise CommandError(
                f"UnifiedPartSpec already has {unified_count} records. "
                "Use --force option to add data while preserving existing records."
            )
        
        if dry_run:
            self.stdout.write(self.style.WARNING("*** DRY-RUN MODE: No actual data will be changed ***"))
        
        # 마이그레이션 실행
        try:
            with transaction.atomic():
                migrated_count = 0
                skipped_count = 0
                
                # 1. Injection data migration
                self.stdout.write("\n1. Migrating Injection PartSpec...")
                for injection_part in InjectionPartSpec.objects.all():
                    unified_data = self._convert_injection_to_unified(injection_part)
                    
                    if dry_run:
                        self.stdout.write(f"  + {unified_data['part_no']} (injection)")
                        migrated_count += 1
                    else:
                        # Check for duplicates (based on part_no)
                        if UnifiedPartSpec.objects.filter(part_no=unified_data['part_no']).exists():
                            self.stdout.write(f"  - {unified_data['part_no']} (already exists, skipped)")
                            skipped_count += 1
                        else:
                            UnifiedPartSpec.objects.create(**unified_data)
                            self.stdout.write(f"  + {unified_data['part_no']} (injection)")
                            migrated_count += 1
                
                # 2. Assembly data migration
                self.stdout.write("\n2. Migrating Assembly PartSpec...")
                for assembly_part in AssemblyPartSpec.objects.all():
                    unified_data = self._convert_assembly_to_unified(assembly_part)
                    
                    if dry_run:
                        self.stdout.write(f"  + {unified_data['part_no']} (assembly)")
                        migrated_count += 1
                    else:
                        # Check for duplicates (based on part_no)
                        if UnifiedPartSpec.objects.filter(part_no=unified_data['part_no']).exists():
                            self.stdout.write(f"  - {unified_data['part_no']} (already exists, skipped)")
                            skipped_count += 1
                        else:
                            UnifiedPartSpec.objects.create(**unified_data)
                            self.stdout.write(f"  + {unified_data['part_no']} (assembly)")
                            migrated_count += 1
                
                if dry_run:
                    # Rollback transaction
                    raise Exception("DRY-RUN COMPLETED")
                    
        except Exception as e:
            if dry_run and "DRY-RUN COMPLETED" in str(e):
                pass  # Normal DRY-RUN completion
            else:
                raise
        
        # Output results
        self.stdout.write(f"\n=== Migration Results ===")
        self.stdout.write(f"Migrated: {migrated_count} items")
        if not dry_run:
            self.stdout.write(f"Skipped (duplicates): {skipped_count} items")
            final_count = UnifiedPartSpec.objects.count()
            self.stdout.write(f"Final UnifiedPartSpec count: {final_count} items")
        
        if dry_run:
            self.stdout.write(self.style.WARNING("To execute actual migration, run without --dry-run option."))
        else:
            self.stdout.write(self.style.SUCCESS("Migration completed successfully!"))

    def _convert_injection_to_unified(self, injection_part):
        """Convert injection PartSpec to UnifiedPartSpec format"""
        return {
            'part_no': injection_part.part_no,
            'model_code': injection_part.model_code,
            'description': injection_part.description or '',
            'valid_from': injection_part.valid_from,
            'source_system': 'injection',
            
            # 사출 특화 필드
            'mold_type': injection_part.mold_type or '',
            'color': injection_part.color or '',
            'resin_type': injection_part.resin_type or '',
            'resin_code': injection_part.resin_code or '',
            'net_weight_g': injection_part.net_weight_g,
            'sr_weight_g': injection_part.sr_weight_g,
            'cycle_time_sec': injection_part.cycle_time_sec,
            'cavity': injection_part.cavity,
            'tonnage': getattr(injection_part, 'tonnage', None),
            'efficiency_rate': getattr(injection_part, 'efficiency_rate', None),
            'resin_loss_pct': getattr(injection_part, 'resin_loss_pct', None),
            'defect_rate_pct': getattr(injection_part, 'defect_rate_pct', None),
        }

    def _convert_assembly_to_unified(self, assembly_part):
        """Convert assembly PartSpec to UnifiedPartSpec format"""
        return {
            'part_no': assembly_part.part_no,
            'model_code': assembly_part.model_code,
            'description': assembly_part.description or '',
            'valid_from': assembly_part.valid_from,
            'source_system': 'assembly',
            
            # 가공 특화 필드
            'process_type': assembly_part.process_type or '',
            'material_type': assembly_part.material_type or '',
            'standard_cycle_time': assembly_part.standard_cycle_time,
            'standard_worker_count': assembly_part.standard_worker_count,
        }