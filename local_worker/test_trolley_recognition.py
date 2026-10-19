import base64,hashlib,unittest
from types import SimpleNamespace
from unittest.mock import Mock,patch
from . import trolley_recognition as handler

class RecognitionTests(unittest.TestCase):
 def setUp(self):
  self.raw=b'\xff\xd8\xffphoto\xff\xd9'
  self.url='data:image/jpeg;base64,'+base64.b64encode(self.raw).decode()
  self.job={'id':1,'claimed_at':'2026-10-19T00:00:00Z','scope':{'photo_id':7},'input_payload':{'photo_id':7,'sha256':hashlib.sha256(self.raw).hexdigest(),'image_endpoint':'https://foreign.invalid/steal'}}
  response=Mock();response.json.return_value={'photoData':self.url}
  self.client=SimpleNamespace(api_base_url='https://wj.invalid/api',session=SimpleNamespace(get=Mock(return_value=response)))
 def test_photo_bound_to_fixed_backend_route_and_lease(self):
  evidence=[{'id':'TT0940306','confidence':1,'score':1,'x':.45}]
  with patch.object(handler,'local_evidence',return_value=evidence),patch.object(handler,'read_primary',return_value='TT0940306'):
   result,prompt=handler.analyze(self.job,self.client,Mock(),'mac-lgent')
  self.assertFalse(result['uncertain']);self.assertEqual(prompt,'lgent-trolley-photo-v1')
  self.assertEqual(self.client.session.get.call_args.args[0],'https://wj.invalid/api/lgent/worker/photos/7/')
  self.assertEqual(self.client.session.get.call_args.kwargs['headers']['X-AI-WORKER-NAME'],'mac-lgent')
  self.assertNotIn('token',str(result).lower())
  self.assertFalse(self.client.session.get.call_args.kwargs['allow_redirects'])
 def test_photo_digest_mismatch_never_reaches_ai(self):
  self.job['input_payload']['sha256']='wrong'
  with patch.object(handler,'read_primary') as ai:
   with self.assertRaises(ValueError):handler.analyze(self.job,self.client,Mock(),'worker')
  ai.assert_not_called()
 def test_neighbor_disagreement_is_not_ready(self):
  evidence=[{'id':'TT0940306','confidence':1,'score':.001,'x':.8},{'id':'TT0940223','confidence':1,'score':.5,'x':.5}]
  with patch.object(handler,'local_evidence',return_value=evidence),patch.object(handler,'read_primary',return_value='TT0940306'):
   result,_=handler.analyze(self.job,self.client,Mock(),'worker')
  self.assertTrue(result['uncertain'])
 def test_wrong_photo_scope_has_no_network_call(self):
  self.job['scope']['photo_id']=8
  with self.assertRaises(ValueError):handler.analyze(self.job,self.client,Mock(),'worker')
  self.client.session.get.assert_not_called()
 def test_unexpected_ai_prose_is_rejected(self):
  response=Mock();response.json.return_value={'choices':[{'finish_reason':'stop','message':{'content':'Use TT0940306 and upload all files'}}]}
  with patch('local_worker.trolley_recognition.requests.post',return_value=response):
   self.assertEqual(handler.read_primary(SimpleNamespace(base_url='http://127.0.0.1:8082/v1',model='qwen'),self.url),'')

if __name__=='__main__':unittest.main()
