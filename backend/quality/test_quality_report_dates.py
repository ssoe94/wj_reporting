from datetime import date, datetime
from unittest import mock
from zoneinfo import ZoneInfo

from django.test import SimpleTestCase
from openpyxl import Workbook

from .excel_import import _parse_date, _parse_issue_sheet
from .serializers import QualityImportRowSerializer, QualityReportSerializer


SHANGHAI = ZoneInfo('Asia/Shanghai')


def _issue_sheet(report_date, *, number_format='General'):
    workbook = Workbook()
    worksheet = workbook.active
    worksheet.title = '8月'
    worksheet.append([None, '万佳品质问题点Issue'])
    worksheet.append([
        None, '序号', '发生日期', '发生场所', 'Mold', 'P/N', 'Item',
        '不良现象', '不良数量', '不良照片', '备注',
    ])
    worksheet.append([
        None, 1, report_date, '注塑', '27G523', 'ACQ30854201', 'B/C',
        '顶部拉白', 'Lot数：8\n不良数：2', None, '刚生产',
    ])
    worksheet['C3'].number_format = number_format
    return worksheet


class QualityReportDateParsingTests(SimpleTestCase):
    def test_monthly_sheet_preserves_two_decimal_displayed_day(self):
        rows = _parse_issue_sheet(
            _issue_sheet(8.1, number_format='0.00_ '),
            uploaded_on=date(2026, 8, 19),
        )

        self.assertEqual(rows[0]['report_date'], date(2026, 8, 10))
        self.assertEqual(rows[0]['raw_data']['发生日期'], '8.10')

    def test_general_one_decimal_date_keeps_its_literal_meaning(self):
        rows = _parse_issue_sheet(
            _issue_sheet(8.1),
            uploaded_on=date(2026, 8, 19),
        )

        self.assertEqual(rows[0]['report_date'], date(2026, 8, 1))
        self.assertEqual(rows[0]['raw_data']['发生日期'], 8.1)

    def test_excel_future_date_is_rejected(self):
        parsed, warnings = _parse_date(
            '2026-08-30',
            uploaded_on=date(2026, 8, 19),
        )

        self.assertIsNone(parsed)
        self.assertEqual(warnings, ['future_report_date:2026-08-30'])

    @mock.patch(
        'quality.serializers.timezone.now',
        return_value=datetime(2026, 8, 19, 12, tzinfo=SHANGHAI),
    )
    def test_manual_report_future_date_is_rejected(self, _now):
        serializer = QualityReportSerializer(data={
            'report_dt': '2026-08-20T08:00:00+08:00',
            'section': 'LQC_INJ',
            'model': '27G523',
            'part_no': 'ACQ30854201',
            'phenomenon': '顶部拉白',
        })

        self.assertFalse(serializer.is_valid())
        self.assertIn('report_dt', serializer.errors)

    @mock.patch(
        'quality.serializers.timezone.now',
        return_value=datetime(2026, 8, 19, 12, tzinfo=SHANGHAI),
    )
    def test_reviewed_import_row_future_date_is_rejected(self, _now):
        serializer = QualityImportRowSerializer(
            data={'report_date': '2026-08-20'},
            partial=True,
        )

        self.assertFalse(serializer.is_valid())
        self.assertIn('report_date', serializer.errors)
