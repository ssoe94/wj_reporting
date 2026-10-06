"""Three nullable login provenance/clock fields preserve existing legacy data."""
from datetime import timedelta
from importlib import import_module

from django.db import connection, migrations
from django.db.migrations.executor import MigrationExecutor
from django.test import TransactionTestCase
from django.utils import timezone


class SessionActivityMigrationTests(TransactionTestCase):
    def test_additive_clock_upgrade_preserves_legacy_login_and_ciphertext(self):
        executor = MigrationExecutor(connection)
        latest = executor.loader.graph.leaf_nodes()
        before = [node for node in latest if node[0] != 'mes_oauth'] + [
            ('mes_oauth', '0002_mescredential_mescredentialevent_mesloginsession_and_more')]
        executor.migrate(before)
        try:
            old = executor.loader.project_state(before).apps
            now = timezone.now()
            old.get_model('mes_oauth', 'MESLoginSession').objects.create(
                digest='a' * 64, actor_id=18, authorization_digest='b' * 64,
                expires_at=now + timedelta(days=7))
            old.get_model('mes_oauth', 'MESCredential').objects.create(actor_id=18,
                mes_user_id='1733276056994641', app_id='10000000000000005',
                tenant_reference='SYNTHETIC', login_digest='a' * 64,
                authorization_digest='b' * 64, policy_reference='SYNTHETIC',
                key_id='synthetic-key', ciphertext=b'SYNTHETIC-PRESERVED-CIPHERTEXT',
                verified_at=now, last_used_at=now, expires_at=now + timedelta(days=1),
                provider_expires_at=now + timedelta(seconds=86400),
                idle_expires_at=now + timedelta(hours=1), consent_expires_at=now + timedelta(days=1))
            prior_login = old.get_model('mes_oauth', 'MESLoginSession').objects.values().get()
            prior_credential = old.get_model('mes_oauth', 'MESCredential').objects.values().get()
            MigrationExecutor(connection).migrate(latest)
            new = MigrationExecutor(connection).loader.project_state(latest).apps
            upgraded = new.get_model('mes_oauth', 'MESLoginSession').objects.values().get()
            self.assertIsNone(upgraded.pop('session_version'))
            self.assertIsNone(upgraded.pop('last_activity_at'))
            self.assertIsNone(upgraded.pop('idle_expires_at'))
            self.assertEqual(upgraded, prior_login)
            self.assertEqual(new.get_model('mes_oauth', 'MESCredential').objects.values().get(), prior_credential)
            operations = import_module('mes_oauth.migrations.0003_mesloginsession_activity').Migration.operations
            self.assertEqual(len(operations), 3)
            self.assertEqual({operation.name for operation in operations}, {'session_version', 'last_activity_at', 'idle_expires_at'})
            for operation in operations:
                self.assertIsInstance(operation, migrations.AddField)
                self.assertEqual(operation.model_name, 'mesloginsession')
                self.assertTrue(operation.field.null)
                self.assertFalse(operation.field.has_default())
        finally:
            MigrationExecutor(connection).migrate(latest)
