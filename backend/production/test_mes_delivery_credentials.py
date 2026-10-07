"""WJ cannot activate its historical production writer, even with valid inputs."""
from unittest.mock import Mock, patch
from django.test import SimpleTestCase
from rest_framework.exceptions import PermissionDenied
from .mes_delivery_credentials import ScopedProductionWriter


class ProductionWriterDisabledTests(SimpleTestCase):
    def test_construction_refuses_before_authority_identity_or_network(self):
        authority, identity, sender = Mock(), Mock(), Mock()
        with patch('mes_oauth.inspection_credentials.call_with_user_credential') as broker:
            with self.assertRaises(PermissionDenied):
                ScopedProductionWriter(Mock(), session=Mock(), authority_reader=authority,
                    identity_provider=identity, origin='https://v3-ali.blacklake.cn', sender=sender)
        broker.assert_not_called()
        authority.assert_not_called()
        identity.assert_not_called()
        sender.assert_not_called()

    def test_bypassing_constructor_still_cannot_dispatch_any_production_action(self):
        writer = object.__new__(ScopedProductionWriter)
        with patch('socket.socket.connect', side_effect=AssertionError('No network')):
            for action in ('work_order_create', 'dispatch', 'task_start', 'progress_report', 'manual_inbound'):
                with self.subTest(action=action), self.assertRaises(PermissionDenied):
                    writer(action, {}, Mock())
        self.assertFalse(writer.dispatched)
        self.assertEqual(writer.status_flag, 'disabled_read_only')
        self.assertFalse(writer.consume_readback_allowance())
