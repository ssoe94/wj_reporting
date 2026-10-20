import datetime as dt
from unittest.mock import patch
from django.contrib.auth import get_user_model
from django.core.cache import cache
from django.test import TestCase
from rest_framework.test import APIClient
from . import service
from .models import LgentCart
from .shipments import overview

ORDER={'id':11,'code':'20261020LGENT-JIT','bizType':1,'bizStatus':30,'planAt':'2026-10-20T12:00:00+08:00'}
RECORD={'id':21,'outboundOrderCode':ORDER['code'],'bizType':{'code':1},'executeType':{'code':3},'createTime':'2026-10-19T13:45:34+08:00','qrCode':'TT0940367'}
PARAMS={'start':'2026-10-20','end':'2026-10-22','mode':'plan'}
class ShipmentTests(TestCase):
 def setUp(self):
  cache.clear()
  self.user=get_user_model().objects.create_user('shipper',is_staff=True)
  self.api=APIClient();self.api.force_authenticate(self.user)
  self.cart=service.remember({'trolley_id':'TT0940367','supplier_id':'TT094','com_code':'LGENT','org_code':'ENT','last_grade':'B','pic_url':'/files/20250812120000.jpg'})
 def response(self,rows,total=None):return {'code':200,'data':{'list':rows,'total':len(rows) if total is None else total}}
 @patch('lgent.shipments._mes')
 def test_plan_joins_exact_record_number_and_preserves_planned_and_record_dates(self,mes):
  mes.side_effect=[self.response([ORDER]),self.response([RECORD])]
  result=self.api.get('/api/lgent/shipments/',PARAMS)
  self.assertEqual(result.status_code,200)
  row=result.data['rows'][0]
  self.assertEqual(row['trolleyId'],'TT0940367');self.assertEqual(row['status'],'in_execution')
  self.assertTrue(row['plannedAt'].startswith('2026-10-20'));self.assertTrue(row['recordedAt'].startswith('2026-10-19'))
  self.assertEqual(row['cart']['trolleyId'],self.cart.trolley_id)
  self.assertEqual(mes.call_args.kwargs['records'],True)
  self.assertEqual(mes.call_args.args[0]['outboundOrderCodes'],[ORDER['code']])
  before=self.cart.updated_at
  overview(self.user,PARAMS)
  self.assertEqual(mes.call_count,2);self.cart.refresh_from_db();self.assertEqual(self.cart.updated_at,before)
 @patch('lgent.shipments._mes')
 def test_unassigned_plan_stays_unassigned_and_never_uses_order_id_as_cart(self,mes):
  mes.side_effect=[self.response([ORDER]),self.response([])]
  row=overview(self.user,PARAMS)['rows'][0]
  self.assertEqual(row['trolleyId'],'');self.assertIsNone(row['cart']);self.assertEqual(row['recordCount'],0)
 @patch('lgent.shipments._mes')
 def test_tt_prefix_is_not_ownership_and_reversal_is_not_completion(self,mes):
  mes.side_effect=[self.response([ORDER]),self.response([{**RECORD,'qrCode':'TT0949999','executeType':{'code':2}}])]
  row=overview(self.user,PARAMS)['rows'][0]
  self.assertEqual(row['identifier'],'TT0949999');self.assertEqual(row['trolleyId'],'');self.assertIsNone(row['cart']);self.assertEqual(row['status'],'reversed')
 @patch('lgent.shipments._mes')
 def test_history_uses_calendar_record_date_and_preserves_distinct_shipments(self,mes):
  params={**PARAMS,'mode':'history','start':'2026-10-19'}
  mes.return_value=self.response([RECORD,{**RECORD,'id':22,'outboundOrderCode':'20261020LGENT-CSKD'},{**RECORD,'id':23,'outboundOrderCode':'OTHER-JIT'}])
  result=overview(self.user,params)
  self.assertEqual(len(result['rows']),2);self.assertTrue(all(r['status']=='recorded' for r in result['rows']))
  request=mes.call_args.args[0]
  self.assertEqual(request['createdAtFrom'],int(dt.datetime.fromisoformat('2026-10-19T00:00:00+08:00').timestamp()*1000))
  self.assertTrue(all(not r['plannedAt'] for r in result['rows']))
 @patch('lgent.shipments._mes')
 def test_empty_plan_does_not_scan_records_and_failure_is_not_zero(self,mes):
  mes.return_value=self.response([])
  self.assertEqual(overview(self.user,PARAMS)['rows'],[]);self.assertEqual(mes.call_count,1)
  cache.clear();mes.side_effect=RuntimeError('private access_token=hidden')
  reply=self.api.get('/api/lgent/shipments/',PARAMS)
  self.assertEqual(reply.status_code,502);self.assertNotIn('hidden',str(reply.data))
 @patch('lgent.shipments._mes')
 def test_incomplete_pagination_is_rejected_and_never_cached(self,mes):
  mes.return_value=self.response([ORDER],total=2)
  self.assertEqual(self.api.get('/api/lgent/shipments/',PARAMS).status_code,502)
  mes.return_value=self.response([])
  self.assertEqual(overview(self.user,PARAMS)['rows'],[]);self.assertEqual(mes.call_count,2)
 @patch('lgent.shipments._mes')
 def test_invalid_range_and_unauthorized_get_and_all_writes_are_denied(self,mes):
  for params in ({**PARAMS,'start':'2026-02-30'},{**PARAMS,'end':'2026-12-01'},{**PARAMS,'end':'2026-10-01'},{**PARAMS,'mode':'save'}):
   self.assertEqual(self.api.get('/api/lgent/shipments/',params).status_code,400)
  self.assertEqual(self.api.post('/api/lgent/shipments/',PARAMS).status_code,405)
  denied=get_user_model().objects.create_user('no-sales')
  from injection.models import UserProfile
  permissions,_=UserProfile.objects.get_or_create(user=denied);permissions.can_view_sales=False;permissions.can_edit_sales=False;permissions.save()
  denied.refresh_from_db();self.api.force_authenticate(denied)
  self.assertEqual(self.api.get('/api/lgent/shipments/',PARAMS).status_code,403)
  self.api.force_authenticate(None)
  self.assertIn(self.api.get('/api/lgent/shipments/',PARAMS).status_code,(401,403));mes.assert_not_called()
 @patch('lgent.shipments._mes')
 def test_foreign_scope_and_non_sales_and_feed_records_not_counted(self,mes):
  mes.side_effect=[self.response([ORDER,{**ORDER,'id':12,'code':'OTHER-JIT'}]),self.response([RECORD,{**RECORD,'id':22,'bizType':4},{**RECORD,'id':23,'executeType':1}])]
  result=overview(self.user,PARAMS)
  self.assertEqual(len(result['rows']),1);self.assertEqual(result['rows'][0]['recordCount'],1)
 @patch('inventory.services.outbound_performance.requests.post')
 @patch('inventory.services.outbound_performance.get_access_token',return_value='fixture-token')
 def test_transport_uses_only_the_two_documented_read_routes(self,token,post):
  from inventory.services.outbound_performance import _post_mes
  post.return_value.json.return_value=self.response([])
  _post_mes({'page':1},records=True,timeout=6)
  self.assertIn('/inventory/open/v1/outbound_order/_list_outbound_record?',post.call_args.args[0])
  self.assertEqual(post.call_args.kwargs['timeout'],(5,6))
  _post_mes({'page':1})
  self.assertIn('/inventory/open/v1/outbound_order/_list?',post.call_args.args[0])
  self.assertEqual(post.call_args.kwargs['timeout'],(5,15))
 @patch('lgent.shipments._mes',side_effect=RuntimeError('permission denied access_token=private'))
 def test_mes_permission_gap_is_explicit_without_exposing_request_or_secrets(self,mes):
  response=self.api.get('/api/lgent/shipments/',PARAMS)
  self.assertEqual(response.status_code,403);self.assertEqual(response.data['code'],'mes_permission_denied')
  self.assertNotIn('private',str(response.data))
