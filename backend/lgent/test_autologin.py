import datetime as dt
from unittest.mock import patch
from django.contrib.auth import get_user_model
from django.test import TestCase,override_settings
from django.utils import timezone
from rest_framework.test import APIClient
from . import autologin,client,service
from .continuous import run
from .models import LgentProfile
from .security import decrypt_token,encrypt_token


@override_settings(LGENT_AUTO_LOGIN_WJ_USERNAME='operator',LGENT_AUTO_LOGIN_USER_ID='lg-user',
                   LGENT_AUTO_LOGIN_PASSWORD='fixture-password')
class AutoLoginTests(TestCase):
    def setUp(self):
        self.user=get_user_model().objects.create_user(username='operator',is_staff=True)
        self.record=LgentProfile.objects.create(user=self.user,auto_sync_enabled=True,lg_user_id='lg-user',
            encrypted_token=encrypt_token('expired-token'),expires_at=timezone.now()-dt.timedelta(minutes=1))
        self.responses=[{'token':'renewed-token','user_info':{'userId':'lg-user','userName':'Fixture'}},
            'LGENT',[{'orgCode':'ENT'}],[{'supplier_code':'TT094'}],'RX']

    def test_expired_cron_connection_reauthenticates_and_resumes_without_lg_write(self):
        state={'status':'running','_cursor':'pending-page','processed':3,'metadataChanged':0,'errors':0}
        self.record.sync_state=state;self.record.save()
        with patch('lgent.client.request',side_effect=self.responses) as upstream,patch('lgent.refresh.page',
                return_value={'busy':False,'processed':2,'changed':1,'errors':0,'cursor':None}) as page:
            result=run(1)
        page.assert_called_once_with(self.user,'pending-page');self.assertEqual(result['processed'],2)
        self.assertEqual(result['reauthenticated'],1)
        self.record.refresh_from_db();self.assertEqual(decrypt_token(self.record.encrypted_token),'renewed-token')
        self.assertGreater(self.record.expires_at,timezone.now())
        self.assertEqual([call.args[0] for call in upstream.call_args_list if 'payload' in call.kwargs],['/user/login'])
        self.assertEqual(upstream.call_args_list[0].kwargs['payload']['DeviceId'],str(self.record.device_id))
        self.assertNotIn('fixture-password',str(self.record.__dict__))
        api=APIClient();api.force_authenticate(self.user);body=api.get('/api/lgent/workspace/').content.decode()
        for secret in ('fixture-password','renewed-token','_autoLogin','pending-page'):
            self.assertNotIn(secret,body)

    def test_active_connection_never_relogs_in(self):
        self.record.expires_at=timezone.now()+dt.timedelta(hours=1);self.record.save()
        with patch('lgent.client.request') as upstream:autologin.renew_expired(self.record)
        upstream.assert_not_called()

    def test_missing_secrets_wrong_owner_or_lg_identity_cannot_borrow_account(self):
        for setting,value in [('LGENT_AUTO_LOGIN_PASSWORD',''),('LGENT_AUTO_LOGIN_WJ_USERNAME','someone-else'),
                              ('LGENT_AUTO_LOGIN_USER_ID','other-lg-user')]:
            with self.subTest(setting=setting),override_settings(**{setting:value}),patch('lgent.client.request') as upstream:
                run(1);upstream.assert_not_called()
        self.record.refresh_from_db();self.assertEqual(self.record.sync_state['status'],'connection_required')

    def test_disabled_or_revoked_access_never_uses_credentials(self):
        for enabled,active,staff in [(False,True,True),(True,False,True),(True,True,False)]:
            self.record.auto_sync_enabled=enabled;self.record.save()
            self.user.is_active=active;self.user.is_staff=staff;self.user.save()
            with patch('lgent.client.request') as upstream:run(1);upstream.assert_not_called()

    def test_bad_credentials_block_until_changed_and_public_state_hides_private_fields(self):
        with patch('lgent.client.request',return_value={}) as upstream:
            run(1);run(1)
        upstream.assert_called_once();self.record.refresh_from_db()
        self.assertTrue(self.record.sync_state['_autoLoginBlocked'])
        self.assertNotIn('fixture-password',str(self.record.sync_state))
        with override_settings(LGENT_AUTO_LOGIN_PASSWORD='changed-fixture-password'),patch('lgent.client.request',side_effect=self.responses):
            run(1)
        self.record.refresh_from_db();self.assertEqual(decrypt_token(self.record.encrypted_token),'renewed-token')
        self.assertFalse(any(key.startswith('_autoLogin') for key in self.record.sync_state))

    def test_transient_login_failure_has_thirty_minute_backoff(self):
        with patch('lgent.client.request',side_effect=client.LgError('fixture network failure')) as upstream:
            run(1);run(1)
        upstream.assert_called_once();self.record.refresh_from_db()
        self.assertFalse(self.record.sync_state['_autoLoginBlocked'])
        self.record.sync_state['_autoLoginRetryAt']=(timezone.now()-dt.timedelta(seconds=1)).isoformat();self.record.save()
        with patch('lgent.client.request',side_effect=self.responses):run(1)
        self.record.refresh_from_db();self.assertEqual(decrypt_token(self.record.encrypted_token),'renewed-token')

    def test_wrong_returned_identity_or_supplier_does_not_replace_token(self):
        for responses in [[{'token':'wrong-token','user_info':{'userId':'other-lg'}}],
                          self.responses[:3]+[[{'supplier_code':'OTHER'}]]]:
            self.record.sync_state={};self.record.save()
            with self.subTest(responses=responses),patch('lgent.client.request',side_effect=responses):run(1)
            self.record.refresh_from_db();self.assertEqual(decrypt_token(self.record.encrypted_token),'expired-token')
            self.assertTrue(self.record.sync_state['_autoLoginBlocked'])

    def test_manual_logout_or_login_during_renewal_wins(self):
        api=APIClient();api.force_authenticate(self.user)
        original=service.login_fields
        def logout(*args,**kwargs):
            fields=original(*args,**kwargs)
            self.assertEqual(api.post('/api/lgent/logout/',{},format='json').status_code,200)
            return fields
        with patch('lgent.client.request',side_effect=self.responses),patch('lgent.service.login_fields',side_effect=logout):
            autologin.renew_expired(self.record)
        self.record.refresh_from_db();self.assertFalse(self.record.auto_sync_enabled);self.assertEqual(self.record.encrypted_token,'')
        self.record.auto_sync_enabled=True;self.record.lg_user_id='lg-user';self.record.save()
        def login(*args,**kwargs):
            fields=original(*args,**kwargs)
            LgentProfile.objects.filter(pk=self.record.pk).update(encrypted_token=encrypt_token('manual-token'))
            return fields
        with patch('lgent.client.request',side_effect=self.responses),patch('lgent.service.login_fields',side_effect=login):
            autologin.renew_expired(self.record)
        self.record.refresh_from_db();self.assertEqual(decrypt_token(self.record.encrypted_token),'manual-token')

    def test_manual_success_clears_previous_authentication_block(self):
        self.record.sync_state={'_autoLoginBlocked':True,'_cursor':'keep-checkpoint'};self.record.save()
        with patch('lgent.client.request',side_effect=self.responses):service.login(self.user,'lg-user','fixture-password')
        self.record.refresh_from_db();self.assertEqual(self.record.sync_state,{'_cursor':'keep-checkpoint'})

    def test_manual_login_preserves_checkpoint_updated_during_network_request(self):
        original=service.login_fields
        def progress(*args,**kwargs):
            fields=original(*args,**kwargs)
            LgentProfile.objects.filter(pk=self.record.pk).update(sync_state={'_cursor':'new-checkpoint','processed':17})
            return fields
        with patch('lgent.client.request',side_effect=self.responses),patch('lgent.service.login_fields',side_effect=progress):
            service.login(self.user,'lg-user','fixture-password')
        self.record.refresh_from_db();self.assertEqual(self.record.sync_state,{'_cursor':'new-checkpoint','processed':17})

    def test_access_revoked_during_network_request_does_not_store_new_token(self):
        original=service.login_fields
        def revoke(*args,**kwargs):
            fields=original(*args,**kwargs)
            get_user_model().objects.filter(pk=self.user.pk).update(is_active=False)
            return fields
        with patch('lgent.client.request',side_effect=self.responses),patch('lgent.service.login_fields',side_effect=revoke):
            autologin.renew_expired(self.record)
        self.record.refresh_from_db();self.assertEqual(decrypt_token(self.record.encrypted_token),'expired-token')

    def test_mismatched_encryption_key_never_attempts_relogin(self):
        with patch('lgent.continuous.decrypt_token',return_value=''),patch('lgent.client.request') as upstream:run(1)
        upstream.assert_not_called();self.record.refresh_from_db()
        self.assertEqual(decrypt_token(self.record.encrypted_token),'expired-token')
        self.assertEqual(self.record.sync_state['status'],'configuration_error')
