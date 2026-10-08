"""Real PostgreSQL row-lock checks; skipped on SQLite rather than simulated."""
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from decimal import Decimal
from threading import Barrier
from unittest import skipUnless
from django.contrib.auth import get_user_model
from django.db import connection, connections, transaction
from django.test import TransactionTestCase, override_settings
from .models import ProductionPlan, PlanWorkflowLock, PlanMesRequest, PlanWorkOrder, PlanMaterialApproval
from .plan_workflow import lock_type, prepare, preview, approve_materials, replace_uploaded_plans, WorkflowConflict
from .test_plan_workflow import seed_catalog, new_plan, approval_data, reviewed


@skipUnless(connection.vendor == 'postgresql', 'Requires disposable PostgreSQL fixture')
class PlanWorkflowConcurrencyTests(TransactionTestCase):
    def setUp(self):
        for plan_type in ('injection','machining'): PlanWorkflowLock.objects.get_or_create(plan_type=plan_type)
        self.user = get_user_model().objects.create_user(username='synthetic-concurrency',is_staff=True)
        seed_catalog()
        self.plan = new_plan(actor=self.user)
        with transaction.atomic():
            lock_type('injection')
            approve_materials(self.plan,approval_data(self.plan),self.user)

    def run_pair(self, functions):
        barrier = Barrier(2)
        def call(fn):
            connections.close_all()
            try:
                barrier.wait(timeout=5)
                return fn()
            finally:
                connections.close_all()
        with ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(call,fn) for fn in functions]
            return [future.result(timeout=15) for future in futures]

    def test_concurrent_prepare_uses_one_request_and_order(self):
        key=preview(date(2026,10,8),date(2026,10,8),'injection')[0]['key']
        def send():
            user=get_user_model().objects.get(pk=self.user.pk)
            return prepare(date(2026,10,8),date(2026,10,8),'injection',[key],user)
        with override_settings(MES_PLAN_REVIEWED_CONTRACT=reviewed(preview(date(2026,10,8),date(2026,10,8),'injection'))):
            results=self.run_pair([send,send])
        self.assertEqual(PlanMesRequest.objects.count(),1)
        self.assertEqual(PlanWorkOrder.objects.count(),1)
        self.assertEqual({r[0]['state'] for r in results},{'disabled','unchanged'})

    def test_concurrent_reupload_and_approval_never_approve_new_quantity_with_old_version(self):
        data=approval_data(self.plan)
        def upload():
            with transaction.atomic():
                user=get_user_model().objects.get(pk=self.user.pk)
                row=ProductionPlan(plan_date=date(2026,10,8),plan_type='injection',machine_name='imm01',
                    part_no='SYNTHETIC-PART',planned_quantity=2000,sequence=1)
                replace_uploaded_plans([row],[date(2026,10,8)],'injection',user)
            return 'upload'
        def approve():
            with transaction.atomic():
                lock_type('injection')
                row=ProductionPlan.objects.get()
                try:
                    approve_materials(row,data,get_user_model().objects.get(pk=self.user.pk))
                    return 'old_approval'
                except WorkflowConflict:
                    return 'conflict'
        self.run_pair([upload,approve])
        row=ProductionPlan.objects.get()
        self.assertEqual(row.work_version,2)
        self.assertFalse(PlanMaterialApproval.objects.filter(revision__work_id=row.work_uid,revision__version=2).exists())

    def test_two_dispatchers_produce_one_import_and_preserve_replay_fence(self):
        import time
        from quality.inspection_transport import InspectionUserAccessToken
        from .test_plan_workflow_transport import bodies, response, WORK_ID
        from .plan_workflow_transport import PlanMesTransport, dispatch_prepared_create, READ_ROUTES, CREATE_PATH, ROUTE_BASE
        groups=preview(date(2026,10,8),date(2026,10,8),'injection')
        calls=[]
        with override_settings(MES_PLAN_REVIEWED_CONTRACT=reviewed(groups)):
            prepared=prepare(date(2026,10,8),date(2026,10,8),'injection',[groups[0]['key']],self.user)[0]
            req=PlanMesRequest.objects.get(uid=prepared['uid']);values=bodies(req)
            def sender(url,**kwargs):
                path=url.split(ROUTE_BASE)[1];calls.append(path)
                if path==CREATE_PATH:return response({'code':200,'needCheck':0,'data':{'id':int(WORK_ID)}})
                key=next(key for key,value in READ_ROUTES.items() if value==path)
                return response(values[key])
            def dispatch():
                transport=PlanMesTransport(origin='https://v3-ali.blacklake.cn',tenant='SYNTHETIC-TENANT',
                    actor_id=self.user.pk,mes_user_id=17000000000000009,sender=sender,
                    credential=InspectionUserAccessToken('SYNTHETIC-ONLY',time.time()+60,user_id=17000000000000009))
                try:return dispatch_prepared_create(req.uid,transport,fixture=True)['state']
                except WorkflowConflict:return 'conflict'
            results=self.run_pair([dispatch,dispatch])
        self.assertEqual(set(results),{'confirmed','conflict'})
        self.assertEqual(calls.count(CREATE_PATH),1)
        req.refresh_from_db();self.assertEqual(req.attempt,1)


class PlanWorkflowMigrationTests(TransactionTestCase):
    def test_additive_migration_preserves_existing_plan_and_change_log(self):
        from django.db.migrations.executor import MigrationExecutor
        executor = MigrationExecutor(connection)
        executor.migrate([('production', '0015_mestaskactionlog')])
        old_apps = executor.loader.project_state([('production', '0015_mestaskactionlog')]).apps
        Plan = old_apps.get_model('production', 'ProductionPlan')
        Log = old_apps.get_model('production', 'ProductionPlanChangeLog')
        row = Plan.objects.create(plan_date=date(2026,10,8),plan_type='injection',machine_name='imm01',
                                  part_no='SYNTHETIC-LEGACY',planned_quantity=1234,sequence=1)
        log = Log.objects.create(plan_date=date(2026,10,8),plan_type='injection',action='upload',summary='legacy retained')
        try:
            executor = MigrationExecutor(connection)
            executor.migrate([('production', '0016_plan_material_workflow')])
            plan = ProductionPlan.objects.get(pk=row.pk)
            self.assertEqual(plan.planned_quantity,1234)
            self.assertIsNotNone(plan.work_uid)
            from .models import PlanWorkRevision, ProductionPlanChangeLog
            revision=PlanWorkRevision.objects.get(work_id=plan.work_uid,version=1)
            self.assertEqual(Decimal(revision.snapshot['planned_quantity']),Decimal('1234'))
            self.assertEqual(ProductionPlanChangeLog.objects.get(pk=log.pk).summary,'legacy retained')
        finally:
            MigrationExecutor(connection).migrate([('production','0016_plan_material_workflow')])
